# WebAuthn P256 Public Key Index Service

WebAuthn P256 公钥索引服务。存储 passkeys 创建时的公钥与站点信息，作为多个应用的唯一公钥存储。

公共端点: `https://webauthnp256-publickey-index.biubiu.tools` 可直接使用，但数据安全和可用性由我们维护，建议自行部署以完全掌控数据。

- 运行时: Bun (编译为二进制部署)
- 数据库: SQLite (WAL 模式)
- 默认端口: 11256
- CORS: 允许所有域
- 认证: 无
- 速率限制: Cloudflare CDN 层面管理
- 自动备份: 每小时一次, 上传 R2 并通过 Telegram 通知

## API 参考

Base URL: `https://webauthnp256-publickey-index.biubiu.tools` (或自部署地址)

---

### GET /api/challenge

获取一个一次性 challenge, 用于创建公钥时的签名验证。challenge 有效期 5 分钟, 使用后失效。

**请求**: 无参数

**响应**:
```json
{
  "challenge": "a1b2c3d4..."
}
```

---

### POST /api/create

创建一条公钥记录。需要先获取 challenge, 用 P256 私钥签名后提交。

**请求体** (JSON):
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| rpId | string | 是 | 站点域名 (如 `example.com`) |
| credentialId | string | 是 | 凭证 ID |
| publicKey | string | 是 | P256 公钥 (hex 格式, 含 04 前缀的非压缩格式) |
| challenge | string | 是 | 从 `/api/challenge` 获取的 challenge |
| signature | string | 是 | 用 P256 私钥对 challenge 签名的结果 (hex 格式) |
| name | string | 否 | passkey 的显示名称 (如 "我的 MacBook"), 默认空字符串 |

**签名方式**: 对 challenge 原始字符串做 `P256 + SHA256` 签名 (P256 库内部会对消息做 SHA256 哈希)

**请求示例**:
```json
{
  "rpId": "example.com",
  "credentialId": "abc123",
  "publicKey": "04a1b2c3...",
  "challenge": "从/api/challenge获取的值",
  "signature": "签名hex",
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
  "createdAt": 1711000000000
}
```

**错误响应**:
- `400` - 参数缺失 / challenge 无效或过期 / 签名验证失败
- `409` - 该 rpId + credentialId 已存在

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

### POST /api/backup

手动触发备份 (服务也会每小时自动备份一次)。

**请求**: 无参数

**响应** (200):
```json
{
  "success": true,
  "url": "https://r2-public-domain/backups/backup-2026-03-21T10-00-00-000Z.db"
}
```

---

### POST /api/restore

从备份 URL 增量恢复数据。恢复过程中服务正常读写, 不中断。

**请求体** (JSON):
```json
{
  "url": "https://r2-public-domain/backups/backup-2026-03-21T10-00-00-000Z.db"
}
```

**响应** (200):
```json
{
  "success": true,
  "message": "restore completed (incremental merge)"
}
```

恢复逻辑: 下载备份数据库, 逐条检查记录, 当前库中不存在的插入, 已存在的跳过。

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
1. GET  /api/challenge              → { "challenge": "xxx" }
2. 客户端用 P256 私钥对 "xxx" 签名    → signatureHex
3. POST /api/create                 → 201 Created
   Body: { rpId, credentialId, publicKey, challenge: "xxx", signature: signatureHex, name: "我的设备" }
4. GET  /api/query?rpId=...&credentialId=...  → { publicKey, name, ... }
```

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
| rpId | TEXT NOT NULL | 站点域名 (外键, 复合主键之一) |
| credentialId | TEXT NOT NULL | 凭证 ID (复合主键之一) |
| publicKey | TEXT NOT NULL | P256 公钥 (hex) |
| name | TEXT NOT NULL DEFAULT '' | passkey 显示名称 |
| createdAt | INTEGER | 创建时间戳 (毫秒) |

主键: `PRIMARY KEY (rpId, credentialId)`

## 项目结构

```
index.ts                     主入口, Bun.serve() 路由
build.ts                     构建脚本 (readme→HTML + 编译二进制)
src/
  db.ts                      数据库操作 (建表/CRUD/备份/合并恢复)
  cache.ts                   内存缓存 (TTL + 内存上限 + 淘汰)
  challenge.ts               challenge 生成/消费 + P256 签名验证
  routes/
    query.ts                 GET /api/query
    create.ts                GET /api/challenge + POST /api/create
    stats.ts                 GET /api/stats/sites + GET /api/stats/keys
    maintain.ts              POST /api/backup + POST /api/restore + 自动备份
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
