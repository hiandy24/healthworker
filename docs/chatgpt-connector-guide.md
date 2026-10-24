# ChatGPT 接入 HealthWorker：从 Skill 到 MCP Connector 的开发与排障指南

本文记录"让 ChatGPT 跨对话分析并记录训练数据"这一需求的完整落地过程：为什么 Skill 路线不作为网页端 plugin 入口、MCP 连接器的系统设计、对接 ChatGPT 的全部硬性要求、Cloudflare 边缘层踩过的坑，以及可复用的排障方法。配套实现见 `mcp/`，设计基线见 [design.md §9.6 / §9.6.1](design.md)。

## 1. 结论先行

- **Skill 路线不作为网页端 plugin 方案**：普通 ChatGPT 网页对话不执行用户本机的 CLI；当时 Skill 的 python 执行环境在网页版实测 DNS 失败。2026-10 核对 OpenAI 文档：ChatGPT Work 的 code/shell 网络由 workspace/用户策略控制，普通网页 Chat 不暴露本地 sandbox，因此“把 CLI 塞进 Skill”既不稳定，也无法安全携带 Access Service Token；携带活体凭据的 Skill 包还会被 OpenAI 安全审查标记（"may request or misuse credentials / send data outside the expected workflow"）。
- **MCP 连接器是当前路径**：MCP 连接由 ChatGPT 本体发起，不经用户 sandbox。把自建 API 封装成**远程 MCP 服务器**（Streamable HTTP），ChatGPT 通过自定义连接器直连。2026-10-24 用户已在 ChatGPT 网页端实际使用 9 工具版本。
- **密钥问题的根治**：连接 URL 内嵌不可猜测路径令牌，真正的上游凭据（Cloudflare Access Service Token）只存在于 MCP Worker 的 Secret 里，永远不进 ChatGPT、不进对话、不进技能包。
- **2026-10 官方文档口径**：Plugin 由 skills + MCP server 组成；MCP 负责实时数据、认证、授权与受控操作，仅 instructions/resources 的插件可以只有 skills。Custom GPT 正在迁移到 plugins，custom actions 不会自动迁移，官方建议替换为 custom MCP server。参考 [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)、[MCP server](https://developers.openai.com/plugins/concepts/mcp-server)、[Moving custom GPTs to plugins](https://developers.openai.com/codex/migrate-custom-gpts)。
- 最终架构：

```
ChatGPT（任何对话，零密钥）
   │  MCP Streamable HTTP（POST，Accept: text/event-stream）
   ▼
healthworker-mcp Worker（mcp/ 目录，无状态、无 DO）
   │  路径令牌准入（大小写折叠兼容）＋ 只读工具 7 个 ＋ create-only 工具 2 个
   │  Access Service Token（Worker Secret）
   ▼
现有 Agent API（health.tokenflare.top，Access 验签不变）
   │
   ▼
D1（训练数据）
```

## 2. 两条路线对比（为什么不用 Skill 作为插件入口）

| 维度     | Skill（zip 上传）                                                                              | MCP Connector（当前方案）                        |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 网络     | 普通网页 Chat 的 skill 运行环境不保证网络；Work 的 code/shell 由策略控制，不能作为稳定取数通道 | MCP 由 ChatGPT 本体发起，经公网 HTTPS 连接服务器 |
| 密钥     | 必须随包携带（或每次对话粘贴），进工作区存储                                                   | 只存 Cloudflare Worker Secret，ChatGPT 端零凭据  |
| 安全审查 | 内嵌活体凭据会被标记 Needs Review / Blocked                                                    | 无凭据，无此问题                                 |
| 跨对话   | 每个新沙箱会话都要处理权限与密钥                                                               | 装一次，所有对话可用                             |
| 写能力   | 不可控（凭据自带权限）                                                                         | 可由工具面精确控制（只暴露 create-only）         |
| 结论     | ❌ 不作为网页端 plugin 路径                                                                    | ✅ 采用                                          |

> 保留场景：本地/CLI 环境（有网络）仍可用 `skills/healthworker/` 的 CLI 做批量导入；ChatGPT 侧用 MCP。

## 3. MCP 端设计

### 3.1 组件与边界

- **独立 Worker**（`mcp/`，名称 `healthworker-mcp`），不并入主 Worker：主 Worker 全部入口受 Access 保护，**不新增任何绕过 Access 的路径**；MCP Worker 只是 Agent API 的只读/受控创建消费者。
- 无 Durable Objects、无协议框架运行时依赖——手工实现协议子集，降低部署面并便于审计；`@modelcontextprotocol/sdk` 仅作 devDependency 在测试中以真实客户端（真实 TCP）钉住生态兼容性。

### 3.2 协议子集（有意保持最小）

| 能力              | 实现                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `initialize`      | 返回 protocolVersion（**日期形版本原样回显**）、capabilities.tools、serverInfo、instructions |
| `notifications/*` | HTTP 202 空响应                                                                              |
| `ping`            | `{}`                                                                                         |
| `tools/list`      | 9 个工具的完整元数据                                                                         |
| `tools/call`      | 成功 = text content + `structuredContent`；失败 = `isError: true` 文本                       |
| 会话              | 无（不发 `Mcp-Session-Id`，也不要求客户端携带）                                              |
| 服务端主动流      | 无（GET / DELETE → 405 + Allow: POST）                                                       |
| 批量 JSON-RPC     | 拒绝（-32600，HTTP 400）                                                                     |
| 响应格式          | 客户端 Accept 含 `text/event-stream` → **SSE 包裹**；仅 JSON 客户端 → 纯 JSON                |

### 3.3 认证模型

- **准入 = URL 路径令牌**：`/mcp/<32 字符 base64url 随机令牌>`，常量时间比较，错误一律 404（不区分"路径不对"与"令牌不对"）。
- 为什么不用自定义头/OAuth：**ChatGPT 自定义连接器只支持 No Auth 或 OAuth，不能发送自定义认证头**（Cloudflare Access 的 `CF-Access-Client-*` 头在连接器上无法配置）。OAuth 需要额外搭授权服务器，对单用户场景收益不成比例。
- **大小写折叠兼容**：实测 ChatGPT 校验器会对 URL 做大小写规范化，令牌段按大小写不敏感匹配（折叠后熵仍约 168 bit）。
- 上游凭据（`AGENT_CLIENT_ID` / `AGENT_CLIENT_SECRET`）为 Worker Secret。仅分析时可使用**未加入导入白名单的只读 Service Token**；启用 create 工具时必须使用精确导入 Token，且只授予 `workouts:create`/`exercises:create`。轮换只影响 MCP Worker，所有对话即时生效。路径令牌是唯一准入，在当前导入 Token 配置下持有 URL 即拥有当前 9 工具面（含 create-only），必须按凭证保管。

### 3.4 工具面与写安全

- **7 个只读工具**：`get_metadata`、`search_exercises`、`list_workouts`、`get_workout`、`get_summary_stats`、`get_strength_stats`、`get_cardio_stats`。训练备注**永不返回**（不传 `includeNotes`）。当前 9 工具版本已上线，用户已于 2026-10-24 在 ChatGPT 网页端实际使用。
- **2 个 create-only 工具**：`create_workout`、`create_exercise`，与导入白名单身份已有权限一致。**无更新/删除/归档/设置/导出/管理**工具。
- 写安全三件套：
  1. **标注**：create 工具 `readOnlyHint: false`，触发 ChatGPT 的写操作人工确认；
  2. **幂等**：幂等键 = `hw-mcp-` + SHA-256(工具名 + 规范化参数)，无状态调用重试安全；显式 `idempotencyKey` 参数用于刻意的同内容重复创建；
  3. **纪律**：instructions + 工具描述强制"写入前把完整内容逐项展示给用户并取得确认、绝不虚构用户未提供的数据"。
- 双层校验：MCP 层做结构/格式浅校验并**填充 null/默认值**（满足上游 strict schema 的完整字段要求），上游 Zod 仍是权威校验者；业务错误以 `UPSTREAM_REJECTED <code>` 回传供模型自纠。

### 3.5 错误契约

| 场景                                 | 返回                                          |
| ------------------------------------ | --------------------------------------------- |
| 参数校验失败（含未知参数、原型链键） | JSON-RPC `-32602`                             |
| 未知方法                             | `-32601`                                      |
| JSON 解析/结构/超大请求              | `-32700` / `-32600`（HTTP 400 / 413）         |
| 上游 401/403                         | `AUTHENTICATION`（isError）                   |
| 上游 3xx 重定向                      | `REDIRECT_REJECTED`（**绝不跟随**，保护凭据） |
| 上游 4xx 业务错                      | `UPSTREAM_REJECTED <code>: <message>`         |
| 上游 429/5xx、网络失败               | `UPSTREAM_ERROR` / `UPSTREAM_UNREACHABLE`     |
| 响应超 4 MiB                         | `RESPONSE_TOO_LARGE`（提示缩小范围）          |

## 4. 对接 ChatGPT 的硬性要求（官方文档 + 实测）

来源：[Build your MCP server](https://developers.openai.com/plugins/build/mcp-server)、[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[MCP transports 规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)。

1. **传输**：Streamable HTTP，公开 HTTPS，URL 需含 `/mcp` 路径；
2. **响应格式**：规范允许服务器返回 JSON 或 SSE，但**实测 ChatGPT 连接器只解析 SSE**（`text/event-stream`，`event: message\ndata: <json>\n\n`）——纯 JSON 会导致创建失败；
3. **工具元数据**（缺一即可能校验失败）：`name` + 人类可读 **`title`** + `description` + `inputSchema` + 返回结构化数据时的 **`outputSchema`** + **`annotations`**（`readOnlyHint` / `destructiveHint` / `openWorldHint`）；
4. **结果形态**：建议 `content`（JSON 字符串）与 **`structuredContent`**（对象）同时返回；
5. **`initialize.instructions`**：可选但强烈建议——前 512 字符放最关键的纪律要求；
6. **协议版本头**：对 `MCP-Protocol-Version` 要**宽容接受**（对未知版本返回 400 会把更新版的客户端挡在门外）；`initialize` 中日期形的 `protocolVersion` **原样回显**，避免严格客户端因降级而中止握手；
7. **可以没有的东西**：无会话、无服务端主动流（GET/DELETE 405 合法）、无 UI 资源。

## 5. 用户操作：在 ChatGPT 创建连接器

1. 设置 → **安全性 / Security and login** → 打开 **Developer mode**；
2. **Plugins（插件）→ 加号 → 创建连接器**；
3. 名称随意（如 `healthworker`）；Connection 选 **Server URL**；
4. URL 填 `https://mcp.tokenflare.top/mcp/<路径令牌>`；
5. Authentication 选 **No Auth**；勾选风险确认 → **Create**；
6. 创建后可见工具清单；后续新增工具时在连接器上点 **Refresh** 刷新元数据。

## 6. 边缘与网络层：最容易踩的坑

ChatGPT 的校验请求**由 OpenAI 服务端发起**（实测来源 IP：Google Cloud 沙特、荷兰等），与你浏览器的网络位置无关。请求要依次穿过：

```
OpenAI 校验器 → Cloudflare 边缘（BIC / 托管规则 / Bot 防护） → Worker
```

**任何一环拦截都会表现为 ChatGPT 侧笼统的 "Error creating connector"。** 已知三个拦截点及修复：

| 拦截点                                            | 症状                                                                             | 修复                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Managed rules（托管规则，含默认 AI 爬虫拦截）** | Security Events 里 OpenAI IP 显示 `Block / Managed rules`；Worker 探针**零日志** | 安全规则 → 自定义规则：`host eq mcp.tokenflare.top` → 动作 **Skip** → 勾选 **All managed rules**                       |
| **Browser Integrity Check（BIC）**                | 空 User-Agent 请求 403（Node 客户端默认不发 UA）                                 | Configuration Rule：`host eq mcp.tokenflare.top` → 关闭 Browser Integrity Check                                        |
| **workers.dev 域名行为**                          | 空 UA 一律 403；且国内直连不可达（浏览器侧校验/使用会失败）                      | 绑定自有 zone 的自定义域（`routes: [{ pattern: "mcp.tokenflare.top", custom_domain: true }]`），workers.dev 仅留作备用 |

## 7. 排障手册：三层证据法

按顺序取三层证据，能定位到任意一层的故障，不需要猜：

### 第一层：Worker 探针（请求是否到达业务代码）

`wrangler tail healthworker-mcp --format pretty`，Worker 内保留最小日志：

```
mcp request method=POST pathShape=/mcp/<32> matched=true exact=true caseOnly=false ua=openai-mcp/1.0.0 accept=application/json, text/event-stream
```

- **只记方法、路径形状（段长）、匹配结果、UA、Accept**——绝不记录路径令牌本身、请求体或凭据；
- 校验器的典型指纹：`ua=openai-mcp/1.0.0`，先 POST 握手、再 GET 探测 SSE；
- `matched=false` + `pathShape` 长度正确 → 令牌内容问题（大小写折叠？粘贴错误？）；
- **零日志 ≠ 请求没发出**：还要看第二层（边缘拦截不会到 Worker）。

### 第二层：Cloudflare 安全事件（请求是否到过边缘）

面板 → 域名 → **安全性 → 事件**，按主机名与时间筛选。看到 `Block / Managed rules` 或 `Browser integrity check` 即为边缘拦截（见 §6 修复表）。

### 第三层：协议与工具层（到达后为何仍失败）

- 用 **MCP Inspector** 或 `@modelcontextprotocol/sdk` 客户端直连端点做对照实验（我们的 SDK 兼容性测试就是这个角色）；
- 对照 §4 的硬性要求逐项核对——多数失败集中在 SSE 响应格式与工具元数据缺失。

### 常见症状速查

| 症状                                                   | 根因                                       | 修复                                   |
| ------------------------------------------------------ | ------------------------------------------ | -------------------------------------- |
| Error creating connector，探针零日志                   | 边缘托管规则拦截 OpenAI 校验器             | Skip 规则（§6）                        |
| Error creating connector，探针有日志但 `matched=false` | 令牌不匹配（大小写/粘贴错误）              | 大小写折叠兼容已内置；核对完整 URL     |
| 创建成功但工具不出现                                   | 元数据缺 title/annotations/outputSchema 等 | 按 §4 补齐并 Refresh                   |
| 客户端报无法解析响应                                   | 返回纯 JSON 而非 SSE                       | Accept 含 `event/stream` 时用 SSE 包裹 |
| 新版客户端握手后立即断开                               | initialize 回显了比客户端更旧的版本        | 日期形版本原样回显                     |
| 写入无响应/重复创建                                    | 缺少幂等或幂等键不稳定                     | 内容哈希幂等键（§3.4）                 |

## 8. 操作手册

### 8.1 部署

```sh
# 部署 MCP Worker（workers_dev + 自定义域）
corepack pnpm exec wrangler deploy --config mcp/wrangler.jsonc --no-autoconfig --strict   # 建议在交互 PTY 中执行

# 设置 Secrets（从受保护文件读入 stdin，绝不出现在命令行）
corepack pnpm exec wrangler secret put AGENT_CLIENT_ID     --config mcp/wrangler.jsonc < .local/mcp-secrets/AGENT_CLIENT_ID
corepack pnpm exec wrangler secret put AGENT_CLIENT_SECRET --config mcp/wrangler.jsonc < .local/mcp-secrets/AGENT_CLIENT_SECRET
corepack pnpm exec wrangler secret put MCP_PATH_TOKEN      --config mcp/wrangler.jsonc < .local/mcp-secrets/MCP_PATH_TOKEN
```

### 8.2 凭据交付纪律（真实事故教训）

**凡交付给用户或外部系统的凭据类字符串，必须由命令从唯一数据源读出并现场回验，禁止手写。** 本项目曾因在回复中手写连接 URL 令牌，导致多轮"连接器创建失败"的错误排查。流程：

1. 令牌只存在于 `.local/mcp-secrets/MCP_PATH_TOKEN`（0600，gitignore）；
2. 交付前执行 `python3 -c "..."` 从文件读取并拼出完整 URL；
3. 用该 URL 对真实端点做一次回验（期望 200，错误令牌 404）。

### 8.3 轮换与撤销

- 路径令牌轮换：`wrangler secret put MCP_PATH_TOKEN` 新值 → 在 ChatGPT 重建连接器（旧 URL 立即失效）；
- 上游凭据轮换：仅分析场景可换只读 Service Token；启用 create 时保留精确导入 Token。更新两个 Secret 即可，所有对话即时生效；
- 停用：删除 ChatGPT 连接器 + Cloudflare 侧 revoke Service Token，双保险。

## 9. 复用到其他项目的 Checklist

- [ ] 后端 API 已有可复用的鉴权（Service Token / API Key 头）
- [ ] 建独立 MCP Worker（无状态、无 DO），手工实现 §3.2 协议子集
- [ ] 路径令牌准入 + 大小写折叠兼容；错误 404 fail closed
- [ ] 响应按 Accept 分派 SSE / JSON；`MCP-Protocol-Version` 宽容；initialize 版本回显
- [ ] 每个工具含 `title` / `description` / `inputSchema` / `outputSchema` / `annotations`
- [ ] 写工具：`readOnlyHint: false` + 幂等键 + instructions 强制确认纪律
- [ ] 上游调用 `redirect: 'manual'` 并显式拒绝 3xx（workerd 不支持 `redirect: 'error'`）
- [ ] 自定义域绑定 + 边缘 Skip/Configuration Rule（托管规则、BIC）
- [ ] Worker 探针日志（形状级，不泄露令牌）+ wrangler tail 排障习惯
- [ ] 真实 SDK 客户端经真实 TCP 的兼容性测试进 CI
- [ ] 凭据只存 Worker Secret；连接器侧 No Auth + 路径令牌

## 10. 参考

- [Build your MCP server（OpenAI）](https://developers.openai.com/plugins/build/mcp-server)
- [Connect and test your plugin（OpenAI）](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Cloudflare 安全事件与规则](https://developers.cloudflare.com/waf/)
- 本项目实现：`mcp/src/{index,tools,env}.ts`、测试 `tests/mcp/` 与 `tests/unit/mcp-sdk-client.test.ts`、审查报告 `docs/reviews/2026-09-16-mcp-worker-review.md`
