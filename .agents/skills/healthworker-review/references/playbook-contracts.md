# Playbook：契约、数据模型、迁移、统计口径

行号只是定位锚点，会随代码变动漂移；以文件内容为准。

## 1. 服务端前置条件清单（先建立"服务端要求什么"）

| 来源                         | 要求                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/worker/index.ts` 中间件 | 所有请求：路径规范化检查（`//`、`%2f`、`%5c`、`%00` → 400）；认证（人类 audience / Agent audience，缺配置 503）；Agent 路径非 GET → 405；**非 Agent 且非 GET/HEAD/OPTIONS → 必须同源 `Origin` + `Content-Type: application/json`**；请求体上限 `LIMITS.bodyBytes` |
| `src/worker/auth.ts`         | `Cf-Access-Jwt-Assertion` 存在、签名/issuer/audience/有效期校验、人类入口额外 owner allowlist；`humanAud !== agentAud` 必须成立                                                                                                                                   |
| 各写路由                     | `POST /workouts` 需 `Idempotency-Key`（`^[\x21-\x7e]+$`，≤200）；`PUT/DELETE /workouts/{id}`、`PATCH /exercises/{id}`、`PATCH /settings` 需 `If-Match: "<正整数版本>"`                                                                                            |
| 响应头                       | 所有 API 响应 `Cache-Control: no-store`；`X-Request-Id`；详情/设置返回 `ETag`                                                                                                                                                                                     |
| 错误语义                     | 400 语法/查询/游标/版本格式；401/403 认证与权限；404 不存在；405 方法；409 幂等正文不一致或引用竞争；412 版本冲突；413 体积；422 字段/计量/统计过密；428 缺前置条件                                                                                               |

## 2. 客户端调用点矩阵（逐个填，空格就是候选发现）

对 `src/web` 下每个 `api(...)`/`fetch(...)` 调用点，核对：方法、路径、是否带 body、`Content-Type`、`Origin`（浏览器自动）、`If-Match`、`Idempotency-Key`、body schema、期望状态码与响应 schema。

已知调用点（会新增，按实际搜索为准）：

- `src/web/lib.ts` `api()`：统一入口，**仅在 `init.body` 存在时**设置 `Content-Type`。
- `src/web/Settings.tsx`：`GET /settings`、`PATCH /settings`（带 body）、`exportAttachment()` 直接 `fetch /api/v1/export`（GET，检查 `content-disposition: attachment` 与 content-type）。
- `src/web/Exercises.tsx`：`GET /exercises`、`POST /exercises`、`PATCH /exercises/{id}`（归档与展示字段）。
- `src/web/Workouts.tsx`：`GET /workouts`（列表、参考）、`GET /workouts/{id}`、`POST /workouts`、`PUT /workouts/{id}`、**`DELETE /workouts/{id}`（无 body）**。
- `src/web/Stats.tsx`：三个 `/stats/*` GET。

**浏览器语义 ≠ 测试语义**（这是最容易漏的一类）：

| 差异                                                     | 后果示例                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 无 body 的写请求**不会**带 `Content-Type`                | 服务端若强制要求 JSON content-type，则 bodyless DELETE/PUT 一律 400（2026-09-14 实际发生过） |
| `Origin` 由浏览器自动加在同源非 GET 请求上，测试里常手写 | 测试通过但真实场景依赖同源配置正确                                                           |
| 测试辅助函数常无条件补齐头                               | 掩盖上两行的问题；审查时必须手写"故意不带"的变体                                             |
| `fetch` 的 `redirect: 'error'` 与 Access 跳转            | 登录页被当成错误处理，而不是被跟随；前端必须检测非 JSON 响应                                 |
| 服务端 `If-Match` 只认 `"1"` 形式                        | `1`、`W/"1"`、`"0"`、超大整数都应被拒（400）                                                 |

## 3. 共享契约（`src/shared`）

- 所有写 schema 用 `strictObject`，客户端不得提交计量快照；未知字段必须被拒。
- 日期：`1900–9999`（拒绝 JS 的 0–99 特例）；范围半开 `from <= localDate < to`，最长 366 天；缺失值 `null` 与 0 严格区分。
- 重量：API 三位小数 kg，存储整数 g；`kgSchema` 上限 10000。
- 上限常量集中在 `LIMITS`；**每个上限都要问"UI 允许的规模能否超出它"**（例：4000 字符备注 × 300 组 > 512 KiB 请求体）。
- 人机两侧必须复用同一 schema 与同一统计服务；发现"前端/文档/Skill 各写一份字段定义"即为可维护性缺陷。

## 4. 数据库与迁移

- **只追加**：不得改写已应用迁移；schema 变更必须新迁移。
- **drizzle 元数据一致性**：`migrations/meta/_journal.json` 与 `migrations/meta/*_snapshot.json` 必须覆盖目录内所有迁移。手写迁移容易漏登记，后果是下一次 `db:generate` 产出重复建表的坏迁移。验证方式：`npx drizzle-kit generate` 在**临时目录**（复制 `migrations/` 与 `meta/`）跑一次，看是否产生非空 diff（2026-09-14 实际发生过）。
- 业务不变量是否落到 CHECK/唯一索引/触发器，而不是只靠应用层：`(workout_id, position)`、`(entry_id, position)`、`cardio_records.entry_id` 唯一、版本>0、计量互斥、`completed` 与必填明细、动作语义在被引用后不可改。
- 事务与并发：写聚合必须在同一 D1 batch 内完成；CAS 必须在事务内原子判定（`src/worker/workouts.ts` 的 `workout_write_guards` + `0001_workout_guards.sql` 触发器）；`batch()` 失败必须整体回滚且不留残留行。
- 参数化与分块：SQL 全参数化；D1 单语句绑定参数上限 100，多行插入必须按列数分块（检查分块边界，例如 `Math.floor(100 / keys.length)` 是否可能为 0）。
- 迁移应用顺序：用 `sqlite3` 在内存库里按文件名字典序执行，确认新迁移与既有迁移不冲突。

## 5. 统计口径（design §5）

- 只统计 `completed` 父与已完成明细；草稿、未完成组、热身（默认）必须排除，并返回排除计数与原因。
- **缺失不是零**：没有有效样本时返回 `null`，速率/配速不得出现 0 或无穷；全 null 聚合（`sum()` 全 NULL 返回 NULL）是历史高发点。
- 容量：按**条目历史快照**计算 `Σ(loadKg × reps × volumeMultiplier)`，自重/辅助/计时/倍率未知/重量缺失不参与；倍率来自动作定义，不由前端猜；重命名动作不得改变统计值。
- 配速/速度：同项目、同 `duration_basis` 的**总时长与总距离之比**，绝不平均逐条配速；游泳用秒/100m；距离缺失或为 0 时 `null`。
- 心率：展示原记录；跨记录汇总是按时长加权的记录均值估计，必须标注定义而不是假装连续采样。
- 规模保护：单次统计明细读取上限 10000，超限 422 `STATS_RANGE_TOO_DENSE`，绝不静默截断。
- 人机同源：人类 API 与 Agent API 必须复用同一服务；同一查询在两个入口的数值必须一致（写一条对比断言）。

## 6. 常见缺陷形态（优先排查）

1. 客户端缺头/缺 body 导致服务端前置条件失败（见 2 节）。
2. 测试辅助函数补齐了真实客户端不会发的头，把协议缺陷藏起来。
3. 手写迁移未进 journal/snapshot，`db:generate` 产出重复 DDL。
4. 聚合 SQL 对空集或全 NULL 的处理（NULL 传染、`json_group_array` 空集）。
5. 版本/CAS 只在预查询里判断，而没写进事务条件。
6. 幂等重放返回的 `meta.requestId`、`replayed` 与实际请求不符。
7. UI 上限与服务端上限不成对（备注长度 × 组数 vs 请求体）。
8. 统计口径的"看起来对"：最大值/记录取错、热身混入、辅助与外加重量混用。
9. 导出/恢复：上限与 `413` 语义、CSV 公式注入、恢复脚本对损坏输入的异常面。
10. 前端状态：乐观锁版本、pending 幂等 key、草稿恢复冲突被静默覆盖。
