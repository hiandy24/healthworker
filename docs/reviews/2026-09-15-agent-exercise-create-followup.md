# Agent 自动创建缺失动作（create-only）复评审查记录（2026-09-15）

本轮范围：指定 diff 复评。对象是工作区相对 HEAD（`cf620e4 chore: establish validated HealthWorker M2-M4 baseline`）的全部未提交改动，主题为设计 2.0 授权的导入 Agent `POST /api/agent/v1/exercises`（`docs/design.md` §1.2、§9.5、§12.2 A13/A18/A21、变更记录 2.0）。工作区同一 diff 内还包含设计 1.9 的 Skill 私有 JSON 凭证（`client.local.json`）、`docs/deployment.md` 的 1.8 受控创建发布记录、以及 `.agents/skills/healthworker-review` 审查工具修订；这些一并过检，因为它们与被审代码同时落在工作区。上一份中断报告 `docs/reviews/2026-09-15-agent-exercise-create-review.md` 描述的是授权前状态（当时结论是"动作 POST 不放行"），已被 2.0 变更推翻，以当前代码为准。

证据口径：L1 实测复现（真实 workerd/D1 路由或真实命令输出）+ L2 静态确证；未运行项在第 7 节单列。
工作区基线：审查开始时 `git status --porcelain | wc -l = 26`、`git ls-files | wc -l = 100`；收尾时临时文件已删除，仅新增本报告文件（`git status` 27 行，见第 9 节说明）。

## 1. 结论摘要

- **核心并发设计成立，无 P0/P1。** `POST /api/agent/v1/exercises` 的"条件 INSERT + `changes()=1` 写 replay 行 + 幂等行唯一索引兜底 + D1 batch 整体回滚"在全部实测竞态下（同 key 同/异 body、异 key 同名、指定 id 碰撞、到期 replay、归档同名）收敛正确：不重复建名、不重复建 id、**任何失败路径都不留下伪造 replay 记录**（上一轮"EXISTS(id) 条件导致假 replay"缺陷确认已修复）。
- 权限矩阵符合 §9.5：普通 service 对 `POST /exercises` 仍 405、human 访问 Agent 路由 403、导入身份只多这两个精确 POST、PUT/PATCH/DELETE/HEAD/OPTIONS 全 405、local mock 永不获得 `canImport`。
- CLI 导入工作流（声明校验、计划绑定、journal 两区、先动作后训练、任一动作失败即停、23h cutoff、凭证不落盘）与设计一致且有测试覆盖。
- 本轮上报 6 条 **P3**（无阻塞项）：3 条 CLI 预检与服务器 Zod 域漂移（multiplier 边界、trim 语义、归档同名）、1 条 Agent OpenAPI 缺条件权限描述、1 条 README/部署文档生产状态叙述互相矛盾、1 条 m1 405 矩阵收窄。全部为 fail-stop 或文档层问题，服务器 Zod 始终是最终裁决者，不会造成错误数据落地。

## 2. 验证记录（真实输出）

| 命令                                           | 结果                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npx pnpm@10.34.5 typecheck`                   | 通过                                                                                                                 |
| `npx pnpm@10.34.5 lint`                        | 通过                                                                                                                 |
| `npx pnpm@10.34.5 format:check`                | 通过                                                                                                                 |
| `npx pnpm@10.34.5 test`                        | 11 files / 51 passed                                                                                                 |
| `npx pnpm@10.34.5 test:integration`            | 6 files / 55 passed（不含临时 zz 复现）                                                                              |
| `python3 -m unittest discover -s tests/skill`  | Ran 47 tests / OK                                                                                                    |
| `npx pnpm@10.34.5 build`                       | 通过（Stats 409.55 kB / gzip 120.51 kB、index 624.99 kB / gzip 195.48 kB；既有 Zod `@__PURE__` 与大 chunk 警告保留） |
| `git diff --check`                             | 通过（无输出）                                                                                                       |
| 临时并发复现 `zz-exercise-concurrency.test.ts` | 9 场景全部符合预期（第 3 节引用，已删除）                                                                            |
| `/tmp` 仓库副本内 `drizzle-kit generate`       | `No schema changes, nothing to migrate`（0002 无 snapshot 不破坏生成）                                               |

与文档声明对拍：任务描述中的"单测 51、集成 55、Python 47"与实测一致；`README.md` 1.9 段落的历史数字"46 tests"是 1.9 时点记录，与当前 47 不冲突。

## 3. 发现项

| ID                | 严重度 | 位置                                                    | 现象                                                                    | 状态     |
| ----------------- | ------ | ------------------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| HW-2026-09-15-F01 | P3     | `skills/healthworker/scripts/import_workouts.py:93`     | CLI 声明计量校验接受服务器拒绝的 volumeMultiplier                       | 本轮上报 |
| HW-2026-09-15-F02 | P3     | `skills/healthworker/scripts/import_workouts.py:80`     | CLI 名称/别名不 trim，与服务器 Zod `.trim()` 漂移                       | 本轮上报 |
| HW-2026-09-15-F03 | P3     | `skills/healthworker/scripts/import_workouts.py:172`    | 计划阶段同名检查只看未归档动作，漏掉归档同名                            | 本轮上报 |
| HW-2026-09-15-F04 | P3     | `src/worker/exercises.ts:144`                           | Agent OpenAPI `POST /exercises` 无条件权限描述；key 校验比 /workouts 宽 | 本轮上报 |
| HW-2026-09-15-F05 | P3     | `README.md:16`、`README.md:156`、`docs/deployment.md:3` | README 权限句未更新 + 生产状态叙述与新增部署记录互相矛盾                | 本轮上报 |
| HW-2026-09-15-F06 | P3     | `tests/integration/m1.test.ts:266,275`                  | PUT/PATCH/DELETE 405 断言从 5 路径收窄到 1 路径；409 未断言错误码       | 本轮上报 |

### HW-2026-09-15-F01 · CLI 声明动作 volumeMultiplier 域与服务器不一致

- **严重度 / 信任级别**：P3 / L1 实测复现（服务器侧）+ L2 静态确证（CLI 侧）
- **位置**：`skills/healthworker/scripts/import_workouts.py:93-95`；`src/shared/exercises.ts:47-53`、`src/shared/contracts.ts:22-23`（`minMultiplier 0.001`、`volumeMultiplier 1000`）
- **现象**：CLI 对声明动作的 `volumeMultiplier` 只校验 `> 0` 且有限（`import_workouts.py:93-95`），而服务器 `exerciseInputSchema` 要求 `0.001–1000`。实测：`zz` 探针对 `POST /api/agent/v1/exercises` 发 `volumeMultiplier: 0.0005` 与 `2000` 均返回 422。
- **复现**：`tests/integration/zz-exercise-concurrency.test.ts`（已删除）→ `PROBE multiplier 0.0005: 422  2000: 422`；重建方式见第 9 节。
- **影响**：plan/validate 通过一个用户确认后必然在 import 首个动作上 422 失败（journal `failed`、后续训练 `not_attempted`、退出码 4）。fail-stop、无数据落地，但违背"本地结构/计量检查"的预期（`references/api.md` 已声明"POST 仍会重新执行共享 Zod"，部分缓解）。
- **根因**：CLI 重写域检查时遗漏 `NUMERIC_LIMITS` 上下界。
- **最小修复**：`import_workouts.py:93` 增加 `0.001 <= body['volumeMultiplier'] <= 1000`。
- **回归测试建议**：`tests/skill/test_import.py` 增加边界用例（0.0005 / 1000.001 拒绝，0.001 / 1000 通过）；现有测试只覆盖合法值，抓不到域漂移。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：重跑该 Python 测试 + 服务器 422 行为不变。

### HW-2026-09-15-F02 · CLI 名称/别名不做 trim，与服务器 `.trim()` 漂移

- **严重度 / 信任级别**：P3 / L1 实测复现
- **位置**：`skills/healthworker/scripts/import_workouts.py:80-83`（`bool(name)` + `bounded_text`，不 trim）；`src/shared/exercises.ts:6-7`（`z.string().trim().min(1).max(200)`）
- **现象**：实测 `POST /exercises` name=`'  ZZ padded name  '` 返回 201 且落库名称为 `ZZ padded name`（服务器 trim）；name=`'   '`（纯空白）返回 422，但 CLI 结构检查接受（`bool('   ')` 为真、无控制字符）。
- **复现**：同上 zz 探针 `PROBE padded name: 201 "ZZ padded name"`、`PROBE blank name: 422`。
- **影响**：两类 fail-stop 后果——(a) 纯空白名称通过 plan、import 时 422；(b) 计划阶段 `import_workouts.py:176` 的服务器同名比对用未 trim 字符串，`' Row '` 对已存在 `'Row'` 不会拦截，import 时服务器按 trim 后名称判定同名 → 409 `EXERCISE_EXISTS`。无数据损坏。
- **根因**：TS schema 用 `.trim()` 归一化，Python 侧未镜像。
- **最小修复**：CLI 对 name/aliases 先 `strip()` 再非空/长度判断，服务器同名比对同样用 strip 后的值（或在结构校验处直接拒绝首尾空白）。
- **回归测试建议**：`tests/skill/test_import.py` 增加 `'  名称  '` 与 `'   '` 的拒绝/归一用例。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：重跑 Python 测试；zz 探针服务器行为不变。

### HW-2026-09-15-F03 · 计划阶段同名检查不含归档动作

- **严重度 / 信任级别**：P3 / L1 实测复现
- **位置**：`skills/healthworker/scripts/import_workouts.py:172`（`client.pages('exercises', {'includeArchived': 'false'}, ...)`）、`:176`（同名比对）；服务器 `src/worker/exercises.ts:234`（`WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name=?)` 无归档过滤）
- **现象**：实测将已建动作归档后，再以同名 `POST /exercises` 返回 409 `EXERCISE_EXISTS`（服务器按全部名称裁决）；但 CLI 计划阶段只拉取未归档动作，声明一个与**归档**动作同名的定义会通过 plan。
- **复现**：zz 探针 `PROBE archived-name create: 409 EXERCISE_EXISTS`。
- **影响**：用户确认计划后 import 在首个动作 409 失败（fail-stop、journal 记录、训练不尝试）。设计 §9.5 要求"名称不得与服务器或批次内重复"，服务器语义包含归档，CLI 预检遗漏归档子集。
- **根因**：动作匹配表必须排除归档（归档动作不能被新训练引用），同名查重却复用了同一份未归档列表。
- **最小修复**：plan 阶段额外用 `includeArchived=true` 拉全量做同名比对（或单独一次按名称查询）。
- **回归测试建议**：`tests/skill/test_import.py` 的 transport 返回一个归档动作，断言 plan 拒绝同名声明；现有测试只有未归档同名用例。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：重跑 Python 测试。

### HW-2026-09-15-F04 · Agent OpenAPI `POST /exercises` 缺条件权限描述，key 校验与 /workouts 不一致

- **严重度 / 信任级别**：P3 / L1 实测复现
- **位置**：`src/worker/exercises.ts:144-162`（无 `description`）；对照 `src/worker/workouts.ts:677-687`（有条件权限描述 + `idempotency-key` `.regex(/^[\x21-\x7e]+$/)`）
- **现象**：实测 `/api/agent/v1/openapi.json` 中 `POST /workouts` 的 description 为"Agent: only verified services explicitly granted workouts:create; …"，而 `POST /exercises` 的 `description`/`summary` 为空（`{}`）。另外 `/workouts` 的 key 头校验限可打印 ASCII（`:682-687`），`/exercises` 仅 `min(1).max(200)`（`exercises.ts:149`），服务器对后者接受含空白/非 ASCII 的 key（Python CLI 的 `[!-~]{1,200}` 不会发送这类 key）。
- **复现**：zz 探针输出两段 openapi description 对比。
- **影响**：设计 §9.5 要求"OpenAPI 描述条件权限，不泄 Client IDs"；文档消费者（含 Skill 的 openapi 白名单校验）只能看到无说明的 POST。key 域不对称是接受面超集，无安全后果，但属同类契约不一致。
- **根因**：新路由照抄了骨架但没带 workouts 路由的描述与 key 正则。
- **最小修复**：为 agent `POST /exercises` 补 description（措辞同 workouts，提及仅导入授权身份可用）；key 头加同样的 printable-ASCII 正则。
- **回归测试建议**：`m1.test.ts` openapi 断言中要求两个 POST 均含非空 description；现有断言只查方法名集合。
- **与已知缺口的关系**：新缺陷。
- **修复验证方法**：重跑 m1 openapi 测试。

### HW-2026-09-15-F05 · README 生产/权限叙述漂移且与新增部署记录矛盾

- **严重度 / 信任级别**：P3 / L2 静态确证（**未运行**远端核验，本轮禁止生产请求）
- **位置**：`README.md:16`（"导入 allowlist 身份仅额外 POST workouts"）、`README.md:156`（"线上仍为旧只读 Agent 版本，受控导入与 Skill 私有配置增量仅本地完成，未发布"）；对照 `docs/deployment.md:3-13`（新增"受控 Agent 创建更新实测（2026-09-14 UTC）：已将审查修复后的受控创建实现更新至现有生产 Worker……现有导入 Client ID 的精确授权配置已随版本发布"）
- **现象**：同一工作区内两处事实声明冲突——deployment.md 新增段落声称 1.8 受控创建（含 `ACCESS_IMPORT_TOKEN_IDS` 授权）已于 2026-09-14 UTC 发布到生产（100% 流量），而 README 保留段落仍声称"线上仍为旧只读 Agent 版本……未发布"。另外 `README.md:16` 的权限句未随 2.0 更新（仍写"仅额外 POST workouts"）。design.md 实现状态行（第 6 行）也只提"首次生产部署"。
- **影响**：AGENTS.md §5 要求"如实报告……不把未部署代码说成已上线"；反向同样成立——已部署能力被 README 说成未上线，复评者与用户无法从 README 判断真实生产状态。2.0 的 exercises:create 仍属未发布（deployment.md 该段测试数字为 1.8 时点 39 项 Python），这一点两份文档一致。
- **根因**：发布记录追加进 deployment.md 后未回头修订 README/design 的生产状态句；README:16 是 1.7 遗留句。
- **最小修复**：统一生产状态叙述（README:156 改为引用 deployment.md 最新实测段；README:16 补 `POST /exercises`），或按仓库惯例在新段落中显式作废旧句。
- **与已知缺口的关系**：known-gaps.md "未部署，M5 未做" 一行需同步现场核验后更新状态（该文件属审查工具，非产品文档）。
- **修复验证方法**：文档 diff 审阅；远端核验需单独授权，不在本轮范围。

### HW-2026-09-15-F06 · m1 405 矩阵收窄、409 断言不校验错误码

- **严重度 / 信任级别**：P3 / L2 静态确证（行为未变已由实测佐证）
- **位置**：`tests/integration/m1.test.ts:266-275`（旧代码对 `['PUT','PATCH','DELETE','POST'] × ['/settings','/export','/unknown','/exercises','/workouts/{id}']` 全组合断言 405；新代码只对 4 个路径断言 POST、对默认路径 `/workouts` 断言 PUT/PATCH/DELETE）；`m1.test.ts:352,360,369`（三个 409 只断言状态码）
- **现象**：PUT/PATCH/DELETE 的 405 回归网从 5 路径缩到 1 路径；409 用例不区分 `IDEMPOTENCY_CONFLICT` / `EXERCISE_EXISTS` / `EXERCISE_ID_EXISTS`。实测当前行为正确（zz 探针三个 409 码均正确；`m1.test.ts:380-393` 对 `/api/agent/v1/metadata` 的 POST/PATCH/PUT/DELETE/HEAD/OPTIONS 仍全 405；门条件 `index.ts:74-88` 是统一的 method+path 判断），因此这是覆盖收窄不是功能回归。
- **影响**：若未来门条件被改成按路径白名单放行（例如误把 `PATCH` 加进 importCreate），现有测试可能仍绿。
- **最小修复**：恢复 `PUT/PATCH/DELETE × 多路径` 循环（含 `/exercises`），409 断言补 `error.code`。
- **回归测试建议**：即上述断言本身。
- **与已知缺口的关系**：新缺陷（修复面扩散检查发现）。

## 4. 已核实无问题（修复方无需重复排查）

并发与幂等（A，全部 L1，zz 探针 + 既有 m1 测试）：

- **`changes()=1` 门控在 D1 batch 内生效**：`exercises.ts:232-270` stmt1 插入 0 行时 stmt2 不写 replay 行。证据：异 key 同名 409 后两个 key 的幂等行计数 `[1,0]`；输家同 body 重试仍 409 `EXERCISE_EXISTS`，绝不出现 201 假 replay。
- **幂等行唯一索引兜底同 key 异 body 竞态**：`schema.ts:252-257` `idempotency_principal_scope_key`；并发同 key 异 body 实测 `[201, 409 IDEMPOTENCY_CONFLICT]`，输家名称计数 0（stmt1 已插入但随 stmt2 唯一冲突整体回滚；D1 batch 失败回滚语义另由 `m1.test.ts:44-60` 直接证明），该 key 只有一条幂等行。
- **主键冲突整体回滚**：异 key 异名同指定 id 实测 `[201, 409 EXERCISE_ID_EXISTS]`，输家名称未落地、无幂等行；409 码按 replay→name→id 顺序正确裁决（`exercises.ts:275-294`）。
- **同 key 同 body 并发与重放**：两个 201 同 id、单行动作、单行幂等记录，`meta.replayed` 正确；顺序重放 201 replayed 且不新增行。
- **到期 replay 不复活**：把幂等行时间戳改到过去后同 key 同 body 请求 409 `EXERCISE_EXISTS`，旧行不更新（`expires_at>?` 过滤 + `changes()=0`）。期间还实测 `idempotency_response` CHECK（`expires_at>created_at`、2xx）在库层生效。
- **谓词绑定/原子性**：两条 INSERT 全参数化；预检 `lookup()` 只是快路径，裁决全部在事务内条件（`WHERE NOT EXISTS` / `changes()=1` / 唯一索引 / 主键），无"先查后写"窗口。
- `exercises` 表无 INSERT 触发器（`0001_workout_guards.sql` 仅 `BEFORE UPDATE ON exercises` 与 guard 表触发器），`changes()` 计数不受干扰。

权限矩阵（B，L1）：

- 普通ervice（`ACCESS_IMPORT_TOKEN_IDS` 未配置或不含本 CN）`POST /exercises` → 405 `METHOD_NOT_ALLOWED`（zz 探针 + `m1.test.ts:288-295`）；human token → 403（`m1.test.ts:296-302`）；混合/伪造身份 403/401（`m1.test.ts:395-433`）。
- 导入身份仅多 `POST /workouts` 与 `POST /exercises` 两个精确路径（`index.ts:74-78`）；`POST /settings` `/export` `/unknown` `/workouts/{id}` 405；Agent 面 PUT/PATCH/DELETE/HEAD/OPTIONS 405（`m1.test.ts:380-393`）；路径含 `//`、`%2f` 等直接 400（`index.ts:36-43`），百分编码路径只会让门更严不会更宽（fail-closed 方向）。
- JSON `Content-Type` 对 importCreate 强制（`index.ts:102-120`）；`Idempotency-Key` 由路由 schema 强制（缺失 400）。
- local mock 不授导入：`auth.ts:36-39` 早退且从不调用 `onImport`，`canImport` 保持 `undefined`，`importCreate` 要求 `=== true`（`index.ts:76`）。
- `ACCESS_IMPORT_TOKEN_IDS` 空/空项/星号 503 fail closed（`auth.ts:57-60` + `m1.test.ts:220-228`）；service 总 allowlist 先于导入判定（`auth.ts:114-122`）。
- metadata capabilities 仅实际导入身份含 `exercises:create`/`workouts:create`（`index.ts:186-191`），human 面不变，不泄 Client ID。
- human `POST /api/v1/exercises` 仍走 drizzle 无名冲突插入（人类保留同名能力，`exercises.ts:299-327`），Agent 创建固定 `isBuiltin=false`、`archivedAt=null`（`exercises.ts:212-220`）。

CLI 安全（C）：

- UUID 域完全对齐：`import_workouts.py:14-21` 正则与 zod 4.6.4 `z.string().uuid()`（含 nil/max UUID、版本 1–8、大小写、max 仅小写的边角）逐字符一致（node 实测 + `node_modules/.pnpm/zod@4.6.4/.../regexes.js:27`）。
- 声明注入 `definitions` 后的计量匹配正确：kind 必须相等，strength 按 `measurementMode`（reps/duration 互斥置空）与 `resistanceMode`（assisted 互斥、external/assisted 完成组必填负重）检查（`import_workouts.py:182-196`）；未声明未匹配的 exerciseId 阻断导入（`:220`）。
- 计划绑定完整：`sourceHash`（全量 canonical JSON SHA256）、`batchId`、`origin`、逐训练 `sourceId/bodyHash/key`、逐动作 `createExercises(id/name/bodyHash/独立key)`、confirmation 摘要；import 逐一重算比对（`:203-227`）。
- journal 语义：每条尝试前持久化 `pending`（`:255-256`）；success 跳过零 POST（`:247-248`）；任一动作失败 `break`、后续训练 `not_attempted`（`:266-276`，实测仅 1 个动作 POST）；训练逐条独立、失败退出码 4、`atomicBatch=false`（`healthworker.py:638`）；`firstAttempt` 超 23h → `needs_reconciliation` 且不发 POST（`:251-254`，Python 测试覆盖）；旧版 journal 缺 `exerciseResults` 分区时 `setdefault` 迁移（`:241`）。
- 凭证不落盘：plan/journal 新文件 `O_EXCL 0600`、journal 原子替换（tmp+`os.replace`）、单执行锁（`IMPORT_LOCKED`）；`load`/`save` 均做凭证子串拒绝；输出脱敏覆盖 JSON 来源凭证（`healthworker.py:630-637` + `test_healthworker.py::test_json_secret_default_path_and_redaction`）；投毒 journal 回读被拒（`test_import.py` poisoned journal 用例）。
- 1.9 配置面：`client.local.json` 精确 gitignore（`.gitignore:26`）+ prettierignore；默认缺失保留 env-only、显式缺失/权限不安全/未知字段 fail closed；环境覆盖不得跨 origin；`--development` 不发凭证；help/模块导入不读配置（`healthworker.py:353-400` + ConfigTests 全组实测通过）。父目录检查从 `==0700` 放宽为"非 group/world 可写"是 1.9 授权的 documented tradeoff（design §9.3）。

契约一致（D，除 F01/F02/F04 外）：

- 409 错误码名称四处一致（`exercises.ts:194,284,293`、`docs/api.md`、`skills/healthworker/references/api.md`、data-dictionary）；可选 `id` 字段、`createExercises` 结构在 TS/Python/docs 一致；`capabilities` 枚举 `src/shared/contracts.ts:104` 与文档一致。
- Python CLI openapi 白名单允许 `/workouts`、`/exercises` post（`healthworker.py:191`）与服务器两面前一致；`_request` 对 POST exercises 响应按 `validate_exercise` 全字段校验并要求 `meta.replayed`（`healthworker.py:480-484`）。
- `z.string().uuid()` 域与 Python 写域一致（见上）；exerciseInput 顶层 strict（`measurementSchema z.strictObject`），与 CLI 精确字段集一致。

迁移与仓库规则（F）：

- `migrations/0002_exercise_name_unique.sql` 为无 DDL 的追加占位（`PRAGMA foreign_keys=ON`），已登记 journal idx 2；未改写 0000/0001；`drizzle-kit generate` 在 /tmp 副本实测 `No schema changes, nothing to migrate`——无 0002 snapshot 不破坏后续生成（0002 无 DDL，快照链等价 0001）。集成测试真实应用三份迁移通过。
- 源码/测试/文档无真实凭证、audience、域名（deployment.md 的域名是设计文档既有公开信息）、真实训练数据；测试数据全部合成。

## 5. 架构与数据安全设计核对（按 `playbook-architecture.md`）

| 写路径                                        | 版本 CAS        | 幂等                              | 原子性                                          | 结论                                                                           |
| --------------------------------------------- | --------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /workouts`（Agent）                     | 不适用          | `Idempotency-Key`，24h            | 单 batch + guard                                | 与基线一致（本轮未改）                                                         |
| `POST /exercises`（Agent，新）                | 不适用          | `Idempotency-Key`，24h            | 单 batch：条件 INSERT + `changes()=1` replay 行 | **一致**（zz 探针 9 场景 L1；唯一索引 `(principal,scope,key)` 兜底并发同 key） |
| `POST /exercises`（human）                    | 不适用          | —（人类接口非幂等，历史上即如此） | 单条 drizzle insert                             | 与基线一致                                                                     |
| `PATCH /exercises/{id}`                       | `If-Match` 必须 | —                                 | 条件 UPDATE + 触发器                            | 与基线一致（未改）                                                             |
| `PUT/PATCH/DELETE workouts`、`PATCH settings` | 有              | —                                 | batch+guard/单条 CAS                            | 与基线一致（未改）                                                             |

- B 不变量闭合：agent 动作创建的单行不变量（非内置/未归档/version=1）在 INSERT 字面量内闭合；语义 CHECK 在库层（`schema.ts:56-70`）。单一写入者：`exercises` 写入口 = human POST（drizzle）、agent POST（条件 SQL）、PATCH（更新），无第二入口。
- C TOCTOU：判定位置全部在事务内条件；预检只影响快路径。失败残留：动作路径无 guard 表残留问题；幂等行只随成功动作写入。
- D 约束分层：同 key 并发由库层唯一索引最终裁决（应用层 pre-check 只是优化）——这正是本轮并发正确性的最后一道防线，实测成立。
- E 幂等重放语义：返回原始 body + 当前 `requestId` + `replayed:true`（与 workouts 一致，HW-2026-09-14-07 修复面未回归）。
- F 架构漂移：`exerciseRoutes(agent)` 在注册 agent POST 后 `return`，human 专属路由不进 Agent 面；无静默扩权（`importCreate` 精确双路径）。Skill 未重复实现统计；`src/web` 未动。

## 6. 验收覆盖真空（对照 design §12.2，仅列涉及项）

| 编号            | 状态          | 证据 / 缺口                                                                                               |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| A09             | 部分覆盖      | 训练创建幂等既有测试；动作创建幂等/并发现由 zz 探针覆盖（临时），**未沉淀为永久测试**                     |
| A13             | 部分覆盖      | m1 权限矩阵 + zz 探针（local workerd）；真实边缘 Access 未验收（known-gaps）                              |
| A18             | 部分覆盖      | Python 离线合成 transport 测试 47 项；真实 Service Token 导入未执行（deployment.md 自述缺 Client Secret） |
| A21             | 未变化        | 本轮未改动动作引用/归档并发路径（既有测试）                                                               |
| A12/A16/A17/A20 | 无变化/无证据 | 见 known-gaps.md，不重复上报                                                                              |

## 7. 阻塞与未运行项

- 真实 Cloudflare Access（OTP/Service Token）、真实边缘身份分类、生产 `POST /exercises`、生产导入均未验收；本轮零远端请求。F05 的生产状态矛盾只能静态确证，远端核验需单独授权。
- workerd/miniflare 的 D1 写串行化不等价于生产 D1 全局串行行为；但本设计的正确性只依赖"batch 事务原子 + 库层唯一索引/主键"这两个 D1 文档化语义，不依赖预检时序，因此结论对生产成立（L2 推理 + L1 本地佐证）。
- 无浏览器/E2E/性能测量；`--development` local mock 无导入能力，不作为验收。

## 8. 建议处理顺序

1. （可选先行）F05：统一 README/design 与 deployment.md 的生产状态叙述，避免"已上线/未上线"并存。
2. F01+F02+F03 一并修 `import_workouts.py` 声明校验（multiplier 边界、trim、归档同名），补对应 Python 边界测试。
3. F04：`exercises.ts` agent POST 补 description 与 key 正则，m1 openapi 断言跟进。
4. F06：恢复 m1 405 全路径矩阵与 409 错误码断言；并把 zz 探针中的并发场景（尤其"异 key 同名不产伪造 replay 行"与"到期不复活"）沉淀为永久集成测试。
5. 以上均为 P3，可合并成一轮小改；无阻塞项。

## 9. 复评指引

- 本轮临时复现：`tests/integration/zz-exercise-concurrency.test.ts`（**已删除**）。重建方式：复制 `.agents/skills/healthworker-review/assets/repro.integration.test.ts` 到 `tests/integration/zz-exercise-concurrency.test.ts`，按第 3 节各 F 项与第 4 节并发清单改写断言（9 个场景：同 key 同/异 body、异 key 同名、异 key 同 id、归档同名、非导入 service 405、到期 replay、padded/blank 名称、multiplier 边界、openapi description），运行 `npx pnpm@10.34.5 test:integration -- tests/integration/zz-exercise-concurrency.test.ts`。关键探针输出已摘录在各发现项"复现"字段。
- `/tmp/hw-drizzle-check`（drizzle generate 验证用仓库副本，符号链接 node_modules）已删除。
- 复评时逐条核对 F01–F06；修复面扩散检查清单：`src/worker/exercises.ts` agent handler（对照 workouts.ts 幂等实现）、`index.ts` importCreate 门条件相邻的 Origin/Content-Type 分支、`healthworker.py` `_request` POST 响应校验与 `create_exercise`、`import_workouts.py` plan/journal 两区共享的 `attempt()`、m1 的 405/409/openapi 断言组、`migrations/meta/_journal.json` 与后续 `db:generate`。
- 工作区收尾：`git status --porcelain` = 27 行 = 原基线 26 行 + 本报告；`git ls-files` = 100；zz 与 /tmp 产物已删。
