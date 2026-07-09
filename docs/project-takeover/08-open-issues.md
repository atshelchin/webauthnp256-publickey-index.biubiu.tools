# 08 — 未决事项

> 基线 commit `113a8c6`。本次接管修复见"已关闭"节;剩余按优先级列出,含验收标准。完整证据见 `04-production-readiness.md`。

## 已关闭(本次接管修复 + 回归测试)

| # | 严重度 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | P1 | 写路径无 RPC 健康追踪 + gas 检查失败告警盲区 | markFailed/markHealthy 接入 gas 检查;失败前先 checkAlerts;CF 同修 | rpc.test.ts 新增 Alchemy 轮转测试;149/28 全绿 |
| 2 | P1 | CF Worker 零 CI(资金 DO 不测/不类型检查) | ci.yml 新增 worker job(npm ci + npm test) | 本地 28 tests 绿;CI 新 job 已配置 |
| 3 | P1 | 无 dev/prod 隔离(dev 自动启动主网 worker) | QUEUE_WORKER opt-out 门控,dev task 设 0 | 实测 on/off 两态 |
| 4 | P2 | CF 缺 gas-price 告警 | checkAlerts 增 ⛽ 告警,与 Deno 对齐 | vitest 编译通过 |
| 5 | P2 | 源码裸 NUL 字节 | 换 `\0` 转义(字节等价) | hashIp 输出实测不变;security/log 测试绿 |
| 6 | P2 | 无启动配置校验(坏 PRIVATE_KEY) | isValidPrivateKey fail-fast,两运行时 | config.test.ts 新增 |
| 7 | P2 | 12 处 console.warn 泄漏 Alchemy key | 全改走 shortMsg(redactSecrets) | grep 确认 0 裸 err.message |
| 8 | P2 | Telegram 静默失败 | catch + 非 2xx 都 log.warn | check/test 绿 |
| 9 | — | CF DO 未接 Alchemy 写 RPC | DO 构造 setAlchemyRpc + ALCHEMY_API_KEY 绑定 | worker.test.ts 新增 2 测 |

修改文件:`shared/{queue,rpc}.ts`、`deno/{config,index,queue}.ts`、`deno.json`、`worker/{config,index,queue-processor,types}.ts`、`.github/workflows/ci.yml`、`.env.example`、`scripts/cf-setup.sh`、`README.md`、`deno/index.html`(README 同步)、`deno/tests/{rpc,config}.test.ts`、`worker/tests/worker.test.ts`。

## P2/P3 全量整改(2026-07-10)——上线运营者硬性要求驱动

运营者指令:**用户绝不能因本服务创建不了账户;任何需开发者干预的情况(代码bug/需充钱)必须到 Telegram;健壮性与性能做到最好。** 据此把 08 的 P2×14 + P3 全部整改,并经两轮多智能体对抗审查(第一轮 27 确认含 1 P0 + 6 P1,第二轮验证修复)。

### 可用性 / 用户永不被本服务挡住
- **P0(修复中引入并当场修掉)**:负缓存哨兵 `NOT_FOUND` 曾被 create 快速路径当作已存在记录返回 201「done」→ **静默丢弃用户创建**。已修:`cached && cached !== NOT_FOUND` 双运行时;哨兵也不会被当陈旧记录体返回;回归测试钉住。
- on-curve P256 校验:格式合法但不在曲线上的 key 入队前 400(否则烧 commit gas 后 reveal revert 进 DLQ)。
- 流式 body 限制(shared/body.ts):chunked/无 Content-Length 请求不再无界缓冲(内存 DoS)。
- 负缓存 + page 上界 + 每 IP 读限流(shared/read-limit.ts,fail-open):抑制读放大;但**读路径仍先查缓存、再查队列**,刚入队的 create 永远可见(walletRef 路径也补了队列回退)。
- CF 三道写闸门 fail-open 是**明确的可用性优先决策**(D1 抖动绝不挡创建),并记日志可见。

### 告警完整性(见 06 覆盖矩阵)
- 引擎钩子 `ItemFailureInfo{terminal,poison}` + `AlertReason` + `onStuckTx`:**终态 DLQ 隔离(代码bug/耗尽重试)即时告警**;空闲周期也跑告警(钱包被掏空立即发现);连续 gas 失败/cycle 抛错/DO alarm 抛错/无签名有排队/卡死 nonce 均有专用 Telegram 页;终态节流有补发不丢计数;Telegram 未配置会记一次日志 + `/api/health` 暴露 `telegramConfigured`;systemd OnFailure 单元在进程死后进程外直连 curl 告警。

### 资金路径健壮性(卡单自愈,不需人工)
- **卡单交易自动解堵重写**:以**链上已确认 nonce** 为唯一真相(不再依赖记录的 hash——旧版会产生永不清除的僵尸行饿死 sweep)。nonce < 已确认 → 删行(僵尸免疫);nonce >= 已确认且超时 → 同 nonce 递增 gas(150%/200%/…,**上限 MAX_GAS_PRICE_GWEI**)自转账替换;≥5 次仍不清 → onStuckTx 告警。空闲周期也解堵。ledger 读写用 safeRecord/safeDelete 包裹,绝不把成功广播错误地打入失败路径。43 个假链测试覆盖(含僵尸/递增/封顶/告警/空闲/读失败)。
- 版本化迁移(shared/migrations.ts,schema_migrations):INSERT OR IGNORE 并发冷启动安全;DO 首 cycle 前 ensureMigrated;worker init 记忆化 promise 失败可重试;D1 瞬态分类排除 constraint/duplicate-column。

### 配置 / 运维
- 缓存预算 32MB(CF 8MB)+ ×2 系数 + env 可调;全局写上限 120→40 + env;LOG_LEVEL;派生 IP 盐(不再用原始私钥);优雅停机(SIGTERM 排空);DO ping 仅在 create 时触发。
- deploy:健康闸门读远端 PORT + JSON status + **失败自动回滚到 last-known-good 并验证** + 记录实际 live 版本 + 失败 exit 1;systemd 用 sudo 安装;Deno 钉 v2.7.5;Restart=always;OnFailure 告警单元;alert 单元 EnvironmentFile 可选。
- CI:worker tsc 严格类型检查 + vitest;触网/perf 测试门控(RUN_LIVE_TESTS/RUN_PERF),默认套件全离线。
- 测试质量:server.test.ts 改测真实 handler(deno/handler.ts);wrangler.jsonc 成为入库唯一配置(可复现);迁移幂等 + 遗留库升级测试。

**当前测试:deno 189/0(15 门控忽略),vitest 28,tsc 严格,deno check —— 全绿。**

## 剩余 P2(上线后短期整改;上线可带缓解延期)