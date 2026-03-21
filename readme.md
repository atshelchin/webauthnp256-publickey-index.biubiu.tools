# WebAuthn P256 Public Key Index Service

WebAuthn P256 公钥索引服务。存储 passkeys 创建时的公钥与站点信息，作为多个应用的唯一公钥存储。

公共端点: `https://webauthnp256-publickey-index.biubiu.tools` 可直接使用，但数据安全和可用性由我们维护，建议自行部署以完全掌控数据。

- 运行时: Bun (编译为二进制部署)
- 数据库: SQLite (WAL 模式)
- 默认端口: 11256
- CORS: 允许所有域
- 认证: 无
- 速率限制: Cloudflare CDN 层面管理

## API 列表

### 查询

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/query` | `rpId`, `credentialId` | 根据站点+凭证ID查询公钥 |

### 创建

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/challenge` | 无 | 获取 challenge (有效期5分钟) |
| POST | `/api/create` | `rpId`, `credentialId`, `publicKey`, `challenge`, `signature` | 创建公钥记录 |

创建流程:
1. 客户端调用 `/api/challenge` 获取 challenge
2. 客户端用私钥对 challenge 签名 (P256 + SHA256)
3. 提交公钥 + 签名，服务端验证后存储

### 统计

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/stats/sites` | `page`, `pageSize`, `order` | 分页查询所有站点 |
| GET | `/api/stats/keys` | `rpId`, `page`, `pageSize`, `order` | 分页查询某站点下的公钥 |

分页参数: `page` 默认 1, `pageSize` 默认 20 (最大 100), `order` 为 `asc` 或 `desc` (默认 `desc`)

### 维护

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| POST | `/api/backup` | 无 | 备份数据库到 R2 并通知 Telegram |
| POST | `/api/restore` | `url` (下载链接) | 从备份增量恢复 (不中断服务) |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 返回本文档内容 |
| GET | `/api/health` | 健康检查 |

## 缓存策略

双层缓存:
- 服务端内存缓存: 5 分钟 TTL, 上限 100MB, 满时淘汰最早条目
- CDN 缓存: `Cache-Control: public, max-age=3600` (1 小时)

规则:
- 仅缓存 200 响应, 404 不缓存
- 创建新公钥后自动失效相关缓存

## 数据库设计

两张表:

**rp_ids** - 站点记录 (首次存储公钥时自动创建)

| 字段 | 类型 | 说明 |
|------|------|------|
| rpId | TEXT PRIMARY KEY | 站点域名 |
| publicKeyCount | INTEGER DEFAULT 0 | 公钥数量 (冗余计数) |
| createdAt | INTEGER | 创建时间戳 (毫秒) |

**public_keys** - 公钥记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | 自增主键 |
| rpId | TEXT NOT NULL | 站点域名 (外键) |
| credentialId | TEXT NOT NULL | 凭证 ID |
| publicKey | TEXT NOT NULL | P256 公钥 (hex) |
| createdAt | INTEGER | 创建时间戳 (毫秒) |

索引: `(rpId, credentialId)` 唯一联合索引, `rpId` 外键索引

## 项目结构

```
index.ts                     主入口, Bun.serve() 路由
src/
  db.ts                      数据库操作 (建表/CRUD/备份/合并恢复)
  cache.ts                   内存缓存 (TTL + 内存上限 + LRU淘汰)
  challenge.ts               challenge 生成/消费 + P256 签名验证
  routes/
    query.ts                 GET /api/query
    create.ts                GET /api/challenge + POST /api/create
    stats.ts                 GET /api/stats/sites + GET /api/stats/keys
    maintain.ts              POST /api/backup + POST /api/restore
.github/workflows/deploy.yml 自动部署 (release 分支触发)
```

## 本地开发

```bash
bun install
bun run dev          # 热重载开发
bun test             # 运行测试
bun run build:exe    # 编译为二进制
```

## 部署

### 触发方式

- 推送到 `release` 分支自动部署
- GitHub Actions 手动触发, 可指定版本回滚

### 部署流程

1. CI 编译二进制 -> 上传到服务器 -> 符号链接切换 -> systemd 重启 -> 健康检查
2. 健康检查失败自动回滚到上一版本
3. 保留最近 5 个版本

### 服务器目录结构

```
/opt/webauthnp256-publickey-index/
  releases/          各版本目录
  current/           -> 当前版本的符号链接
  data/              SQLite 数据库 (跨版本共享)
```

### GitHub Secrets 配置

在仓库 Settings > Secrets and variables > Actions 中配置:

| Secret | 说明 | 示例 |
|--------|------|------|
| `SSH_HOST` | 服务器 IP/域名 | `1.2.3.4` |
| `SSH_USER` | SSH 用户名 | `deploy` |
| `SSH_KEY` | SSH 私钥 | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `ENV_FILE` | .env 文件内容 (见下方) | 多行文本 |

### .env 环境变量

```env
# 服务端口 (可选, 默认 11256)
PORT=11256

# 数据库路径 (可选, 部署时由 systemd 注入)
# DB_PATH=/opt/webauthnp256-publickey-index/data/data.db

# Cloudflare R2 (备份功能必需)
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your_access_key>
R2_SECRET_ACCESS_KEY=<your_secret_key>
R2_BUCKET=<bucket_name>
R2_PUBLIC_URL=https://<your_r2_public_domain>

# Telegram 通知 (备份功能必需)
TELEGRAM_BOT_TOKEN=<bot_token>
TELEGRAM_CHAT_ID=<chat_id>
```

## 维护 API 详细说明

### 备份 (POST /api/backup)

1. SQLite VACUUM INTO 生成干净备份文件
2. 上传到 Cloudflare R2
3. 删除 R2 上的旧备份 (只保留最新一份)
4. 通过 Telegram 发送备份下载链接给管理员
5. 返回 `{ success: true, url: "..." }`

### 恢复 (POST /api/restore)

请求体: `{ "url": "https://..." }`

1. 下载备份数据库文件
2. 逐条检查记录, 当前库中不存在的插入, 已存在的跳过 (增量合并)
3. 全程服务正常读写, 不中断不拒绝请求
4. 返回 `{ success: true, message: "restore completed (incremental merge)" }`
