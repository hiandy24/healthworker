# Agent 受控创建与批量导入独立审查

报告日期按任务指定为 2026-09-15；本地执行时测试时钟显示 01:55–01:59。本报告是独立代码审查与本地复现记录，不是生产或真实 Access 验收。

## 1. 结论与主 agent judge 建议

- **无确认 P0/P1。建议接受 1 项 P2/L1（Python/Zod 输入契约不一致），1 项 P3/L2（当前文档仍有相反的绝对只读描述）。** P2 建议在批量导入交付前修复；没有证据支持权限绕过、更新/删除能力扩张或本轮已造成生产数据损坏。
- 已实际调用并加载 `healthworker-review` Skill，而非仅凭名称套用流程。先读取实际 AGENTS、完整 design **1.8**、README，再检查实现、测试、API/Skill/deployment 说明及历史发现台账。范围为 design §4.7、§6、§7.1/7.3、§8、§9.3/9.5、A09/A12/A13/A18。
- 七项 baseline 全部通过：**50 TS、55 workerd/D1、29 Python**。另独立 workerd 探针最终 1/1 通过；CLI 独立本地探针通过双进程锁、进程异常中断恢复、确认/输入绑定、Token 切换、23h cutoff。
- `ACCESS_IMPORT_TOKEN_IDS` 使用已验证 JWT 的 common_name 精确匹配；总体 service allowlist 优先；只有精确 Agent POST workouts 放行。原子创建/幂等复用既有服务，没有开放历史更新/删除或动作写入。
- 未运行 git、浏览器、部署、远端 API/数据库操作。没有读取 `.local` 内私有文件内容或秘密值，仅列出文件名；不复核真实 Access 策略。既有测试、产品代码、迁移均未修改。

## 2. 基线与真实结果

Skill 的 `verify-baseline.sh` 内含 git 调用，与本任务禁止 git 冲突，因此**没有直接执行该脚本**；读取脚本后用已安装本地二进制顺序执行同等七项，不运行 format 写入命令。Python 设置 PYTHONDONTWRITEBYTECODE，构建禁用 Wrangler metrics。

| 命令（仓库根目录）                                                   | 结果                                              | 外层计时 |
| -------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| `node_modules/.bin/tsc --noEmit`                                     | exit 0                                            | 2.00s    |
| `node_modules/.bin/eslint .`                                         | exit 0                                            | 2.88s    |
| `node_modules/.bin/prettier --check .`                               | exit 0，All matched files use Prettier code style | 0.69s    |
| `node_modules/.bin/vitest run --config vitest.config.ts`             | 11 files / **50 passed**                          | 9.02s    |
| `node_modules/.bin/vitest run --config vitest.integration.config.ts` | 6 files / **55 passed**                           | 3.53s    |
| `python3 -m unittest discover -s tests/skill -v`                     | **29 tests，OK**（unittest 2.202s）               | 2.28s    |
| `node_modules/.bin/vite build`                                       | exit 0                                            | 3.08s    |

构建主 JS **624.82 kB / gzip 195.40 kB**，Stats **409.55 / 120.51 kB**，CSS **225.33 / 32.92 kB**。存在 >500 kB chunk 警告，不作本范围内性能缺陷。README:18/48 的 27 Python 是旧轮数字，当前为 29；50/55 一致。README 主包 624.80 与当前 624.82 的微小差异不能视为功能问题；建议将各轮测量标明历史，而非再建一个必须时刻同步的重复表。

工作区保护不用 git：开始对 src/tests/skills/migrations/.agents 内既有文件（排除 Python cache）及 AGENTS、README、design、package、lockfile 共 **73 文件**记录 SHA256，结束对拍 **0 既有文件变化**。本次唯一持久新增文件为本报告；build 按用户要求重建被忽略的 dist。未检查或声称 Git tracked 数量。

## 3. 发现项

### HW-2026-09-15-01 · Python 校验与实际 Zod 输入域不一致

- **建议 P2 / L1，主 agent 裁定。** 不是 P1：UUID 反例为异常输入、服务端安全拒绝；整数写法可由转换器修正，不构成所有正常导入必失败。
- **位置**：`/Users/andy/Desktop/Patent/HealthWorker/skills/healthworker/scripts/healthworker.py:56–59`；`/Users/andy/Desktop/Patent/HealthWorker/skills/healthworker/scripts/import_workouts.py:78–80,86,94,97`；`/Users/andy/Desktop/Patent/HealthWorker/src/shared/workouts.ts:15–19,128–155`。
- **现象 A / 实测**：构造空 strength 草稿条目，entry.id=`11111111-1111-0111-8111-111111111111`（版本 nibble 0），exerciseId 使用合成服务返回的有效已匹配动作。通过真实 `hw.main(['plan', ...])` 调用生产 CLI 逻辑：**exit 0、unmatchedExerciseIds=[]、生成 confirmation，POST=0**。同版本 UUID 送入真实 workerd Agent POST：**422**。该差异在业务动作查询前即被 Zod uuid 拒绝，与动作是否存在无关。
- **现象 B / 实测**：空 draft 的 `durationSeconds: 1.0`。真实 loopback 子进程 CLI validate **exit 2**；同 JSON 数字字面量经已签名 service JWT 的 workerd Agent POST **201**。Python `type(value) is int` 不接受 float 表示的整数，而 JSON/JS/Zod `.int()` 按数值判断。
- **先证伪**：使用正常 UUID、null 时长的同一空 draft 作为成功对照；workerd 的 JSON body 显式保留 `1.0` 字面量，排除 Python 序列化提前改成 `1`。另怀疑 Unicode 备注长度计数不一致，2001 个非 BMP 字符实际在两端均接受，因此该假设已排除，不纳入本项。
- **根因**：Python 自行维护第二套输入校验；uuid.UUID 仅检查可解析及规范连字符形式，并未对齐 Zod UUID 格式约束；整数校验比较 Python runtime type 而非 JSON 数值域。
- **影响**：计划的结构校验不能筛出可确定的无效 UUID，用户确认后才服务端失败；含整数浮点表示的合法导出/转换结果被计划前置拒绝。在逐条非原子批次中，后项结构错误可能在前项成功后才暴露。未把这种设计允许的批次非原子性本身列为缺陷，也没有复现或声称数据损坏。
- **最小修复**：集中 Python 输入 UUID 规则并与当前 Zod `.uuid()` 正反例对齐（注意已有 read/restore 兼容性，不贸然收紧所有历史读取）；整数用严格非 bool 的有限数值整数性及同样上下界检查，可在确定规范化规则下保留或统一整数表示。不要放宽服务端 Zod 来迁就客户端。
- **回归建议**：在 `tests/skill/test_import.py` 增加 invalid UUID version/variant、nil/max、大小写、整数 1/1.0/1.5/True 矩阵，并和 `workoutInputSchema.safeParse` 固定相同预期；至少覆盖 workout duration、reps、set duration、heart rate。现有两项 import 测试只用空草稿，未对拍这些结构域。
- **新旧关系**：本次新 importer 的校验/承诺问题，不是旧恢复脚本日期/UUID traceback 项或真实 Access 已知空白。
- **修复验收**：非法 UUID 不得产出可确认有效计划；数值整数表示应与 POST Zod 一致；全部 baseline 及独立对拍重跑。

### HW-2026-09-15-02 · 当前 API 文档保留相反的绝对只读概述

- **建议 P3 / L2 静态确证；未做用户阅读行为测试。** 不是安全边界绕过。
- **位置**：`/Users/andy/Desktop/Patent/HealthWorker/docs/api.md:7–20` 仍写 Agent 仅 GET、workouts 表只列 GET、所有非 GET 405；同文件 :68–70 才说明条件 POST 并声称替代旧文。`/Users/andy/Desktop/Patent/HealthWorker/skills/healthworker/references/api.md:9` 写 All requests are GET，:67 后再推翻。`/Users/andy/Desktop/Patent/HealthWorker/docs/design.md:13,29` 仍为只读介绍，:799 后增加优先增量。CLI 模块 docstring `healthworker.py:2` 仍 read-only，并作为 argparse help description。
- **先证伪**：确实存在明确“1.8 优先/替代旧概述”的补充，故不能声称文档完全遗漏 POST；OpenAPI 和运行时权限已经支持条件创建，README 后段也明确未发布。因此只建议低优先文档整理。
- **影响 / 根因**：采用末尾复制增量而不修改当前权限表，检索/截取前段可得到错误契约，未来维护需猜测哪段权威。
- **最小修复**：直接修正当前权限表和简介为默认只读、条件 POST workouts，并链接一个权威导入段落；历史 review 不回写，历史测量标注轮次。不要为整理文档改变代码权限。
- **修复验证**：搜索绝对只读/All requests are GET/Agent 非 GET 的当前说明，确认每处明确限定“读取命令”或“未授予导入能力的身份”；CLI --help 描述同步。已知台账没有记录本次 1.8 增量造成的这一矛盾。

## 4. 通过项与证伪结果

| 审查项                 | 实际证据与结论                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT 与权限子集         | `auth.ts:87–131` 先 jose 验签/issuer/aud/claims，互斥 human/service，再总体 allowlist，再 importIds 精确 includes；不依赖未验 email 或 CF-Access-Client-Id 头授予导入。baseline m1 的真实 workerd/JWT 流程通过。只 mock JWKS 公钥传输，不 mock authenticate。                                                                                                           |
| 缺省/非法配置          | baseline 动态验证未匹配 Token 405、human 403、伪造 JWT 401、空/逗号/独立星号/内嵌空白配置 503、总体 allowlist 不含该 service 则 403。包含星号的其他字符串不会作通配授权（精确 includes）；本轮没有把非独立星号的配置语法细节上报为权限绕过。                                                                                                                            |
| 精确路由               | `index.ts:74–119` 仅精确 POST `/api/agent/v1/workouts` 免 human Origin；仍要求 JSON。独立 probe 证实尾斜杠、大小写变体、百分号编码变体均不创建；缺 JSON 400。baseline 证明其他 workouts 子路径、exercises/settings/export/unknown 的 POST/PUT/PATCH/DELETE 405。                                                                                                        |
| human API 仍拒 service | baseline m1:272–295 验证 service 对 human metadata/settings/export GET 及 POST/PATCH/PUT/DELETE 403；human 对 Agent 403；混合/未知身份拒绝。local mock 不授予 import capability。                                                                                                                                                                                       |
| principal 幂等         | baseline 证明同 principal/key 重放同 ID，换 service principal 同 key 得不同 ID。独立 signed workerd 并发 POST 两个 201、相同 ID；同 key 改正文 409。`workouts.ts:194–247,414–457` 唯一约束及创建同 D1 batch，冲突回读；不依赖 Python 进程锁保证服务端原子。                                                                                                             |
| 未确认/改输入不写      | 独立真实 CLI 子进程 + loopback HTTP：wrong confirmation exit2、改 notes 后旧计划 exit2，服务端 POST count=0。源码还核对 sourceHash、batchId、origin、items(bodyHash/key)，不是只校验用户传入字符串。metadata GET 可以先发生；“不写”不等于完全不联网。                                                                                                                   |
| process 并发           | 独立启动两个 CLI OS 子进程，首请求在服务器阻塞；第二进程 exit2 IMPORT_LOCKED，POST count=1。锁使用 O_EXCL；不只是同进程单元测试。                                                                                                                                                                                                                                       |
| pending 崩溃恢复       | 首进程发出 POST 后服务端记入合成资源、尚未回响应时 kill。journal 已为 pending；遗留锁确实阻止重跑。确认子进程退出后按文档手动去锁，再跑：同 body/key、meta.replayed=true、两次请求但资源字典仅1；第三次成功重跑零新增 POST。HTTP 服务是合成幂等模型，此项证明 CLI 行为；真实 D1 幂等由前项独立 workerd 证明，未冒称端到端真实 Access。                                  |
| Token 切换             | 独立 `hw.main`+合成 transport：同计划成功一次后更换 Client ID，existing journal principalHash 不匹配，exit2、无第二 POST。Token 仅换 secret 而 Client ID 不变仍同 principal，符合服务端身份语义。计划本身尚无首次写入身份绑定；丢 journal/换计划路径无法全局去重为文档已明确限制，不新增上报。                                                                          |
| 23h cutoff             | 独立将 pending.firstAttempt 设为现在减23h再减1s：exit4、needs_reconciliation、无 POST。源码保留第一次时间，不以每次重试刷新；成功条目直接跳过。未进行真正等待23小时或时钟倒拨实验。                                                                                                                                                                                     |
| 路径/redirect/秘密     | `healthworker.py:106–126,333–365` 只接受裸 HTTPS origin，development 仅 loopback 且不发送继承的 Token；固定 POST 路径，无任意 URL/method CLI。baseline 真实 loopback POST 的307、读取同源/跨源 redirect 均拒绝；错误不输出服务响应正文。新文件0600、journal原子 replace；代码检查输入/写出中的当前凭证，并最终输出脱敏。未读取真实凭证或把合成测试当秘密扫描/生产验收。 |
| 不误报批次成功         | baseline 500 四次同 body/key，失败 exit4/allSucceeded=false；本轮 cutoff同样非零；保存成功必须201、JSON、响应结构和replayed布尔。无证据说明真实 Worker 会返回其他正文冒充已创建。本轮未通过伪造不可能的生产响应把宽松 read validator 单独升级成 P1。                                                                                                                    |
| 动作与边界             | importer 不提供动作 POST；plan 查询未归档动作并按计量模式检查，缺动作阻止 import；服务端重新校验，不依赖旧 plan 绕过归档并发 guard。沿用单训练原子、批次非原子及300组合计限制。                                                                                                                                                                                         |
| Unicode 怀疑已排除     | 临时 workerd 首轮1项失败，是审查者预期错误（期待2001个非BMP字符超限），并非产品失败。实际 Zod接受；修正 probe 预期后通过。两端都接受该备注，不上报假阳性。                                                                                                                                                                                                              |

## 5. 独立探针重建说明

临时文件均已删除，不留永久测试，不修改既有测试。

### workerd

重建 `tests/integration/zz-agent-import-review.test.ts`：参考现有 m1 测试的 applyD1Migrations、RS256 generateKeyPair/SignJWT、仅 JWKS fetch mock 和 production-shaped synthetic bindings。使用本报告第3节空 draft 正文；Agent create 请求**不带 Origin**，带签名 assertion、JSON、固定 Idempotency-Key。

关键断言：正常/Unicode body201；entry UUID版本0的body422；原始字符串中的 durationSeconds 1.0 得201；尾斜杠/大小写/编码变体不得201；缺Content-Type400；Promise.all 同key两次201且ID相同；改notes同key409。运行：

```sh
node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/zz-agent-import-review.test.ts
```

最终输出：`1 passed (1)`，以及 `PARITY unicode both accepted (hypothesis disproved); durationSeconds 1.0 CLI refused / workerd 201; invalid UUID workerd 422`、`AUTH precise noncanonical paths refused; no JSON 400; concurrent same principal key one id; changed body 409`。

### CLI

在 `/tmp` 新建脚本，引用现有 `tests/skill/test_healthworker.py` 的合成 metadata/workout/ENV/response helper，不编辑该文件。启动 ThreadingHTTPServer loopback：metadata authentication=local_mock，能力加workouts:create；exercises/history空页且回显from/to。POST记录原始body/key，以key维护合成资源，使用 Event 在记资源后阻塞响应。

以 `sys.executable healthworker.py --development` 启动真实 plan/import 子进程，输入 README 的单条空 draft。错误确认、改notes先断言POST=0；启动首import待服务端Event，再启动第二个断言IMPORT_LOCKED。kill首进程后确认journal pending和锁残留；确认进程结束手动去锁、释放Event，重跑断言原body/key及资源数1，再跑成功跳过。把firstAttempt改为time.time()-23*3600-1断言needs_reconciliation/exit4/no POST。另 validate durationSeconds=1.0 得exit2。Token切换通过hw.main及synthetic transport，不使用development身份模拟Token；plan后import一次，再改ENV Client ID，断言exit2/no新增POST。

观察输出：

```text
process: wrong confirm/changed input no POST; concurrent second IMPORT_LOCKED; killed process pending persisted; same key/body recovered once; success skipped
cutoff: 23h pending => exit4 needs_reconciliation, no POST
parity unicode CLI exit 0
parity float-integer CLI exit 2
token switch: existing journal refuses changed Client ID, no second POST
invalid UUID version nibble: CLI plan exit 0 unmatched [] POST count 0
```

## 6. 未运行、边界与收尾

- 真实 Access 单 AUD/混合边缘签发、生产 Service Token/撤销、生产导入配置与创建权限未验收；这些是已有明确空白，不列新发现。
- 无 browser/GUI/真机/E2E、p95性能、远端迁移、部署、git 操作；没有读取 `.local` 私有配置来判断线上已具备导入能力。
- 23h仅时间戳模拟；并发是本机两个独立进程；崩溃为kill进程，不是断电/fsync目录耐久性验收。没有证明跨Token或丢journal全局去重，也没有这一设计承诺。
- 现有产品及测试文件SHA256对拍0变化；删除临时 zz test、/tmp复现脚本及日志/manifest目录。baseline数字取自临时探针加入前，最终1项probe单独计数，不混入55。
- 主 agent 优先裁定/修复 HW-2026-09-15-01，并补两端结构矩阵；其次整理 -02。修复时扩散检查日期/时区、其他整数和UUID调用点、read/backup兼容性，不为修复输入预检收紧历史读取或扩大Agent权限。

## 7. 修复状态追加（2026-09-15，实现者验证）

本节追加修复状态，不改变上文独立审查当时的现象、严重度、复现输出或基线数字；不将本次修复自验冒充另一轮独立审查。

- **HW-2026-09-15-01：已修复并补永久回归。** 仅 importer 新增 input_uuid，历史 healthworker.uuid_value/read/restore 不变。严格对齐应用实际共享 Zod：版本 1–8、variant 8/9/a/b，普通 UUID 大小写均可；nil 与小写 max 特例可用，大写 max 拒绝。数值必须为非 bool 的有限 int/float，整数按数学整数性判断，因此 1/1.0 接受，1.5/True/False 拒绝，上下界与 null 语义不变，不放宽后端。
- 同一 `tests/skill/import-parity.json` 矩阵由 Python CLI plan 和 TS workoutInputSchema/strengthSetInputSchema/cardioInputSchema 消费：UUID 覆盖版本/variant 全 nibble、nil/max/大小写/无连字符/非字符串；数值覆盖 workout duration、reps、set duration、cardio duration、平均/最大心率。Python 每个非法样本断言无计划文件、无 POST；合法样本产出 confirmation。另显式保留 float 1.0/1000.0，避免 JSON formatter 将其改写为整数后丢失 Python 类型回归。
- 迭代首轮 TS 矩阵发现大写 max 预期错误：直接顶层 zod 探测接受，但应用 @hono/zod-openapi 的实际 uuid 正则拒绝。按实际共享 schema 修正 Python 和 fixture 后重跑，不改服务端以迎合测试。原报告关于版本0、1.0的事实保留。
- **HW-2026-09-15-02：已修复当前说明。** 当前 design 简介/权限表、docs/api 权限表/认证说明、README、Skill API/数据字典和 CLI --help 统一为普通身份只读、明确导入身份仅额外 POST workouts；读取命令仍 GET 白名单。删除“末尾增量推翻旧概述”的措辞，历史设计变更与旧 review 结论保留。导入详细命令仍集中在 Skill API 的确定批量文件章节。
- 未改变 ACCESS_AUD、认证授权、数据库 schema/迁移、统计口径、历史管理能力或生产配置；未发布远端，无浏览器/真实 Access 验收。

本次修复实测：`npx pnpm@10.34.5 typecheck`、`lint`、`test`（11 files / **51 passed**）、`test:integration`（6 files / **55 passed**）、`build` 全部 exit 0；`python3 -m unittest discover -s tests/skill -v` 为 **30 tests / OK**。`--help` 与 `import --help` 已运行，validate/plan/import 参数仍可用。仅新增两端矩阵各1个测试项，子案例不混算测试数量；构建保留已知 Zod 注释与大 chunk 警告。
