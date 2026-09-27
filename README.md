# docker-wxchat

[![Build and publish Docker image](https://github.com/myedunote/docker-wxchat/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/myedunote/docker-wxchat/actions/workflows/docker-publish.yml)

微信风格的**跨设备文件 / 消息传输助手**，自托管 Docker 发行版。

以 [xiyewuqiu/wxchat](https://github.com/xiyewuqiu/wxchat) 最新 `main` 为功能基准，
把原本跑在 Cloudflare Workers + D1 + R2 上的服务，通过一层**同形适配器**移植到
Node.js + SQLite + 本地磁盘，一条命令即可在自己的服务器上跑起来。

- 前端与业务逻辑**直接复用上游代码**，不另起炉灶
- Cloudflare 专有绑定（D1 / R2 / ASSETS）在适配层等价替换，业务代码无感知
- 数据全部落在宿主机 `./data` 与 `./uploads`，随时备份、随时迁移
- 每次推送到 `main` 自动构建 **amd64 / arm64 双架构**镜像并发布到 GitHub Packages

---

## 快速开始

```bash
# 1. 准备配置（务必修改密码与 JWT 密钥）
cp .env.example .env
#   ACCESS_PASSWORD=你的访问密码
#   JWT_SECRET=$(openssl rand -hex 32)

# 2. 核对配置（可选但强烈建议）
#    密码里含 $ 或 # 时，compose 会把它悄悄改写，登录会一直提示「密码错误」。
#    这一步不需要 Docker，几秒钟就能排除掉这类问题。
npm run check:env

# 3. 构建并启动
docker compose up -d --build

# 4. 打开浏览器
#    http://localhost:3000
```

首次启动会自动创建数据库并幂等执行 `database/schema.sql`，
日志里能看到：

```
[wxchat] ✓ 数据库就绪（schema 已幂等应用）
[wxchat] ✓ 上传目录可写
[wxchat] ✓ 服务已启动，listening on http://0.0.0.0:3000
```

确认健康状态：

```bash
curl -sf http://127.0.0.1:3000/api/health
# {"success":true,"data":{"status":"ok","version":"2.0.1","schema":"ready","time":"..."}}

docker compose ps          # STATUS 应为 healthy
docker compose logs --tail=80
```

### 不想自己构建？直接用现成镜像

每次推送到 `main`（或打 `v*` 标签）都会自动构建多架构镜像并发布到 GitHub Packages，
**amd64 与 arm64 双架构**，Docker 会按你的机器自动挑对应的那个：

```bash
docker run -d \
  --name wxchat \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ACCESS_PASSWORD='你的访问密码' \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v wxchat-data:/app/data \
  -v wxchat-uploads:/app/uploads \
  ghcr.io/myedunote/docker-wxchat:latest
```

> 这里用**命名卷**（`wxchat-data` / `wxchat-uploads`）而不是 `./data` 绑定挂载，
> 是为了绕开最常见的那类启动失败：绑定挂载的宿主机目录若由 Docker 以 root 创建，
> 而容器内进程以 uid 1000 运行，就会报 `EACCES /app/data`。
> 命名卷会继承镜像里已经 `chown` 好的属主，不会有这个问题。
> 如果你确实需要绑定挂载（想直接看到文件），请先 `chown -R 1000:1000 ./data ./uploads`，
> 详见「数据库 / 上传目录打不开」。

生产环境建议固定版本，而不是跟着 `latest` 漂：

```bash
docker pull ghcr.io/myedunote/docker-wxchat:2.0.1
```

升级到新版本：

```bash
docker pull ghcr.io/myedunote/docker-wxchat:latest
docker stop wxchat && docker rm wxchat
# 用上面同样的 docker run 重新起一个（命名卷里的数据会保留）
```

> ⚠️ 仓库根目录的 `docker-compose.yml` **只做本地构建**，它不引用任何外部镜像 ——
> 这是刻意的。历史上同时存在「根目录拉镜像」和「本地构建」两套入口，
> 导致 `docker compose up` 跑起来的是旧镜像却以为用的是新代码。
> 想用现成镜像，请用上面的 `docker run`，不要改 compose。

### 数据存在哪

| 内容 | 宿主机路径 | 容器内路径 |
| --- | --- | --- |
| SQLite 数据库 | `./data/wxchat.db` | `/app/data/wxchat.db` |
| 上传的文件 | `./uploads/files/` | `/app/uploads/files/` |

备份就是把这两个目录打包：

```bash
tar czf wxchat-backup-$(date +%F).tar.gz data uploads
```

---

## 环境变量

在 `.env` 中配置（可参考 `.env.example`）。**改完必须 `docker compose up -d` 才生效**，
只 `docker compose restart` 不会重新读取 `env_file`。

启动时会对配置做两项检查，避免「写了但不生效」这类静默故障：

- **旧变量名自动兼容**并提示（如 `AI_CHAT_API_KEY` → `AI_API_KEY`），详见 [AI 入口是灰的](#ai-入口是灰的)。
- **列出 `.env` 里不会被读取的变量**，基本就是拼错了名字。

### 基础

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 生产模式会隐藏内部错误细节 |
| `PORT` | `3000` | **宿主机**映射端口。容器内恒为 3000 |
| `TZ` | `Asia/Shanghai` | 时区。时间显示按「服务端 UTC + 浏览器本地时区」渲染 |
| `DATABASE_PATH` | `/app/data/wxchat.db` | SQLite 文件路径 |
| `UPLOAD_PATH` | `/app/uploads` | 上传文件存储目录 |
| `PUID` / `PGID` | `1000` / `1000` | 容器内进程 uid/gid，用于匹配宿主机目录属主 |
| `LOG_MAX_SIZE` | `10m` | 容器日志单文件上限，支持 `k`/`m`/`g` 后缀 |
| `LOG_MAX_FILE` | `3` | 容器日志最多保留几个轮转文件 |

> **`LOG_MAX_*` 不是可选项。** Docker 默认的 `json-file` 日志驱动**没有上限**：
> 容器往 stdout 写多少，`/var/lib/docker/containers/<id>/*.log` 就长多少，永不清理。
> 磁盘被撑满的后果不局限于本容器 —— daemon 写不了状态、**同一台机器上的其它容器
> 会跟着一起出问题**，症状与「容器莫名停止」高度重合，而且事后日志本身也写不进去，
> 什么都查不到。所以 compose 里默认已开启「10 MiB × 3」的轮转。
> 详见 [容器启动后不久就停止，而且别的容器也一起停](#容器启动后不久就停止而且别的容器也一起停)。

### 安全

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACCESS_PASSWORD` | 空 | 登录密码。**留空则无法登录**，必须设置 |
| `JWT_SECRET` | 空 | JWT 签名密钥。留空会用不安全的内置默认值并打印告警 |
| `SESSION_EXPIRE_HOURS` | `24` | 会话有效期（小时） |
| `MAX_LOGIN_ATTEMPTS` | `5` | 连续失败多少次后锁定 |
| `LOGIN_LOCKOUT_MINUTES` | `15` | 锁定时长（分钟） |

> ⚠ **`ACCESS_PASSWORD` / `JWT_SECRET` 里含 `$` 或 `#` 时，必须用单引号包住。**
> compose 会对未加引号的值做 `$` 插值、按「空格 + `#`」截断行内注释，
> 值会被悄悄改写，表现为「密码明明是对的却登录不了」。
> 部署前用 `npm run check:env` 核对，详见
> [登录时提示「密码错误」，但密码明明是对的](#登录时提示密码错误但密码明明是对的)。

### 数据与上传

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLEAR_CONFIRM_CODE` | 空 | 留空：前端**滑动确认**即可清空；填值：额外要求输入该确认码 |
| `MAX_FILE_SIZE` | `0` | 单文件最大字节数，`0` 表示不限制 |
| `MESSAGE_LOAD_DEFAULT` | `5000` | 单次加载消息条数 |
| `MESSAGE_LOAD_MAX` | `100000` | 单次加载硬上限（仅限制查询条数，**不会删除任何历史数据**） |

### AI

密钥只在服务端使用，**永不下发到前端**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_ENABLED` | `true` | 对话总开关（还需填 `AI_API_KEY` 才真正可用） |
| `AI_API_KEY` | 空 | 对话 API 密钥。旧名字 `AI_CHAT_API_KEY` 自动兼容 |
| `AI_API_BASE_URL` | `https://api.siliconflow.cn/v1` | 兼容 OpenAI 协议的 **base** 地址（不要带 `/chat/completions`）。旧名字 `AI_CHAT_BASE_URL` 自动兼容 |
| `AI_MODEL` | `deepseek-ai/DeepSeek-R1` | 对话模型。旧名字 `AI_CHAT_MODEL` 自动兼容 |
| `AI_MAX_TOKENS` | `4000` | 单次最大输出 token |
| `AI_TEMPERATURE` | `0.7` | 采样温度 |
| `AI_RATE_LIMIT` | `10` | **预留，当前版本未强制**。变量会被识别，但服务端尚未实现限流；需要限流请在反向代理层做 |
| `IMAGE_GEN_ENABLED` | `true` | 绘画总开关 |
| `IMAGE_GEN_API_KEY` | 空 | 绘画密钥，留空则回落 `AI_API_KEY` |
| `IMAGE_GEN_BASE_URL` | 空 | 绘画地址，留空则回落 `AI_API_BASE_URL`。旧名字 `IMAGE_GEN_API_BASE_URL` 自动兼容 |
| `IMAGE_GEN_MODEL` | `Kwai-Kolors/Kolors` | 绘画模型 |
| `IMAGE_GEN_DEFAULT_SIZE` | `1024x1024` | 默认出图尺寸 |
| `IMAGE_RATE_LIMIT` | `5` | **预留，当前版本未强制**，同 `AI_RATE_LIMIT` |

前端启动时会拉取 `GET /api/config`，据此决定 AI 入口是否可用、上传体积上限、
单次加载条数、清空是否需要确认码 —— 也就是说**改环境变量就能改前端行为**，
不需要重新构建前端。

---

## 与上游的差异

上游是 Cloudflare Workers 全栈应用。本项目的核心工作是把三个专有绑定换成等价实现：

| 上游（Cloudflare） | 本项目（自托管） | 实现位置 |
| --- | --- | --- |
| D1（`env.DB`） | SQLite via `better-sqlite3` | `src/adapter/d1.js` |
| R2（`env.R2`） | 本地目录 `UPLOAD_PATH` | `src/adapter/r2.js` |
| Static Assets（`env.ASSETS`） | `public/` 目录静态托管 | `src/adapter/assets.js` |
| `env` / Secrets | `process.env` + compose `env_file` | `src/adapter/env.js` |
| Workers 运行时 | `@hono/node-server` | `src/server.js` |

适配器刻意复刻了 Cloudflare 的接口形状，所以 `src/worker/**` 里的业务代码
基本原样保留：

- `DBService` 依赖 `db.prepare().bind().all()` 返回 `{ results }`、
  `.first()` 返回行、`.run()` 返回 `{ meta: { last_row_id } }`，以及 `db.batch()`
  —— 全部按 D1 语义实现，`batch()` 走真实事务。
- `FileService` 依赖 `r2.put(key, body, { httpMetadata })` / `r2.get(key)` /
  `r2.delete(key)`，其中 `get()` 返回的对象其 `.body` 必须是 Web `ReadableStream`
  （上游直接把它交给 `new Response()`）。
- `worker/routes/files.js` 用了 `c.executionCtx.waitUntil(...)` 做后台下载计数。
  Node 下没有这个对象，`src/server.js` 提供了一个 stub，并在优雅关闭时等待这些任务。

### 移植过程中修掉的三个真实缺陷

这三个问题在上游/旧 Docker 版里都存在，不修就会在 Node 上直接报错：

1. **中文文件名下载必然 500。**
   `Content-Disposition` 里 `filename="中文名.txt"` 含原始非 ASCII 字符。
   Cloudflare Workers 容忍这种头值，但 Node/undici 要求 header 必须是
   ByteString（每字符 ≤ 255），会抛
   `TypeError: Cannot convert argument to a ByteString`。
   现按 RFC 6266/5987 拆成 ASCII 兜底名 + `filename*=UTF-8''` 编码名。
   （`src/worker/routes/files.js`）

2. **不存在的 API 路径返回 200 + HTML。**
   上游的 SPA fallback（`app.get('*')`）会把 `/api/xxx` 也回落成 `index.html`，
   前端解析 JSON 时拿到 HTML，报出难以定位的错误。
   现 `/api/*` 显式返回 JSON 404。
   （`src/worker/index.js`）

3. **SSE 在客户端断开后产生未处理拒绝。**
   `writer.write()` 在连接关闭后返回 rejected Promise，上游未 catch。
   Node 下会触发 `unhandledRejection`。现显式 catch。
   （`src/worker/routes/realtime.js`）

### 相对上游新增的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | 下发运行时可配置项（不含任何密钥） |
| `DELETE` | `/api/messages/:id` | 删除单条消息（含关联文件与磁盘对象） |

### 保留的完整 API 契约

前端改动最小化的前提是后端契约不变。以下是全部接口：

```
GET    /api/health                     健康检查（无需鉴权）
POST   /api/auth/login                 { password } -> { token, expiresIn }
GET    /api/auth/verify                Bearer -> { valid, payload }
POST   /api/auth/logout

GET    /api/messages                   ?limit&offset&beforeId&afterId
POST   /api/messages                   { content, deviceId, type }
DELETE /api/messages/:id               新增

POST   /api/files/upload               multipart: file, deviceId
GET    /api/files/download/:r2Key      支持带路径的 key

GET    /api/search                     ?q&type&timeRange&deviceId&fileType&limit&offset
GET    /api/search/suggestions         ?q

GET    /api/events                     SSE，?deviceId&token&lastMessageId
GET    /api/poll                       长轮询降级，?deviceId&lastMessageId&timeout

POST   /api/sync                       { deviceId, deviceName }
POST   /api/clear-all                  { confirmCode? }
POST   /api/sync/clear-all             旧路径，兼容保留

GET    /api/ai/config
POST   /api/ai/chat                    流式代理（SSE 透传）
POST   /api/ai/message                 非流式，自动落库
POST   /api/ai/image                   生图代理
POST   /api/ai/image/save              生图结果落盘并入库

GET    /api/config                     新增
```

---

## 自托管 UX / 运维优化

以下能力相对上游做了增强，且都在真实浏览器里验证过：

| 能力 | 说明 |
| --- | --- |
| 长文本完整显示 | 消息气泡不裁剪、不限高，超长单行强制换行，代码块横向滚动 |
| 滑动确认清空 | 拖拽滑块到底才执行，不再强迫输入写死的确认码；`CLEAR_CONFIRM_CODE` 可作可选二次确认 |
| 一键复制消息 | 悬停出现复制按钮，右键/长按菜单也有；`navigator.clipboard` 不可用时自动回落 `execCommand` |
| 删除单条消息 | 二次确认后删除，关联文件与磁盘对象一并清理，不影响其它历史 |
| 时间显示正确 | 服务端统一存 UTC，前端按浏览器本地时区渲染，不再偏几小时 |
| 智能连接状态 | 区分「在线 / 重连中 / 离线」；浏览器 `navigator.onLine === false` 时不再谎报「连接中」；状态横幅有 800ms 防抖，网络抖动不闪屏 |
| 传输进度与速度 | 上传/下载均显示百分比、已传/总量与实时速度（KB/s、MB/s） |
| 上翻历史不跳底 | 用户查看历史时新消息不强行滚到底部，改为累计浮标「N 条新消息」，点击才回到底部 |
| 可配置加载条数 | `MESSAGE_LOAD_DEFAULT` 默认 5000（上游写死 50），上限 `MESSAGE_LOAD_MAX` |
| 轮询降为降级 | SSE 是主通道；自动刷新 5s，长轮询重试间隔 5s（上游为 1s/3s） |
| 非 root 运行 | 容器内以 `node`（uid 1000）运行，uid/gid 可通过 `PUID`/`PGID` 调整 |
| 优雅关闭 | 收到 `SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT` 时停止接收新请求、等待后台任务、WAL 落盘后关闭数据库；日志会记录**本次运行时长**，便于区分「刚启动就停」与「跑很久才停」 |
| 启动即暴露资源上限 | 启动横幅打印**容器内存上限**（自动识别 cgroup v1/v2）与 **Node 堆上限**，两者逼近时给出 OOM 风险告警；OOM 是 `SIGKILL`、不留日志，这一行是唯一的线索 |
| 日志轮转 | compose 默认 `json-file` + `max-size=10m` × `max-file=3`，避免日志无限增长撑满磁盘、连带拖垮同机器上的其它容器 |
| 停止原因可诊断 | `scripts/diagnose-unexpected-stop.sh` 一条命令查清「谁停的容器」：退出码 / `OOMKilled` / `docker events` / daemon 与宿主机重启 / 磁盘 / 定时任务与面板工具 |
| 幂等 schema | 每次启动执行 `schema.sql`（全部 `CREATE ... IF NOT EXISTS`），可反复重启 |

---

## 关于 `Cannot find module '/server.js'` 这个错误

如果你是从旧的自托管 Docker 项目迁移过来的，大概率见过这段日志：

```
node:internal/modules/cjs/loader:1143
throw err;
Error: Cannot find module '/server.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1140:15)
code: 'MODULE_NOT_FOUND'
```

变体还有 `'/src/server.js'`、`'/app/server.js'` 等等，本质是同一类问题。

### 先理解一件事：报错里的路径是「解析后的绝对路径」

Node 在找不到入口文件时，打印的**不是 CMD 的原文**，而是它把入口路径和当前工作目录（cwd）
拼完之后得到的绝对路径。实测：

| 你实际执行的 | Node 报错 |
| --- | --- |
| `node src/server.js`，且 cwd 是 `D:\tmp\nodetest` | `Cannot find module 'D:\tmp\nodetest\src\server.js'` |
| `node /src/server.js` | `Cannot find module 'D:\src\server.js'` |

所以看到 `'/src/server.js'` 时，只有两种可能，**光看报错无法区分**：

- **A. cwd 是 `/`，而 CMD 写的是相对路径 `src/server.js`** → 说明 `WORKDIR /app` 没生效。
- **B. CMD 里写死了绝对路径 `node /src/server.js`** → 和 cwd 无关，永远指向文件系统根目录。

### 怎么区分（一条命令）

仓库里带了一个诊断脚本，在**运行容器的宿主机**上执行：

```bash
bash scripts/docker-doctor.sh
```

它会依次打印：合并后真正生效的 compose 配置、本地镜像的 `WorkingDir`/`Cmd`、
运行中容器的实际 `cwd`、最近日志、Dockerfile 换行符，最后给出结论和处置建议。

也可以手动查这几项：

```bash
docker compose config
```

它会打印**合并后**的最终配置，包括真正生效的 `command`、`working_dir`、`image`。
如果里面有 `command: node /src/server.js` 这类绝对路径，就是 B；如果 `working_dir` 不是 `/app`，就是 A。

再看一眼实际在跑的镜像里到底存了什么：

```bash
docker image inspect docker-wxchat:latest \
  --format 'WorkingDir={{.Config.WorkingDir}} Cmd={{json .Config.Cmd}}'
```

期望输出：`WorkingDir=/app Cmd=["node","src/server.js"]`。

### 最常见的真实原因：跑的不是你刚构建的镜像

这一点非常容易踩。Compose 的官方规则是：**服务同时写了 `build` 和 `image` 时，行为由
`pull_policy` 决定；没写 `pull_policy` 时，Compose 会先尝试拉取镜像，拉不到才从源码构建**。
而且 `latest` 标签即使在使用默认策略时也总是会被拉取。

于是 `docker compose up`（不带 `--build`）可能跑起一份本地旧镜像或远端同名镜像，
而不是你刚改过的 Dockerfile —— 症状就是「我明明修好了，它还是报旧错」。

本仓库已经堵住这个口子：

| 措施 | 位置 |
| --- | --- |
| `pull_policy: build` —— 强制从源码构建，镜像已存在也重建，绝不 pull | `docker-compose.yml` |
| `working_dir: /app` —— 运行时把 cwd 钉死，镜像元数据丢失也不影响 | `docker-compose.yml` |
| `WORKDIR /app` | `Dockerfile` |
| `CMD ["node", "src/server.js"]`，**只用相对路径**，禁止 `node /server.js` | `Dockerfile` |
| 构建期断言 `src/server.js`、`package.json`、`database/schema.sql`、`public/index.html` 都在镜像里，缺任何一个直接构建失败 | `Dockerfile` |
| 全仓库**只有一份** `docker-compose.yml`，只做本地构建，不引用任何外部业务镜像 | `docker-compose.yml` |
| 启动时打印 `cwd` 与入口绝对路径，并断言 `${cwd}/package.json` 可读，不对就立即退出 | `src/server.js` |

### 彻底重建（推荐做法）

改了 Dockerfile 却感觉没生效时，不要只 `restart`，按下面走一遍：

```bash
docker compose down --rmi local --volumes   # 删容器、删本项目构建出的镜像、删卷
docker compose up -d --build                # 重新构建并启动
docker compose logs --tail=80               # 应当看到 listening on http://0.0.0.0:3000
```

容器起来后自查：

```bash
# cwd 必须是 /app
docker compose exec wxchat node -e "console.log(process.cwd())"

# 验收红线那条命令
docker compose exec wxchat node -e "require('fs').accessSync(process.cwd()+'/package.json')" && echo OK

# 日志里不该再出现这个错误
docker compose logs | grep -i "cannot find module" && echo "仍然有问题" || echo "干净"
```

### 其它需要排除的可能

- **目录里存在第二份 compose 文件。** `docker-compose.override.yml`、`docker-compose.prod.yml`
  会被自动合并或误用。检查一下：`ls docker-compose*.yml`，再用 `docker compose config` 看最终合并结果。
- **Dockerfile 换行符被改成了 CRLF。** 如果你是通过复制粘贴拿到这份 Dockerfile，
  某些编辑器会写成 CRLF，可能让 `WORKDIR /app` 带上一个不可见的 `\r`。检查：

  ```bash
  grep -c $'\r' Dockerfile    # 输出 0 才正常
  ```

  本仓库用 `.gitattributes`（`* text=auto eol=lf`）强制 LF，正常 `git clone` 不会有这个问题。
- **构建缓存过旧。** 极少见，但可以彻底清一次：
  `docker builder prune -f` 后再 `docker compose up -d --build`。

---

## 常见问题

### 容器启动后不久就停止，而且别的容器也一起停

先说结论：**这几乎不是应用的问题，是宿主机层面的问题。**

判断依据有两条，都很硬：

**第一条：日志末尾是 `收到 SIGTERM`。**

```
[wxchat] ✓ 服务已启动，listening on http://0.0.0.0:3000
[wxchat]   健康检查: http://127.0.0.1:3000/api/health
[wxchat]   登录页面: http://127.0.0.1:3000/login.html
[wxchat] 收到 SIGTERM，开始优雅关闭…（本次已运行 12 秒）
[wxchat] ✓ 数据库已安全关闭
[wxchat] ✓ 已退出
```

`SIGTERM` 是**别人发过来的信号**，不是程序自己崩的。而且后面三步
（停止接收请求 → 关闭数据库 → 退出）完整走完了，说明进程健康、代码没问题 ——
真要是代码崩了，你会看到 `uncaughtException` 的堆栈，或者干脆什么都没有（被 `SIGKILL`）。

**第二条：其它容器也一起停。**

一个容器自己的问题，不会殃及别的容器。能一次性停掉一批容器的，只有下面几种可能：

| 可能原因 | 特征 |
| --- | --- |
| **docker daemon 重启** | 默认配置下 daemon 重启会向**所有**容器发 `SIGTERM`。常见触发：`apt upgrade` 升级 docker、daemon 崩溃后被 systemd 拉起、手动 `systemctl restart docker` |
| **宿主机重启 / 关机** | 关机流程会给所有进程发 `SIGTERM`。云服务器还会因欠费、到期、流量跑超、Spot 实例回收而直接关机 |
| **有人或某个面板执行了批量停止** | `docker compose down`、`docker stop $(docker ps -q)`；NAS 面板 / 1Panel / 宝塔 / Portainer 的「重新部署」定时任务 |
| **前台运行的 `docker compose up`（不带 `-d`）** | 它退出时（Ctrl+C、终端关闭、SSH 会话被回收）会向**它启动的那些容器**发 `SIGTERM`。`docker compose up -d` 不会有这个问题 |
| **磁盘写满** | `/var/lib/docker` 所在分区满了以后，daemon 无法写状态，整机容器一起出问题 |
| **整机内存耗尽** | 内核 OOM killer 挑进程杀，可能一次杀好几个。注意这种情况下**日志里不会有任何痕迹** |
| **自动更新工具** | watchtower、Portainer 的 auto-update 之类会主动停容器再拉起 |

**「本次已运行 X 秒」这条线索怎么用：**

启动横幅之后的关闭日志里会带上运行时长（`收到 SIGTERM，开始优雅关闭…（本次已运行 30 秒）`）。
这是刻意加的，因为它是**最省事的一条分流线**：

- **只跑了几十秒 / 几分钟就停** → 更可能是**有东西在定期动它**（定时任务、面板的定期重新部署、
  前台 `compose up` 的会话被回收），而不是内存或负载问题。这类原因**周期性**明显，
  查 `docker events` 会看到规律性的 `start → die` 循环。
- **跑了几小时到几天才停** → 更像宿主级**偶发**事件（daemon 重启、宿主机重启、
  云厂商回收、整机 OOM）。

另外注意 `restart` 策略的边界：**被显式 `docker stop` 过的容器不会自己回来**。
`unless-stopped` 永远不回来；`always` 也只在 **docker daemon 重启**时才回来。
所以「停了就一直躺着」本身就说明它是被**主动停止**的，而不是崩溃。

**一条命令定位：**

```bash
bash scripts/diagnose-unexpected-stop.sh
```

它会依次查：容器的退出码与 `OOMKilled` 标志、**本次运行时长**、`docker events` 里的
`stop`/`kill`/`oom` 事件、**把所有容器的停止时间放在一起比对（判断是不是真的「成批停止」）**、
内核 OOM 记录、daemon 与宿主机的重启历史、磁盘与日志占用、同 compose 项目的其它容器、
宿主机上是否挂着陈旧的 `compose` 进程、定时任务与面板类工具，最后给出结论列表。
想扩大时间窗就加 `SINCE`：

```bash
SINCE='7d' bash scripts/diagnose-unexpected-stop.sh
```

**不想跑脚本，就手敲这几条**（在宿主机上执行）：

```bash
# 1) 【最决定性】把所有容器的停止时间放在一起比对。
#    两个以上落在同一秒 → 就是「成批停止」，单容器原因可以全部排除。
docker ps -a --format '{{.Names}}' | xargs -I{} docker inspect {} \
  --format '{{.Name}} 状态={{.State.Status}} 退出码={{.State.ExitCode}} 停于={{.State.FinishedAt}}'

# 2) 是正常停止还是被强杀？143 = SIGTERM（外部正常停止），137 = SIGKILL（强杀/OOM）
docker inspect wxchat --format '{{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} 重启={{.RestartCount}}'

# 3) 谁在什么时候动了它？以及同一时刻还有谁一起死
docker events --since 24h --until 0s --filter 'event=die' --filter 'event=oom' \
  --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}'

# 4) daemon 有没有重启过
journalctl -u docker --since 24h --no-pager | grep -iE 'Stopping Docker|Started Docker'

# 5) 宿主机有没有重启过（uptime 小于一天就是重启过）
uptime; last -x reboot | head -3

# 6) 磁盘有没有满
df -h /; du -sh /var/lib/docker/containers/*/*.log | sort -rh | head

# 7) 有没有一个「前台运行的 compose」挂着（它退出时会顺手停掉容器）
ps -eo pid,etime,args | grep -E '[d]ocker[ -]compose'
```

**处置建议：**

- **如果是 daemon 重启**：这是最常见也最容易被忽略的一种。可在 `/etc/docker/daemon.json`
  里开启 `live-restore`，让 daemon 重启时容器继续运行（改完 `systemctl reload docker`，
  `reload` 不会停容器）：
  ```json
  { "live-restore": true }
  ```
  注意这会影响整台机器上的所有容器，请自行评估。
- **如果是面板 / 定时任务**：把本服务从面板里摘出来，改用 `docker run` 单独跑
  （见 [不想自己构建？直接用现成镜像](#不想自己构建直接用现成镜像)）。
- **如果宿主机上挂着一个前台 `docker compose up`**：它 Ctrl+C、终端关闭、SSH 会话被回收时，
  会向它启动的容器发 `SIGTERM`。确认没有残留进程后，改用 `docker compose up -d` 重新部署：
  ```bash
  ps -eo pid,etime,args | grep -E '[d]ocker[ -]compose'   # 先确认
  docker compose up -d                                    # 用后台模式重新起
  ```
  顺便提一句：本仓库的 compose 写了 `pull_policy: build`，也就是每次 `up` 都会走本地构建 ——
  这也是为什么更该用 `-d`，而不是把 `up` 挂在前台会话里。
- **如果是磁盘满**：确认日志轮转已生效 —— 最新版 compose 已默认开启
  `LOG_MAX_SIZE=10m` / `LOG_MAX_FILE=3`。用下面的命令核对实际生效的配置：
  ```bash
  docker inspect wxchat --format '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}'
  # 期望：json-file {"max-file":"3","max-size":"10m"}
  ```
  若显示 `{}`，说明还在跑旧 compose，执行 `docker compose up -d` 重建容器。
  另外 `docker builder prune -f` 与 `docker image prune -f` 也能立刻回收一批空间。
- **如果是内存**：启动日志里现在会直接打印「容器内存上限」与「Node 堆上限」，
  两者接近时会给出告警。容器被 OOM 杀掉是 `SIGKILL`，**不会留下任何应用日志**，
  所以「日志里没报错」不能作为排除依据。处置：调大 compose 的内存限制，
  或给 node 加 `--max-old-space-size=<MiB>` 压低堆上限。
- **如果是云服务器被关机**：去云控制台的「操作日志 / 事件中心 / 告警」核对故障时间点。
  这类停机不是配置能解决的。

> 顺带说明：日志里现在会带上「本次已运行 X 秒」。这一行是刻意加的 ——
> 「启动 3 秒就停」和「跑了 3 天才停」指向完全不同的原因，一眼就能分开。

### 端口被占用

```
Error: 端口 3000 已被占用
```

改 `.env` 里的 `PORT`（例如 `PORT=8080`），然后：

```bash
docker compose up -d
```

容器内部始终监听 3000，`PORT` 只影响宿主机映射端口。

### 数据库 / 上传目录打不开（权限问题）

最典型的报错是 SQLite 的 `unable to open database file`：

```
[wxchat] ✗ 数据库初始化失败: /app/data/wxchat.db
Error: 无法打开 SQLite 数据库: /app/data/wxchat.db
  原因  : SQLITE_CANTOPEN unable to open database file
  常见原因: 目录不存在 / 目录对当前用户不可写 / 该路径实际是一个目录
```

这个报错本身不说明原因。启动时会先做一次**真实写入探测**，把诊断信息直接打出来：

```
[wxchat] ✗ 数据目录不可写：/app/data
  EACCES: permission denied, open '/app/data/.write-probe'

诊断信息：
  当前进程 uid:gid : 1000:1000
  目录属主 uid:gid : 0:0
  目录权限         : 755

处置建议：
  1) 宿主机目录不属于容器运行身份（最常见）
       sudo chown -R 1000:1000 ./data ./uploads
     或让容器以宿主机目录属主身份运行，写进 .env：
       PUID=<目录属主 uid>
       PGID=<目录属主 gid>
     查宿主机目录属主： stat -c '%u:%g' ./data
  ...
```

照提示做即可。**最快的办法**是在宿主机项目目录下执行仓库自带的修正脚本：

```bash
bash scripts/fix-permissions.sh
```

它会读取 `.env` 里的 `PUID`/`PGID`、把 `./data` 与 `./uploads` 的属主改对、
验证可写性，并检查 SELinux 是否需要加 `:Z` 标签。

### 四种处置方式怎么选

| 场景 | 做法 |
| --- | --- |
| 普通 Linux 服务器（最常见） | `sudo chown -R 1000:1000 ./data ./uploads`，或跑上面的脚本 |
| 宿主机目录属于别的用户 | 把 `.env` 的 `PUID`/`PGID` 改成该目录属主：`stat -c '%u:%g' ./data` |
| 启用了 SELinux | 挂载加标签：`- ./data:/app/data:Z` |
| 不想折腾权限 | 改用命名卷（见下），首次创建自动继承 `node:node` |

> **为什么目录会属于 root？** 最常见的原因是你曾在 `root` 身份下执行过 `docker compose`。
> Docker 发现挂载源目录不存在时，会**自动以 root:root 创建**它。
> 用普通用户执行 compose，或提前 `mkdir -p data uploads`，就能避免。

**目录不存在。** 本仓库用 `.gitkeep` 占位，正常 `git clone` 下来目录就已存在；
ZIP 下载或手动拷贝可能丢，补上即可：

```bash
mkdir -p data uploads
```

**SELinux。** Fedora / CentOS / RHEL / openEuler / Anolis 等默认开启 SELinux，
bind mount 需要标签，把 compose 里的挂载改成：

```yaml
    volumes:
      - ./data:/app/data:Z
      - ./uploads:/app/uploads:Z
```

**改用命名卷（最省事）。** 命名卷首次创建时会继承镜像里 `/app/data` 的属主（`node:node`），
不会有属主问题：

```yaml
services:
  wxchat:
    volumes:
      - wxchat-data:/app/data
      - wxchat-uploads:/app/uploads
volumes:
  wxchat-data:
  wxchat-uploads:
```

**最后手段：让容器以 root 运行。** 不推荐，但如果宿主机的共享目录实在改不了属主
（某些 NAS 场景），可以在 `.env` 里设 `PUID=0` / `PGID=0`。
注意这会让容器内进程拥有 root 权限，安全性下降。

Windows / macOS 的 Docker Desktop 通过文件共享层映射权限，一般不会遇到这个问题。

### 改了环境变量但没生效

`env_file` 只在**容器创建时**读取。`docker compose restart` 不会重新加载 `.env`：

```bash
docker compose up -d        # 正确：重建容器以应用新环境变量
```

如果重建后还是不对，先确认值本身有没有被 compose 改写（尤其是含 `$` 或 `#` 的值）：

```bash
npm run check:env
```

### 想彻底重来（会删除全部数据）

```bash
docker compose down
rm -rf data uploads
docker compose up -d --build
```

### 登录时提示「密码错误」，但密码明明是对的

这是最容易被误判的一类问题。按顺序做两步就能定位。

**第一步：看容器里实际拿到的密码有多长。**

启动日志里有一段「安全配置」，它只打印长度、不打印内容：

```
[wxchat] ---------------- 安全配置 ----------------
[wxchat] ACCESS_PASSWORD : 长度 11（含 $）
[wxchat] JWT_SECRET      : 长度 32
[wxchat] ------------------------------------------
```

**第二步：在宿主机核对「你写的」和「实际传进去的」是否一致。**

```bash
npm run check:env          # 不需要 Docker，直接读 ./.env
```

它用 Docker Compose 的官方语法解析 `.env`（解析器本身有 22 条官方示例断言兜底），
把会被改写的值直接点出来：

```
【高危】以下密钥类变量传进容器的值与你写的不一样：
  ✗ ACCESS_PASSWORD
      文件里看起来是 : 12 个字符
      实际传入容器是 : 11 个字符
      原因           : $ 被当作变量引用做了插值（未定义的变量会被替换成空串）
      修正           : 用单引号包住：KEY='原值'
```

两边长度一比，结论立刻出来：

| 情况 | 结论 |
| --- | --- |
| 日志长度 = 你写的长度 | 配置没问题，问题在浏览器侧（见下） |
| 日志长度 ≠ 你写的长度 | `.env` 里的值被 compose 改写了，或容器没重建 |

**为什么会不一样：compose 不是原样透传。**

`env_file` 会对**未加引号 / 双引号**的值做 `$` 变量插值，并把「空格 + `#`」之后的内容当行内注释截掉：

```
ACCESS_PASSWORD=P@$$w0rd2026   →  P@$w0rd2026   （$$ 折叠成一个 $）
ACCESS_PASSWORD=Pa$word        →  Pa            （$word 未定义 → 空串）
ACCESS_PASSWORD=my pass #2     →  my pass       （# 被当注释）
```

**修法：密码里含 `$` 或 `#` 时，用单引号包住。** 单引号内完全字面，不插值也不截注释：

```
ACCESS_PASSWORD='P@$$w0rd2026'
```

改完必须 `docker compose up -d` 重建容器 —— 只 `restart` 不会重新读取 `env_file`。

**一条命令做完诊断（在容器内运行）：**

```bash
docker compose exec wxchat node scripts/diagnose-login.mjs
```

它用**容器自己拿到的那个密码**去请求登录接口，从而把几种成因分开：

- 登录成功 → 服务端配置没问题，问题在浏览器侧
- 登录失败 → 容器里的值本身就是错的（被改写 / 容器没重建）
- 提示被锁定 → 连续失败太多次，加 `--reset-lock` 立即解锁

**浏览器侧的可能原因：**

登录页用的是 `autocomplete="current-password"`，浏览器可能自动填入了**旧的**保存密码。

1. 点密码框旁的「显示」按钮，肉眼确认里面到底是什么
2. 用无痕窗口打开登录页重试（排除自动填充与旧缓存）
3. 确认访问的是这台服务，而不是别的地址

服务端日志里也会留下长度对账，便于事后回溯：

```
[Auth] 登录失败 ip=unknown —— 提交长度 12 ≠ 期望长度 11，
       多半是 .env 里的密码被 compose 改写或容器未重建（跑 npm run check:env 核对）
```

### 登录提示「服务端未配置访问密码」

`.env` 里的 `ACCESS_PASSWORD` 是空的。填上后 `docker compose up -d`。

### 忘记密码 / 想强制解锁被锁的 IP

```bash
# 改 .env 里的 ACCESS_PASSWORD 后重建
docker compose up -d

# 清除登录失败锁定记录
docker compose exec wxchat node scripts/diagnose-login.mjs --reset-lock
```

### AI 入口是灰的

`/api/ai/config` 只有在**开关打开且服务端配了密钥**时才返回 `aiEnabled: true`。
检查 `.env` 里的 `AI_ENABLED` 与 `AI_API_KEY`，改完 `docker compose up -d`。

**如果你是从旧版本迁移过来的**，很可能沿用旧变量名。这类错误不会报错，只会让 AI 静默失效，
所以启动时会主动提示：

```
[wxchat] ⚠ 环境变量 AI_CHAT_API_KEY 是旧名字，已自动按 AI_API_KEY 处理。建议改名为 AI_API_KEY。
```

旧名字会被自动兼容，无需改配置即可生效：

| 旧名字 | 规范名 |
| --- | --- |
| `AI_CHAT_API_KEY` | `AI_API_KEY` |
| `AI_CHAT_BASE_URL` | `AI_API_BASE_URL` |
| `AI_CHAT_MODEL` | `AI_MODEL` |
| `IMAGE_GEN_API_BASE_URL` | `IMAGE_GEN_BASE_URL` |
| `MAX_FILE_SIZE_MB`（单位 MB） | `MAX_FILE_SIZE`（单位字节，会自动换算） |

另外启动时还会列出 `.env` 里**写了但不会被读取**的变量——基本就是拼错了名字：

```
[wxchat] ⚠ .env 中有 1 个变量不会被读取，请确认是否拼写有误：
           - AI_API_KEY_SECRET
```

最后注意 `AI_API_BASE_URL` 要填 **base** 地址，代码内部会自己拼 `/chat/completions`：

```
正确：https://api.siliconflow.cn/v1
正确：https://ai.example.com/v1
错误：https://ai.example.com/v1/chat/completions   ← 会被拼成 .../chat/completions/chat/completions
```

（带后缀也不会真的出错——启动时会自动去掉——但按 base 填更清晰。）

### AI 怎么用

AI 入口**不在顶部菜单里**，而在输入框右侧的 `+` 里：

1. 点右下角 **`+`** → 弹出功能宫格
2. 点 **🤖 AI助手** → 进入 AI 模式：输入框 placeholder 变成「向 AI 提问...」，
   底部出现「🤖 AI助手模式已开启」提示条，点「关闭」或再点一次菜单项退出
3. 输入问题发送 → 回答以流式逐字显示。若模型返回思考过程（如 DeepSeek-R1 的
   `reasoning_content`），会折叠在「思考过程」里，正文单独渲染

不想开 AI 模式，也可以用前缀**临时**触发单条消息：

| 写法 | 说明 |
| --- | --- |
| `🤖 你好` | 前缀 `🤖` |
| `ai: 你好` | 前缀 `ai:` |
| `ai 你好` | 前缀 `ai `（后有空格） |

前缀只用于识别，会被剥掉后再发给模型。

**AI 绘画**：`+` → 🎨 AI绘画 → 填提示词 / 反向提示词 / 尺寸 / 步数 / 引导系数 →
生成后**自动下载并存入聊天记录**，落库为一条文件消息，不依赖第三方图床长期可用。

#### 每轮对话没有多轮上下文

每次请求只带**当前这一句**（`messages: [{ role: 'user', content }]`），
AI 不记得上一轮说过什么。这是当前实现的既定行为，不是故障。

#### 密钥不下发前端

所有 AI 请求都经服务端 `/api/ai/*` 转发，`AI_API_KEY` 只存在于容器环境变量里。
浏览器拿不到密钥，`GET /api/ai/config` 也只回 `aiEnabled` / 模型名这类非敏感信息。

`/api/ai/*` 与其他业务接口一样**需要登录态**（`Authorization: Bearer <JWT>`），
未登录会返回 `401 UNAUTHORIZED`。

### 点 `+` 只看到表情面板，找不到 AI 助手

**v2.0.1 已修复。** 根因是 `public/css/base.css` 缺少作者级的 `[hidden]` 规则：

浏览器默认样式表里的 `[hidden] { display: none }` 优先级**低于**作者样式表，
所以 `input.css` 里的 `.emoji-panel, .plus-panel { display: flex }` 会把它压掉，
JS 里 `el.hidden = true` 完全失效。后果是表情面板与功能宫格同时渲染在
`overflow: hidden` 的 `.panel-dock` 里（各 319px 高，而 dock 只有 320px），
宫格被挤出可见区 —— 表现就是「界面里根本没有 AI 入口」。

修复内容：

- `base.css` 补上 `[hidden] { display: none !important; }`，保证 `hidden` 属性在任何情况下生效
- 未配置密钥时 AI 入口**置灰并标注「未配置」**，点击直接提示要填哪个变量，
  不再出现「能进 AI 模式、一发就失败」的迷惑行为

同一根因还顺带修掉了两处同源缺陷（都被这条 `[hidden]` 规则一并解决）：

| 元素 | 表现 |
| --- | --- |
| `#plusPanel`（功能宫格） | 与表情面板互相叠压，两边都显示不全 |
| `#newMessagesBadge`（「N 条新消息」浮标） | 基类写了 `display: inline-flex`，所以 `hidden = true` 无效，浮标**从页面加载起就一直在**。虽然 `opacity: 0` 看不见，但仍参与布局且**可被点击** —— 相当于聊天区中间浮着一个隐形按钮 |

`npm run test:ui` 里有一条**全局不变量**断言把这类问题一次性兜住：

```
[6] 不变量：所有 [hidden] 元素都必须真的不可见
  ✓ 没有「设了 hidden 却仍然可见」的元素
```

它遍历页面上所有带 `hidden` 属性的元素，断言 `display === 'none'`。
只要以后有人给某个可隐藏元素写了 `display`，这条会立刻变红。

从旧版本升级时，**必须重新构建镜像**（`public/` 是打进镜像的，改完只 restart 不生效）：

```bash
docker compose up -d --build
```

### 重建镜像后界面还是老样子

先别急着怀疑镜像 —— 大概率是 **Service Worker 缓存**。

`public/sw.js` 对静态资源走 **cache-first**，而浏览器只在 **`sw.js` 文件内容变化**时
才检查更新（`updatefound`）。所以如果改了 `base.css` / `functionMenu.js` 却没动 `sw.js`，
已安装 SW 的浏览器会一直命中旧缓存，**刷新一次也看不到变化**。

发布纪律：**只要 `PRECACHE` 列表里的静态资源有改动，就必须递增 `sw.js` 里的 `CACHE_NAME`。**
命名与 `package.json` 的 `version` 对齐，同版本内多次改资源就追加 `-1` / `-2`：

```js
const CACHE_NAME = 'wxchat-static-2.0.1';
```

`npm run selfcheck` 会校验这一点，不一致直接报错：

```
✗ CACHE_NAME 含当前版本号 2.0.1（发布纪律） — CACHE_NAME=wxchat-static-9.9.9，...
```

已经吃到旧缓存的浏览器，任选其一即可恢复：

- 刷新两次（第一次页面仍是旧版，SW 已在后台更新缓存，第二次生效）
- 页面出现「有新版本」提示条时点它（会 `SKIP_WAITING` 并重载）
- 开发者工具 → Application → Service Workers → Unregister，再硬刷新

### 配了 `IMAGE_GEN_BASE_URL` 却不生效

**v2.0.1 已修复。** 旧版本里 `IMAGE_GEN_BASE_URL` 会在启动时被读取并归一化
（所以不会报「拼写有误」），但 `/api/ai/image` 路由从未消费它 ——
生图请求一律发到 `AI_API_BASE_URL`。

后果：如果你把对话和生图指向**不同服务商**，生图会静默走错地址，
表现为「密钥明明对，却报 401 / 模型不存在」。

现在生图的 base URL 与 apiKey 采用**同一套回落语义**：

```
IMAGE_GEN_BASE_URL → 留空则用 AI_API_BASE_URL
IMAGE_GEN_API_KEY  → 留空则用 AI_API_KEY
```

只想换生图服务商时，只需配这两项，不必动对话配置。

### 大文件上传内存占用高

上传走的是 multipart 整体解析（与上游一致），单个大文件会占用等量内存。
如果经常传大文件，建议在 `.env` 里用 `MAX_FILE_SIZE` 设一个合理上限（例如 `104857600`
即 100MB），并在反向代理上同步调整 `client_max_body_size`。

### 下载文件提示「请求超时」

v2.0.1 及更早版本存在此缺陷，**升级到当前版本即可**（若你的浏览器装过 Service Worker，
升级后需刷新两次或点「有新版本」提示条）。

根因在前端：`downloadFile` 传 `timeout: 0` 想表达「大文件不设硬超时」，
但 `API.request()` 把这个 0 直接交给了 `setTimeout(fn, 0)` ——
**那不是「不超时」，是「下一个 tick 就中止」**，于是请求几乎必然在拿到响应前被自己 abort，
报出来的是极具误导性的「请求超时」，而真正的原因恰恰是「根本没打算设超时」。

现在 `timeout <= 0` 被明确解释为「不设超时」，与同一文件里 `uploadFile` 的
`xhr.timeout = 0` 约定保持一致。

如果你想确认是同一回事：服务端本身没问题，用 curl 直连就能验证 ——

```bash
curl -i -H "Authorization: Bearer <token>" \
  "http://你的地址/api/files/download/files/xxxx.js"
# 预期：200 + content-length 正确 + 文件内容完整
```

如果 curl 正常而浏览器报超时，那问题一定在客户端（就是这个缺陷，或浏览器缓存了旧的
`api.js` —— 见「重建镜像后界面还是老样子」）。

### 手机上提示「下载完成」但文件没保存下来

v2.0.1 及更早版本存在此缺陷，**升级到当前版本即可**。

症状：PC 端下载正常，手机浏览器上点了下载，顶部弹出「下载完成」，
但下载列表里什么都没有，也没有任何保存对话框。

根因有两层，都在前端：

1. **`blob:` 下载在移动端根本不被支持。** 移动端大量浏览器其实是 WebView
   （微信 / QQ / UC / 夸克 / 各家 App 内置），它们没有处理 `blob:` URL 的下载器，
   `a.click()` 会被**静默忽略** —— 不抛错、不提示、什么都不会发生。
2. **发起时机已经脱离了用户手势。** Blob 方案必须先把整个文件 `await` 下来
   再 `click()`。等这一步做完，早已超出浏览器 transient activation 的窗口
   （约 5 秒），Chrome 会把它当成「自动下载」拦掉；
   旧代码在 iOS 上用的 `window.open(blobUrl)` 同理会吃弹窗拦截。

第 1 层还顺带解释了那个骗人的提示：`API.downloadFile` 正常返回了，
于是 `downloadWithProgress` 就弹「下载完成」——
可它返回的语义只是「已经把请求交给浏览器了」，文件到底有没有落盘，
前端**根本无从得知**。

现在的做法：**移动端改用「带 token 的直链」，把下载整个交给浏览器原生下载器。**
响应本身带 `Content-Disposition: attachment`，浏览器会自己弹保存/下载通知，
有系统级的进度和下载列表。因为不再需要先 `await` 文件，点击与发起下载在同一个
tick 内完成，也不存在手势过期的问题。

配套的三个改动：

- 移动端不再显示下载进度条，提示语也从「下载完成」改成
  「已开始下载，请在浏览器的「下载」中查看」—— 不再宣称一件它无法确认的事。
- 直链通过 `?token=` 携带凭据（浏览器原生下载是顶层导航，无法设置请求头）。
  服务端 `authMiddleware` 一直支持这种写法，`realtime.js` 的 EventSource 也在用。
- **过期 token 必须在发起导航前拦下。** 直链是顶层导航、不走 `fetch`，所以拿不到
  401 分支：带着一个过期 token 去导航，浏览器会把**整个应用页面**替换成服务端返回的
  JSON（`{"success":false,"error":"Token无效或已过期"}`）——用户既没拿到文件，还丢了
  当前界面，比单纯下载失败糟糕得多。所以 `Auth.isTokenExpired()` 会先在本地解析 `exp`，
  过期就走正常的「提示 + 回登录页」流程。
  > ⚠ 服务端签发的 `exp` 是**毫秒**时间戳（`src/worker/auth.js` 里
  > `Date.now() + hours*3600*1000`），不是 JWT 标准的秒。按秒比较会让**所有** token
  > 被判为已过期，移动端下载将彻底不可用。自测里有断言专门守着这条。

**平台判定为什么要单独写**（`Utils.useNativeDownload()`）：

「该不该走直链」这件事，光看 UA 里有没有 `Mobile` 会漏掉两类真实设备：

- **iPadOS Safari** 的 UA 是 `Macintosh`（伪装成桌面），任何基于 `Mobi|Android|iPhone|iPad`
  的判定都会把它归成桌面 → 继续走 `blob:` 那条死路。靠 `isIOS()`
  （`navigator.platform === 'MacIntel' && maxTouchPoints > 1`）兜底。
- **HarmonyOS NEXT / OpenHarmony**（ArkWeb 内核）的官方默认 UA 是：

  ```
  Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/114.0.0.0 Safari/537.36  ArkWeb/4.1.6.1 Mobile
  ```

  它**不含 `Android`**，而结尾的 `Mobile` 来自 DeviceCompat 这个「前向兼容字段」——
  平板和自行设置过 UA 的三方 WebView 都可能没有它。华为官方因此建议用
  `OpenHarmony` 识别系统、用 `Phone` / `Tablet` / `PC` 识别形态。现在的判定是：
  命中 `OpenHarmony|ArkWeb` 时，**只有 `(PC; …)` 算桌面**（2in1 设备），其余一律按移动端。

  这里判错的代价是不对称的：误判成移动端只是少一个进度条，误判成桌面则**下载直接失效**，
  所以未知形态一律倒向移动端。

**关于「凭据放在 URL 里」的取舍**（这是个有意识的决定，不是疏忽）：

下载直链用 `?token=` 传凭据，于是 24 小时有效的 JWT 会出现在 URL 里。
下载响应已加 `Referrer-Policy: no-referrer`，堵住「token 经 Referer 泄给第三方」这条路；
另加 `X-Content-Type-Options: nosniff`，对用户上传的任意类型文件做纵深防御。

但**另外两条堵不住**，属于这个方案的固有代价：

- 反向代理（nginx / Caddy）的 access log 里会有完整 URL —— 应用自身不记录 URL，
  但代理会记。若你在意，应在代理层对 `/api/files/download/` 做日志脱敏。
- 浏览器历史里会留一条 24 小时有效的链接。

想彻底避免，需要改成 Cookie 鉴权或短时效的一次性下载票据 —— 那是设计变更，
当前版本权衡后接受。注意这并非本次新引入：`realtime.js` 的 EventSource
（SSE 无法设置请求头）早就在用 `?token=`。

桌面端行为完全不变：仍然走流式读取 + 进度条 + 实时速度。

> 自测脚本 `node scripts/browser-check.js` 里有 9 条断言守着这条链路，其中最关键的是
> **用 CDP 把浏览器真的伪装成 Android Chrome（UA + 触屏 + 移动视口），点击真实的下载
> 按钮，然后断言文件真的落到了磁盘上、内容一致、文件名正确、且走的是 http 直链而非
> `blob:`**。另有反向对照（直链去掉 token 必须 401）。
> 注意这些断言必须带 `cache: 'no-store'` —— 下载响应带
> `Cache-Control: private, max-age=3600`，浏览器私有缓存**可以**跨 `Authorization`
> 复用，不加就会拿到缓存里的旧 200，让反向对照形同虚设。

---

## 目录结构

```
.
├── Dockerfile                 # node:20-alpine，WORKDIR /app，CMD 相对路径
├── docker-compose.yml         # 仓库根唯一入口，只做本地构建
├── .env.example               # 环境变量模板
├── .dockerignore              # 排除 data/ uploads/ node_modules/ .git/
├── .gitattributes             # 统一 LF，避免 CRLF 破坏容器内文件
├── database/
│   └── schema.sql             # 与上游一致；启动时幂等执行
├── src/
│   ├── server.js              # Node 入口：env -> DB -> 适配器 -> Hono -> listen
│   ├── adapter/
│   │   ├── d1.js              # D1 -> better-sqlite3
│   │   ├── r2.js              # R2 -> 本地文件系统
│   │   ├── assets.js          # ASSETS -> public/ 静态托管
│   │   └── env.js             # process.env -> worker env 形状
│   └── worker/                # 同步自上游，仅做必要改写
│       ├── index.js
│       ├── auth.js
│       ├── middleware/
│       ├── routes/
│       └── services/
├── public/                    # 同步自上游 + Docker 版 UX 增强
│   ├── css/docker-ux.css      # 新增的交互样式
│   ├── js/serverConfig.js     # 新增：加载 /api/config
│   └── ...
├── scripts/
│   ├── selfcheck.js           # 端到端 API 自检
│   ├── browser-check.js       # 真实浏览器 UI 冒烟测试
│   ├── check-shutdown.js      # 优雅关闭回归测试（真实 SIGTERM，仅 POSIX）
│   ├── check-env-file.mjs     # .env 体检：查出哪些值会被 compose 改写（宿主机上跑）
│   ├── diagnose-login.mjs     # 登录链路二分诊断（容器内跑）
│   ├── lib/compose-env.js     # Compose env 文件解析器（含官方示例断言）
│   ├── docker-doctor.sh       # 容器启动故障诊断（在宿主机上跑）
│   ├── diagnose-unexpected-stop.sh  # 「容器莫名停止」诊断：查清是谁发的停止信号
│   └── fix-permissions.sh     # 修正 ./data、./uploads 属主（在宿主机上跑）
├── data/                      # 运行时生成，不进镜像、不进 git
└── uploads/                   # 运行时生成，不进镜像、不进 git
```

---

## 验证

本机 Docker 不可用时，也可以直接用 Node 跑起来验证：

```bash
npm install
cp .env.example .env          # 至少改 ACCESS_PASSWORD
npm start                     # 等价于容器里的 node src/server.js

# 另开一个终端
NO_PROXY='*' ACCESS_PASSWORD=你的密码 npm run selfcheck   # 端到端 API 自检
NO_PROXY='*' ACCESS_PASSWORD=你的密码 node scripts/browser-check.js   # 真实浏览器 UI 冒烟测试（需本机 Chrome）

# 优雅关闭回归测试：自己起一个子进程，用真实 SIGTERM 验证「关库 → 退出码 0」，
# 并用 SIGKILL 做反向对照。不需要你手动起服务，也不需要 Docker。
npm run test:shutdown
```

> `NO_PROXY='*'` 是为了绕开宿主机上可能存在的 `http_proxy` —— 访问本地服务不该走代理。
> 注意 Node 内置的 `fetch`（undici）并不读 `http_proxy`，所以不加通常也没事；
> 但脚本里若混用了 `curl`，代理会把请求劫持走。

> `npm run test:shutdown` **只能在 Linux / macOS 上跑**：Windows 没有 POSIX 信号，
> Node 的 `child.kill('SIGTERM')` 在那边是强制终止，根本不会触发信号处理器。
> 脚本在 Windows 上会显式跳过并说明原因，CI 跑在 `ubuntu-latest`，会自动覆盖这一项。

### 持续集成

`.github/workflows/docker-publish.yml` 在每次推送到 `main` 或打 `v*` 标签时做两件事：

1. **verify** —— 装依赖、跑环境变量消费审计、启动服务端跑一遍 `selfcheck.js`，
   再跑一遍 `check-shutdown.js`（真实 `SIGTERM` 的优雅关闭回归测试）。
2. **build** —— 通过后构建 `linux/amd64` + `linux/arm64` 双架构镜像，推送到
   `ghcr.io/myedunote/docker-wxchat`。

让自检作为构建的**前置门槛**是刻意的：镜像一旦推上去别人就会 `pull` 走，
让一个自检不通过的版本占用 `latest`，比构建失败糟糕得多 —— 构建失败至少是显式的。

Pull Request 只构建、不推送，用来提前暴露构建问题。

> ⚠️ **如果 `docker pull` 报 `denied` 或 `unauthorized`**，多半是包的可见性问题：
> GHCR 上的包在部分账号设置下**默认是私有的**，哪怕仓库本身是公开的。
> 去 `https://github.com/users/myedunote/packages/container/docker-wxchat/settings`
> 把 Visibility 改成 Public 即可（只需做一次）。
>
> 本仓库当前已确认是**公开可拉取**的 —— 验证方法：不带任何凭据请求清单应返回 401
> （GHCR 对所有镜像都要求 Bearer token，这是协议行为不是权限问题），
> 但用匿名 token 请求应返回 200：
> ```bash
> tok=$(curl -s "https://ghcr.io/token?scope=repository:myedunote/docker-wxchat:pull&service=ghcr.io" \
>       | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
> curl -sI -H "Authorization: Bearer $tok" \
>      -H "Accept: application/vnd.oci.image.index.v1+json" \
>      https://ghcr.io/v2/myedunote/docker-wxchat/manifests/latest | head -1
> # 期望 HTTP/2 200
> ```

`scripts/selfcheck.js` 覆盖健康检查、静态资源、鉴权与登录锁定、文本/长文本、
文件上传下载、搜索、删除单条、SSE 与长轮询、一键清空、错误处理等 88 项断言。
其中包含一组**静态守卫**（不需要跑服务也能单独跑）：

- **SW 缓存名必须与 `package.json` 的 version 对齐** —— 防止改了静态资源却忘记 bump 缓存名
- **`.env.example` 里承诺的变量必须真的被代码消费** —— 防止「配了却静默无效」
- **`.env` 解析器必须与 Docker Compose 官方语法一致**（22 条官方示例逐条断言）
- **体检必须能识别 `$` 插值改写，且单引号能免疫** —— 含反向对照组，避免「全都报有问题」也能通过
- **启动日志的安全段落只能输出长度，不能输出密码内容** —— 日志会被贴到工单/群里，明文进去就收不回来
- **登录失败提示必须区分「长度不一致」与「长度一致但内容不同」**

```bash
npm run audit:env       # 单独跑环境变量消费审计
npm run check:env       # 单独体检 .env：查出哪些值会被 compose 改写（不需要 Docker）
npm run diagnose:login  # 登录链路诊断（在容器内运行，见「登录时提示密码错误」）
```

`audit:env` 来自一个真实缺陷：`IMAGE_GEN_BASE_URL` 曾被执行 env 层读取并归一化
（所以不会报「拼写有误」），但路由从未消费它 —— 用户把生图指向另一家服务商时
会静默走错地址，表现为「密钥明明对，却报 401」。

`check:env` 来自另一类真实事故：`ACCESS_PASSWORD` 里的 `$` 被 compose 插值吃掉，
用户输入自己设的密码却一直提示「密码错误」，而日志里看不出任何异常。

`scripts/browser-check.js` 通过原生 CDP 驱动本机 Chrome，共 51 项断言，验证登录、发消息、
长文本不截断、文件上传、**文件下载（走 `API.downloadFile` 真实入口）**、**移动端下载
（真机行为模拟）**、**过期 token 不顶掉应用页面**、复制、删除、滑动确认清空、
连接状态文案，并收集控制台报错与未捕获异常。

其中下载那一组是刻意设计的：早先这条只用了裸 `fetch`，**恰好绕过了出缺陷的那一层**
（`API.request` 的超时逻辑），所以缺陷一路绿灯溜到线上。现在它同时断言这些事：
裸接口能下、经 `API.request(timeout:0)` 能下、**有限超时依然会中止**、
以及移动端直链能过鉴权（无请求头 + `?token=`）。

平台判定那一条覆盖 **8 种 UA**：Android、iPhone、iPadOS（`Macintosh` 伪装）、
HarmonyOS 手机 / 平板 / 三方 WebView / 2in1（PC）、桌面 Chrome。
之所以列这么多，是因为这条断言曾经是「空的」——用「文件是否真的落盘」去验移动端下载，
在桌面 Chrome 伪装成 Android UA 时**照样通过**（桌面支持 `blob:`，真机 WebView 不支持），
真正能钉住修复的是「下载 URL 的协议不是 `blob:`」。
**判「走的是哪条路」，而不是判「结果对不对」**，是这一组断言的立足点。

最后两条是**反向对照**，少了它们，「把所有超时一律关掉」「把鉴权整个去掉」
也能让前面的断言通过：超时那条打一个真实的慢接口（`/api/poll`）验证仍会被中止，
直链那条去掉 token 验证必须是 401。

移动端那一组更进一步，用 CDP 把浏览器**真的伪装成 Android Chrome**
（`Emulation.setUserAgentOverride` + 触屏 + 移动视口），点击真实的下载按钮，
再断言文件真的落到磁盘、内容一致、文件名正确、且 URL 协议不是 `blob:`。

> ⚠ 一个必须记住的教训：**「文件真的落盘」这条断言抓不到回归。**
> 桌面版 Chrome 即使伪装成 Android UA，也照样能下载 `blob:` URL ——
> 退回旧代码它依然是绿的。真机上的 WebView 不支持 `blob:` 下载、桌面 Chrome 却支持，
> 这个差异决定了：**只能断言「走的是哪条路」，不能只断言「文件有没有下来」。**
> 真正钉住修复的是「下载 URL 不是 blob: 协议」那条。
> （这是做负向验证时发现的 —— 不把修复临时改坏跑一遍，就不会知道哪条断言其实是空的。）
>
> 模拟毕竟不是真机：微信/QQ 内置浏览器可能连直链下载都拦。
> 若用户反馈仍失败，先问清浏览器种类。

### 单独验证 AI 链路（不需要真实 API 密钥）

内置一个零依赖的 OpenAI 兼容模拟上游，可以完全离线地把「对话」和「生图」两条链路
端到端跑通 —— 不需要消耗任何真实额度：

```bash
# 1) 起模拟上游（SSE 流式 + reasoning_content + 生图 + 图片下载）
npm run mock:ai                              # → http://127.0.0.1:18090

# 2) 起一个指向它的实例（另开终端）
#    ⚠ IMAGE_GEN_MODEL 不能省：测试会校验生图模型名，且它读的是服务端进程的 env
PORT=18091 AI_ENABLED=true AI_API_KEY=test-key-123 \
  AI_API_BASE_URL=http://127.0.0.1:18090/v1 AI_MODEL=mock-model-v1 \
  IMAGE_GEN_ENABLED=true IMAGE_GEN_MODEL=mock-kolors-v1 node src/server.js

# 3) 接口层端到端（36 项断言，自给自足，空库也能跑）
ACCESS_PASSWORD=你的密码 npm run test:ai

# 4) 真实浏览器 UI 流程（CDP 驱动本机 Chrome，免装 Playwright）
ACCESS_PASSWORD=你的密码 BASE=http://127.0.0.1:18091 npm run test:ui
```

`npm run test:ai` 覆盖：未登录 401 → 登录 → `/api/ai/config` 开关与模型名 →
`/api/ai/chat` 的 SSE 透传（含 `reasoning_content` 与 `[DONE]`）→
**校验上游真的收到了配置的 model / stream / max_tokens / temperature** →
`/api/ai/image` 生图 → `/api/ai/image/save` 下载并入库 → 消息落库。

`npm run test:ui` 覆盖：宫格里有 AI 入口、表情面板真正隐藏、进入 AI 模式、
发出消息并收到流式回复、AI 绘画弹窗完整流程（生成 → 下载 → 渲染出图片），
外加两条**全局不变量**：所有 `[hidden]` 元素必须真的不可见、页面无未捕获异常。

想验证「未配置密钥」的表现时，起一个 `AI_API_KEY=` 为空的实例，
并给 `test:ui` 加上 `EXPECT_NO_AI=1`：此时会断言 AI 入口置灰、
点击不进 AI 模式且提示要填哪个变量、消息按普通消息正常发出。

---

## 许可与致谢

- 本项目沿用上游许可证：**CC BY-NC-SA 4.0**（署名 - 非商业性使用 - 相同方式共享）。
  详见 [`LICENSE`](./LICENSE)。请勿用于商业用途。
- 功能设计与前端界面来自 **[xiyewuqiu/wxchat](https://github.com/xiyewuqiu/wxchat)**，
  感谢原作者的工作。上游是权威实现，本项目只是它的自托管适配发行版。
- 自托管适配思路参考了社区的 Docker 化尝试，但实现以本仓库为准。
