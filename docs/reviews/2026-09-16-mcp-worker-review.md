# healthworker-mcp 只读 MCP Worker 代码审查记录（2026-09-16）

> 后续状态（2026-10-24）：MCP 已部署 9 工具（7 只读 + 2 create-only），用户已在 ChatGPT 网页端实际使用。本报告是 2026-09-16 对 2.1 只读 7 工具版本的审查记录，不代表当前工具面。

本轮范围：指定变更——新增独立 Worker `healthworker-mcp`（`mcp/` 目录）、`tests/mcp/`、`tests/unit/mcp-sdk-client.test.ts`、`vitest.mcp.config.ts`、`package.json`/`tsconfig.json` 配套与 `docs/design.md` 2.1/§9.6。对应 `docs/design.md` §9.6（2.1 变更记录）。
证据口径：L1 实测复现（临时探针测试，跑在 workerd 池）/ L2 静态确证（唯一调用链，标"未运行"）；未运行项在第 7 节单列。
工作区基线：`git status --porcelain | wc -l = 37`、`git ls-files | wc -l = 100`（基线提交 `cf620e4`，MCP 全部变更为未提交工作树）。收尾回到 37；本报告文件是审查产出的唯一新增文件（收尾后为 38）。

## 1. 结论摘要

- 本轮未发现 P0/P1/P2。核心安全声明全部实测成立：路径令牌常量时间比较且缺配置 fail closed 404、7 工具只读且 includeNotes 物理不可达、工具参数无法改变上游路径/查询语义（URLSearchParams 编码 + UUID/日期正则 + 换行拒绝）、错误分类不泄漏密钥与内部 URL、16 种 JSON-RPC 边界形状无一 500。
- 共 5 条 P3：原型链键可绕过"未知参数拒绝"契约（L1 实测，无注入面）、上游 fetch 未限定 redirect 存在凭据跟随重定向的配置型风险（L2）、README/部署文档未覆盖 MCP 套件（文档漂移）、design §12.2 未为 MCP 登记验收条目、4 个错误分支无永久测试（仅本轮探针覆盖）。
- 曾怀疑并证伪的项（批量拒绝、id null、params 异形、cursor 元字符注入、大写 UUID、Response 复用掩盖）见第 4 节，修复方无需重复排查。

## 2. 验证记录（真实输出）

| 命令                                          | 结果                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npx pnpm@10.34.5 typecheck`                  | 通过                                                                                |
| `npx pnpm@10.34.5 lint`                       | 通过                                                                                |
| `npx pnpm@10.34.5 format:check`               | 通过                                                                                |
| `npx pnpm@10.34.5 test`                       | 12 个测试文件 / 55 通过（含 `tests/unit/mcp-sdk-client.test.ts` 3 个真实 TCP 用例） |
| `npx pnpm@10.34.5 test:mcp`                   | 2 个测试文件 / 13 通过                                                              |
| `npx pnpm@10.34.5 test:integration`           | 6 个测试文件 / 55 通过                                                              |
| `python3 -m unittest discover -s tests/skill` | 47 个测试 OK                                                                        |
| `npx pnpm@10.34.5 build`                      | 通过（保留已知 >500 kB chunk 警告）                                                 |
| 专项：`tests/mcp/zz-review-probe.test.ts`     | 28 个断言全过（审查后已删除，重建方式见第 9 节）                                    |

与文档声明对拍：design §9.6 与实现一致（协议版本集合、405/202、-32700/-32600/-32602/-32601/-32603 使用、7 个工具名与顺序、错误分类映射、凭据为 Secret、AGENT_BASE_URL 公开 var、测试面描述）。README 第 42/96 行的测试命令清单未包含 `test:mcp`（HW-2026-09-16-03）。

## 3. 发现项

| ID               | 严重度 | 位置                           | 现象                                                              | 状态     |
| ---------------- | ------ | ------------------------------ | ----------------------------------------------------------------- | -------- |
| HW-2026-09-16-01 | P3     | `mcp/src/tools.ts:359`         | 原型链键绕过未知参数拒绝，`additionalProperties:false` 契约有缺口 | 本轮上报 |
| HW-2026-09-16-02 | P3     | `mcp/src/tools.ts:382-388`     | 上游 fetch 未限定 redirect，跨源重定向会跟随并转发 Access 凭据头  | 本轮上报 |
| HW-2026-09-16-03 | P3     | `README.md:42`、`README.md:96` | README/部署文档未覆盖 `test:mcp` 与 healthworker-mcp 部署         | 本轮上报 |
| HW-2026-09-16-04 | P3     | `docs/design.md`（§12.2/§13）  | MCP 面无验收条目，真实 ChatGPT 连接器兼容性未登记为验收真空       | 本轮上报 |
| HW-2026-09-16-05 | P3     | `tests/mcp/`、`tests/unit/`    | 413、RESPONSE_TOO_LARGE、流读取失败、2025-06-18 回显无永久测试    | 本轮上报 |

### HW-2026-09-16-01 · 原型链键绕过"未知参数拒绝"

- **严重度 / 信任级别**：P3 / L1 实测复现（workerd 池临时探针）
- **位置**：`mcp/src/tools.ts:359`（`if (!(key in tool.inputSchema.properties))`）
- **现象**：`in` 沿原型链判定，`toString`/`hasOwnProperty`/`constructor` 等继承键与 JSON 解析产生的 own `__proto__` 键均不被判为未知参数：不返回 -32602，请求继续打到上游。且 own `__proto__` 经 `validated[key] = value`（`tools.ts:361`）触发原型 setter，把该值设置为 validated 的原型，build 可经原型链读到未经 `validateArguments` 校验流程的值。
- **复现**：临时探针三个断言——`arguments:{"toString":"pwn","hasOwnProperty":"pwn","constructor":"pwn"}` → 无 error 且上游被调用；`arguments:{"__proto__":{"query":"x"}}` → 无 error 且上游被调用；对照组 `{"evil":"1"}` → -32602。均与预期一致。
- **影响**：与 design §9.6「未知参数拒绝，`additionalProperties: false` 强制执行」不符——这些键被静默忽略而非拒绝。**未发现注入面**：`build()` 只按字面量键读取并自带类型/长度/正则校验（`tools.ts:141-343`），原型链注入的值仍受 build 内建校验与上游 Zod 约束，故仅 P3 契约缺口。
- **根因**：`in` 运算符检查整条原型链；`Object.prototype` 上存在 `__proto__` 访问器与 `constructor` 等成员。
- **最小修复**：改用 `!Object.hasOwn(tool.inputSchema.properties, key)` 判未知；`validated` 用 `Object.create(null)` 构造（或用 `Map`），使 `__proto__` 赋值退化为普通存储。
- **回归测试建议**：`tests/mcp/tools.test.ts` 增加用例：`get_metadata` 带 `{"toString":"x"}` 与手写 raw body own `__proto__` 断言 -32602 且上游未被调用。现有测试只覆盖普通未知键（`{"unknown":true}`），抓不到继承键。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：重跑 `test:mcp` + 上述探针断言（应转为 -32602）。

### HW-2026-09-16-02 · 上游 fetch 未限定 redirect，凭据头可跟随跨源重定向

- **严重度 / 信任级别**：P3 / L2 静态确证（未运行）
- **位置**：`mcp/src/tools.ts:382-388`
- **现象**：`fetch` 默认 `redirect: 'follow'`；fetch 规范的 HTTP-redirect fetch 在跨源重定向时仅剥离 `Authorization`，`CF-Access-Client-Id`/`CF-Access-Client-Secret` 这类自定义头会被原样转发到重定向目标。
- **影响**：仅当 `AGENT_BASE_URL` 配置错误、或主 Worker 源站被配置为 302（正常 Access service token 鉴权失败返回 401，不触发 302；凭据有效时不重定向）时，Access 凭据可能离开预期源。属配置型纵深防御缺口，非常规路径。同仓库 Skill CLI 已把"拒绝跨源重定向"写进 A18 验收措辞，MCP 侧未对齐同一纪律。
- **复现**：未运行（需真实重定向源；静态确证依赖 fetch 规范条文）。
- **根因**：未显式限定重定向行为。
- **最小修复**：fetch init 增加 `redirect: 'error'`（上游凭据场景不应跟随任何重定向）。
- **回归测试建议**：mock 上游返回 302 断言 `UPSTREAM_REJECTED`（或 redirect:'error' 后的 UPSTREAM_UNREACHABLE），确保不被静默跟随。
- **与已知缺口的关系**：新缺陷（设计未声明此取舍）。
- **修复验证方法**：代码评审确认 init 存在 `redirect: 'error'`。

### HW-2026-09-16-03 · README/部署文档未覆盖 MCP 套件（文档漂移）

- **严重度 / 信任级别**：P3 / L1（静态比对）
- **位置**：`README.md:42`、`README.md:96`（命令清单与「按本页命令重跑全套」）、`docs/deployment.md`（无 MCP 章节）
- **现象**：README 的最小复评与全套命令不含 `test:mcp`；全文无 `mcp/`、`healthworker-mcp`、`@modelcontextprotocol/sdk` devDependency 的说明；部署文档无 MCP Worker 的部署与 Secret（`MCP_PATH_TOKEN`/`AGENT_CLIENT_ID`/`AGENT_CLIENT_SECRET`）配置步骤。
- **复现**：`grep -n "mcp\|MCP" README.md docs/deployment.md` 零命中。
- **影响**：按 README 指引重跑验证的第三方会漏掉整个 MCP 面；后续部署者没有凭据配置与轮换的操作文档（design §9.6 只有原则句）。
- **根因**：2.1 变更只更新了 design，未同步 README/deployment。
- **最小修复**：README 命令清单加 `npx pnpm@10.34.5 test:mcp`；deployment 增补 MCP Worker 部署小节（secret 设置、路径令牌生成、连接器 URL 组装、轮换）。
- **与已知缺口的关系**：新缺陷（AGENTS.md §5 要求文档同步，避免契约漂移）。
- **修复验证方法**：`grep -n "test:mcp" README.md` 命中。

### HW-2026-09-16-04 · MCP 面无验收条目，真实连接器兼容性未登记为验收真空

- **严重度 / 信任级别**：P3 / L2（静态比对）
- **位置**：`docs/design.md` §12.2（A01–A21 无 MCP 行）、§13；`.agents/skills/healthworker-review/references/known-gaps.md`（无 MCP 未部署条目）
- **现象**：2.1 新增的公开入口没有对应验收用例（至少应包括：无/错路径令牌 404 fail closed、`list_workouts`/`get_workout` 备注不可见、真实 ChatGPT 自定义连接器端到端握手与工具调用）；known-gaps 台账未登记"MCP Worker 未部署、真实连接器未验收"。
- **影响**：与 AGENTS.md §5「每个改动都对应设计章节与验收用例」不一致；SDK 客户端 TCP 测试是生态兼容证据，不构成 ChatGPT 真实验收，现有文档没有一处把两者区分开。
- **根因**：design 2.1 只写了 §9.6 的测试描述，未进入 §12.2 验收体系。
- **最小修复**：§12.2 增加 A22（MCP 准入/只读/备注不可见/真实连接器），known-gaps 登记未部署状态。
- **与已知缺口的关系**：新缺口（非既有条目重复）。
- **修复验证方法**：design §12.2 出现 MCP 行。

### HW-2026-09-16-05 · 四个错误分支无永久测试

- **严重度 / 信任级别**：P3 / L1（本轮临时探针覆盖，探针已删除）
- **位置**：`mcp/src/index.ts:174-176`（413）、`mcp/src/tools.ts:405-410`（RESPONSE_TOO_LARGE）、`mcp/src/tools.ts:405`+`mcp/src/index.ts:146-150`（上游响应流读取失败→-32603）、`mcp/src/index.ts:99-104`（initialize 回显 2025-06-18 未测，protocol.test.ts 只测 2025-03-26 与 fallback）
- **现象**：上述分支在 `tests/mcp/` 与 `tests/unit/` 中均无断言；本轮用探针实测均行为正确（413 带 -32600、RESPONSE_TOO_LARGE isError、流失败返回 -32603 而非 500、2025-06-18 回显正确）。
- **影响**：这些分支回归时（例如重构 callUpstream）测试不会变红。
- **根因**：首轮测试未覆盖次要错误路径。
- **最小修复**：把探针对应断言固化为 `tests/mcp/protocol.test.ts`/`tools.test.ts` 用例（413 用 300 KB padding body；RESPONSE_TOO_LARGE 用 >4 MiB mock body；流失败用 erroring ReadableStream；initialize params.protocolVersion='2025-06-18' 断言回显）。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：`test:mcp` 出现对应用例名。

## 4. 已核实无问题（修复方无需重复排查）

- **路径令牌认证**：`mcp/src/index.ts:43-50` 逐字节 XOR 含长度差、循环跑满 max(len)、不因匹配位置早退，常量时间声明成立；`index.ts:156-158` 缺/空 `MCP_PATH_TOKEN` 一律 404 fail closed（探针：undefined binding → 404）。认证先于方法与版本判定：错误令牌的 GET 返回 404 而非 405（探针），`/mcp/<tok>x`、`/mcp/wrong-token` 均 404（protocol.test.ts:27-41）；404 响应无 body 无区分信息。query 串不参与 pathname 比较；URL 解析不解码 pathname 中的百分号编码，`%74` 形式变体只会 false negative（fail closed），无绕过。
- **includeNotes 物理不可达**：`mcp/src` 无该键（grep 零命中）；`list_workouts`/`get_workout` 的 build 只设置白名单键（`tools.ts:199-236`）；上游默认 `includeNotes='false'` 且 Agent 请求强制 notes=null（`src/shared/workouts.ts:277`、`src/worker/workouts.ts:605`、`src/worker/workouts.ts:661`）；tools.test.ts:95 断言 URL 不含 includeNotes。双层保障成立。
- **工具参数无法改变上游路径/查询语义**（探针实测）：get_workout id 强制 UUID 正则（`tools.ts:21`），无 `/`、`%`、CRLF；cursor 含 `&`/`=`/`#`/`%` 被 URLSearchParams 一次编码（`cursor=a&limit=999#%20x` → `cursor=a%26limit%3D999%23%2520x`），上游收到且仅收到一个查询参数；含换行的 cursor 被 `/^.{1,4000}$/` 拒绝（`.` 不匹配 `\n`，-32602）。cursor 往返忠实：上游 nextCursor 本身是 `encodeURIComponent(JSON.stringify(...))`（`src/worker/exercises.ts:132`），MCP 编码 `%`→`%25`、Hono 解析解码一次、worker `decodeURIComponent` 再解码一次，与 Web 客户端行为完全一致。大写 exerciseId 原样转发（tools.test.ts:98-104），上游 Zod `.uuid()` 接受大小写；最多造成大小写敏感的 404，非注入。
- **上游契约对拍一致**：7 个工具路径与 `/api/agent/v1` 下真实路由一一对应（`src/worker/index.ts:137-224`、`src/worker/stats.ts:463-509`、`src/worker/workouts.ts:529,638`）；参数名/枚举/上限与 `exerciseQuerySchema`（query ≤200、limit 1–100、cursor ≤4000）、`workoutQuerySchema`、summary/strength/cardio 三个 stats schema（granularity、category 七枚举、durationBasis、1–366 天）逐项一致（`src/shared/exercises.ts:80-91`、`src/shared/workouts.ts:271-285`、`src/shared/stats.ts:20-33`）。MCP 把上游可选的 from/to 变为必填、limit 收紧到 100（=`LIMITS.maxPageSize`），是声明过的浅校验收紧，与 §9.6 一致。
- **错误分类与泄漏面**：401/403 → AUTHENTICATION 且不读 body（边缘 HTML 错误页不会透传，`tools.ts:395-399`）；429/5xx → UPSTREAM_ERROR；非 200 → 透传上游受控 `error.code/message`（上游为自有 Worker，消息为 Zod/业务文案，探针与 SDK 测试断言了 422/403/503/网络异常/404 五类）；全部错误文本为常量串+状态码+受控消息，无密钥、无内部 URL、无堆栈。
- **JSON-RPC 边界无 500**（探针 16 形状）：id 为 null/对象/数组、缺 method、params 为数组/字符串/null、initialize params 异形、空 body、`null`/`42`/`"hello"`、批量数组、未知工具——全部返回规范 JSON-RPC 错误或 202。id null 被宽松当作请求处理（MCP 规范禁止 null id，宽松响应无害）；未知 method 的通知返回 202；未知工具 -32602（HTTP 200，符合 MCP 以 JSON-RPC 错误表达协议层错误的意图）。
- **协议版本**：未知 `MCP-Protocol-Version` 头 400（含通知，探针）；initialize 的 params 版本不支持时回退 latest，符合规范"响应一个服务器支持的版本"；协议面仅 JSON 响应、无会话、GET/DELETE 等 405+`Allow: POST`（规范允许不提供 SSE 流的服务器如此拒绝）。design 写"GET/DELETE 405"，实现为所有非 POST 405，是超集，不构成偏差。
- **测试真实性**：tools.test.ts 每次调用返回新建 Response（`tests/mcp/tools.test.ts:49-56` 注释明确 body 单次使用），不存在 Response 复用掩盖；断言具体上游 URL/凭据头/错误文本，非恒真；SDK 测试经 `node:http` 真实 TCP（`tests/unit/mcp-sdk-client.test.ts:55-82`），适配器完整转发 method/headers/body 与响应状态/头/体，客户端为官方 `Client`+`StreamableHTTPClientTransport`，initialize→notifications→listTools→callTool 全流程走通。`@modelcontextprotocol/sdk` 仅被 `tests/unit/mcp-sdk-client.test.ts:22-23` 引用（grep 证实 mcp/src 与 src 零引用），devDependency 边界与设计声明一致。
- **AGENTS.md 边界**：`mcp/src` 只 import `./tools`/`./env`，无 `src/worker`/`src/web` 依赖（F 项通过）；`mcp/wrangler.jsonc` 无 D1/ASSETS 绑定，最小权限；运行时依赖零新增；`AGENT_BASE_URL` 的主 Worker 公开源已在 README/deployment/design 公开（HEAD 已含），为设计声明的公开 var，非新泄漏。`observability.enabled=false` 与"训练查询不进日志"取向一致（代价是无线上诊断，属取舍注记）。
- **请求/响应大小检查在完整缓冲之后**（`index.ts:174-176`、`tools.ts:405-410`）：入口有路径令牌门槛、上游为自有 Worker（统计明细 10000 上限、列表 100/页、详情条目/组上限），实际体积有界，与 §9.6 "超 4 MiB→RESPONSE_TOO_LARGE" 描述一致，残余内存风险可接受。注记：`raw.length`/`body.length` 为 UTF-16 code unit 而非字节，极端 CJK 场景阈值放宽约 3 倍，不影响结论。
- **429 无自动重试**：单次上游失败即 `isError` 文本返回，由调用方模型决定重试；与 §9.6 错误契约一致，Skill CLI 的有界重试语义不适用于无状态 Worker，不作为缺陷。

## 5. 架构与数据安全设计核对

MCP Worker 无任何持久化与写路径，矩阵按"面"而非"写路径"给出：

| 面                                  | 凭据来源                           | 写面       | 状态/原子性      | 结论                                       |
| ----------------------------------- | ---------------------------------- | ---------- | ---------------- | ------------------------------------------ |
| 连接器准入（任意方法/路径）         | URL 路径令牌（Secret，常量时间）   | 无         | 无状态           | 与 §9.6 一致（探针 + 静态）                |
| `tools/call` × 7 → 上游 GET         | Worker Secret 注入 CF-Access 头    | 物理不存在 | 单请求，无重试   | 与 §9.6 一致；redirect 纵深见 HW-02        |
| 通知/initialize/ping/tools/list     | 令牌后即可达                       | 无         | 无状态，通知 202 | 与 §9.6 一致（探针）                       |
| 主 Worker（本轮未改动其路由与权限） | Access JWT（身份分类）+ 导入白名单 | 既有面不变 | 既有 batch/CAS   | 未受 MCP 变更影响（MCP 文件零反向 import） |

补充：单一写入者不受影响（MCP 以只读 Service Token 消费 Agent API，建议未加白名单的只读 token，凭据轮换只影响该 Worker）；D1 绑定物理不存在于 MCP 配置，数据库管理面不可达；无密钥/真实数据进入源码或测试（测试值为合成 `test-client-*`/`test-path-token`）；`workers_dev: true` 是设计声明的公开入口，路径令牌为唯一准入（已接受取舍），但 `preview_urls` 未显式关闭，与主 Worker `preview_urls: false` 相比多出一组预览子域入口（同样受路径令牌保护）——建议部署时一并设为 false，记为 HW-02 同轮的加固项，不单列发现。

## 6. 验收覆盖真空（对照 design §12.2）

| 编号     | 状态           | 证据 / 缺口                                                                                              |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| A01–A11  | 本轮未涉及     | 前端/统计/写入验收不在 MCP 变更面内，本轮未重跑 GUI                                                      |
| A12      | 仍存在（已知） | MCP 准入是路径令牌而非 Access JWT；真实 Access 边界验收状态以 README/known-gaps 为准                     |
| A13/A18  | 部分延伸       | MCP 只读工具集与 Skill 白名单同构（本轮静态对拍）；真实 ChatGPT 连接器未验收（HW-04）                    |
| A16/A17  | 仍存在（已知） | 不涉及                                                                                                   |
| A19/A21  | 本轮未涉及     | 不涉及                                                                                                   |
| A20      | 仍存在（已知） | healthworker-mcp 未部署；Secret 未配置（已接受）；部署后需检查日志不含令牌与查询内容                     |
| （新增） | 无证据         | 真实 ChatGPT 自定义连接器端到端（添加连接器、握手、工具调用、备注不可见的实机确认）——无验收条目（HW-04） |

## 7. 阻塞与未运行项

- healthworker-mcp 未部署，`MCP_PATH_TOKEN`/`AGENT_CLIENT_ID`/`AGENT_CLIENT_SECRET` 均为测试注入值；真实 ChatGPT 连接器兼容性未验收。这两项是已知已接受的取舍，不在本轮结论内，但意味着"ChatGPT 网页版可用"这一 2.1 的动机目标目前无证据。
- HW-2026-09-16-02 为 L2 静态确证，未运行重定向实验。
- 本轮未测量性能（MCP 为单请求转发，无缓存无聚合，不适用 §12.3 目标）。

## 8. 建议处理顺序

1. HW-2026-09-16-01：`Object.hasOwn` + null 原型修复，附继承键回归测试（一处小改，先做）。
2. HW-2026-09-16-02 + 第 5 节 `preview_urls:false` 加固：`redirect: 'error'` 一行。
3. HW-2026-09-16-03/04 文档一轮：README 命令与部署小节、design §12.2 增 A22、known-gaps 登记未部署状态。
4. HW-2026-09-16-05：按第 3 节断言把四个分支固化为 `test:mcp` 永久用例。

以上均为 P3，可合并为一轮完成；无阻塞合入的必修项。

## 9. 复评指引

- 本轮临时复现：`tests/mcp/zz-review-probe.test.ts`（28 断言，已删除；工作区已回到 37 基线）。重建方式：按第 3 节各 Finding 的"复现/回归测试建议"在 `tests/mcp/zz-*.test.ts` 重建（依赖 `vitest.mcp.config.ts` 的 miniflare 绑定与 `vi.spyOn(globalThis,'fetch')` mock 上游），运行 `npx pnpm@10.34.5 vitest run --config vitest.mcp.config.ts tests/mcp/zz-*.test.ts`。
- 复评时逐条核对 HW-2026-09-16-01…05，标注"已修复 / 仍存在 / 已变化 / 引入新问题"。
- 修复面扩散检查：改 `validateArguments` 时检查 `callTool`（`mcp/src/index.ts:118-151`）对 -32602 的传递与 tools.test.ts:97-124 的既有断言；改 fetch init 时检查 tools.test.ts 的凭据头断言与 SDK 测试的 mock 分支；改 design §12.2 时检查 §9.6 测试描述与 `test:mcp` 用例名的一致性。
