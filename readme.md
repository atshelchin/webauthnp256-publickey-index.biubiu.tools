# WebAuthn P256 Public Key Index Service

WebAuthn P256 公钥索引服务。数据存储在 Gnosis 链上的智能合约中，本服务作为读写代理，提供 REST API。

合约地址: `0xc1f7Ef155a0ee1B48edbbB5195608e336ae6542b` (Gnosis Chain)

公共端点: `https://webauthnp256-publickey-index.biubiu.tools`

- 运行时: Deno
- 数据源: Gnosis 链上合约 (通过 viem 读写)
- 默认端口: 11256
- CORS: 允许所有域
- 认证: 无 (写入由服务器钱包签名上链)

## API 参考

Base URL: `https://webauthnp256-publickey-index.biubiu.tools` (或自部署地址)

---

### POST /api/create

创建一条公钥记录。服务器执行链上 commit-reveal 流程 (commit → 等待 1 个区块 → createRecord)，整个过程约 10 秒。

**请求体** (JSON):
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| rpId | string | 是 | 站点域名 (如 `example.com`) |
| credentialId | string | 是 | 凭证 ID |
| publicKey | string | 是 | P256 公钥 (hex 格式, 含 04 前缀的非压缩格式, 65 字节) |
| name | string | 否 | passkey 的显示名称, 默认空字符串 |
| initialCredentialId | string | 否 | 初始凭证 ID, 默认等于 credentialId (密钥轮换时指向根凭证) |
| metadata | string | 否 | 附加元数据 (hex), 默认空 |

**请求示例**:
```json
{
  "rpId": "example.com",
  "credentialId": "abc123",
  "publicKey": "04a1b2c3...",
  "name": "我的 MacBook"
}
```

**成功响应** (201):
```json
{
  "rpId": "example.com",
  "credentialId": "abc123",
  "publicKey": "04a1b2c3...",
  "name": "我的 MacBook",
  "txHash": "0x..."
}
```

**错误响应**:
- `400` - 参数缺失
- `409` - 该 rpId + credentialId 已存在
- `500` - 链上交易失败

---

### GET /api/query

根据站点和凭证 ID 查询公钥。

**Query 参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| rpId | string | 是 | 站点域名 |
| credentialId | string | 是 | 凭证 ID |

**请求示例**: `GET /api/query?rpId=example.com&credentialId=abc123`

**成功响应** (200):
```json
{
  "rpId": "example.com",
  "credentialId": "abc123",
  "publicKey": "04a1b2c3...",
  "name": "我的 MacBook",
  "createdAt": 1711000000000
}
```

**错误响应**:
- `400` - rpId 或 credentialId 缺失
- `404` - 未找到

---

### GET /api/stats/sites

分页查询所有站点。

**Query 参数**:
| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| page | number | 否 | 1 | 页码 |
| pageSize | number | 否 | 20 | 每页数量 (最大 100) |
| order | string | 否 | desc | 排序方向: `asc` 或 `desc` |

**响应** (200):
```json
{
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "items": [
    { "rpId": "example.com", "publicKeyCount": 5, "createdAt": 1711000000000 }
  ]
}
```

---

### GET /api/stats/keys

分页查询某站点下的所有公钥。

**Query 参数**:
| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| rpId | string | 是 | - | 站点域名 |
| page | number | 否 | 1 | 页码 |
| pageSize | number | 否 | 20 | 每页数量 (最大 100) |
| order | string | 否 | desc | 排序方向: `asc` 或 `desc` |

**响应** (200):
```json
{
  "total": 5,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "rpId": "example.com",
      "credentialId": "abc123",
      "publicKey": "04a1b2c3...",
      "name": "我的 MacBook",
      "createdAt": 1711000000000
    }
  ]
}
```

**错误响应**: `400` - rpId 缺失

---

### GET /api/health

健康检查。

**响应** (200): `{ "status": "ok" }`

---

### GET /

返回本文档的 HTML 渲染版本 (GitHub 风格)。

---

## 完整调用流程示例

```
1. POST /api/create                           → 201 Created (链上 commit-reveal, ~10s)
   Body: { rpId, credentialId, publicKey, name }
2. GET  /api/query?rpId=...&credentialId=...  → { publicKey, name, ... }
```

## 缓存策略

双层缓存:
- 服务端内存缓存: 5 分钟 TTL, 上限 100MB, 满时淘汰最早条目
- CDN 缓存: `Cache-Control: public, max-age=3600` (1 小时)

规则:
- 仅缓存 200 响应, 404 不缓存

## 项目结构

```
index.ts                     主入口, Deno.serve() 路由
build.ts                     构建脚本 (readme→HTML + 编译二进制)
src/
  contract.ts                链上合约交互 (viem, Gnosis Chain)
  cache.ts                   内存缓存 (TTL + 内存上限 + 淘汰)
  routes/
    query.ts                 GET /api/query
    create.ts                POST /api/create (链上 commit-reveal)
    stats.ts                 GET /api/stats/sites + GET /api/stats/keys
.github/workflows/deploy.yml 自动部署 (release 分支触发)
```

## 本地开发

```bash
deno task dev          # 热重载开发
deno task test         # 运行测试
deno task build        # 编译为二进制
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

# RPC 节点 (可选, 默认 https://rpc.gnosischain.com)
RPC_URL=https://rpc.gnosischain.com

# 服务器钱包私钥 (创建公钥记录时需要, 用于签名链上交易)
PRIVATE_KEY=0x...
```
