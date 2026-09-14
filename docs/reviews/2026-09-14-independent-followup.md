# 独立复评与分层扩散检查（2026-09-14）

这是独立代码审查证据，**待主 agent judge，不是最终裁定或验收报告**。范围：完整复评 `session-2026-09-14.md` 的 9 个修复点，核对 known-gaps 中 12 个稳定 ID，并对全仓各层相邻调用、错误路径、契约做静态检查和有选择的动态证伪。设计基线 1.4，§§3–12、A01–A21。

实际通过工具调用 `Skill('healthworker-review')` 加载；已完整阅读 AGENTS、design、README、docs/api、m2/m3/m4/session reviews、known-gaps、三份 playbook、report-template、verify 脚本和 repro 模板。当前独立执行上下文没有创建嵌套 subagent 的接口，不虚称另行指派；结论回交协调主 agent。未使用浏览器、真实 secrets、生产资源、Git 提交/推送或全局配置。

## 1. 摘要

- Session 声明的 **9 个窄义修复均获现有回归测试与实现支持**；但旧 HW-2026-09-14-11 仅修了 UUID 类型，时间字段异常面与 exportedAt 校验仍在，不能把它整体关闭。
- 新候选：HW-2026-09-14-13 数值边界可持久化后令有氧统计 500（建议 P1/L1，极端输入、单用户可修复，不是权限绕过或不可恢复损坏）；-14 历史默认范围跨 UTC 午夜的游标失效（P2/L2，未运行）；-15 动作查询格式错误返回 422 而非 400（P2/L1）；-16 部署文档 bundle 数值陈旧（P3/L1）。严重度和是否必修均待主 agent 裁定。
- 无确认的 P0。不把已知 GUI/Access/M5、性能、导出预算、512 KiB 组合上限当新缺陷。没有证据证明上述新候选是 session 修复引入：仓库 0 tracked，无可信提交 diff。

## 2. 真实验证记录

环境：Node v24.15.0、Python 3.14.4、pnpm 10.34.5、Vitest 4.1.11。基线脚本实际路径 `.agents/skills/healthworker-review/scripts/verify-baseline.sh`，不是根目录 scripts 下的同名文件。

首次执行 `bash .agents/skills/healthworker-review/scripts/verify-baseline.sh --keep-logs`，2026-09-14T05:11:00Z，退出 0、7/7 通过：

| 命令                                             | 实际结果                                             |
| ------------------------------------------------ | ---------------------------------------------------- |
| `npx pnpm@10.34.5 typecheck`                     | 通过，4 秒                                           |
| `npx pnpm@10.34.5 lint`                          | 通过，5 秒                                           |
| `npx pnpm@10.34.5 format:check`                  | 通过，2 秒                                           |
| `npx pnpm@10.34.5 test`                          | 11 文件 / 49 测试通过，脚本 11 秒                    |
| `npx pnpm@10.34.5 test:integration`              | 5 文件 / 49 测试通过，脚本 5 秒                      |
| `python3 -m unittest discover -s tests/skill`    | 27 测试通过，unittest 1.643 秒                       |
| `npx pnpm@10.34.5 build`                         | 通过，4 秒                                           |
| `git diff --check`                               | 通过，但 0 tracked，覆盖有限                         |
| 独立 `zz-independent-followup.test.ts`           | **额外** 1 文件 / 2 测试通过；不是把基线写成 51      |
| `/tmp/healthworker-independent-restore-probe.py` | 3 个 subprocess 场景断言通过；不是新增 3 个 unittest |

构建：主 JS 623.87 kB / gzip 195.20 kB；Stats 409.55 / 120.51；CSS 225.33 / 32.92；Workouts 56.98 / 20.05；Exercises 55.55 / 20.01；Settings 6.95 / 3.38；ErrorNotice 46.85 / 14.66；DateInput 37.96 / 10.00；confirm 0.32 / 0.27；HTML 0.47 / 0.32。

与 README/session 的 49/49/27 和主要 bundle 数值一致。历史 M2–M4 的 33/46 是历史轮次，不作为漂移。README/session 所述当时 format 阻塞本次已不再出现，历史记录无需改写。部署文档仍写“本轮生产 build”旧数值，见 -16。上游 PURE、主块 >500 kB 警告不是新发现。

### 测试清单与边界

本次两类测试不是相互替代：现有回归证明修复，独立探针尝试证伪相邻边界。

| TS 单元/组件文件       | 数量 | 实际覆盖                                                                                                |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| workouts.test.ts       | 7    | strict 完成约束、计量互斥、effort、伪造快照、重复 ID、50/50/300、心率                                   |
| foundations.test.ts    | 5    | 克/公斤/null、日期 DST、计量 strict、合成 JWT 签名/issuer/expiry/audience/owner、mock 隔离              |
| session-review.test.ts | 8    | bodyless DELETE/POST/PUT/PATCH 四例、UTF-8 上限、0/101 列二例、quality 键                               |
| restore.test.ts        | 1    | 实际 Python/新 SQLite、1500 容量、ID/备注/引用、拒覆盖/坏输入/remote                                    |
| app-shell.test.ts      | 1    | sm/768 布局静态断言，不是视口验收                                                                       |
| web-export.test.ts     | 2    | Blob 附件、CSV 参数、HTML/附件类型拒绝                                                                  |
| web.test.ts            | 7    | 复制、pending 草稿、损坏/过期、HTML/412/schema、完成校验、网络重放、恢复选择                            |
| web-stats.test.ts      | 2    | null/0、范围/质量/空明细渲染                                                                            |
| cloud-theme.test.ts    | 6    | dark/auto/light 三例、失败重试、设置保存、全部中文 quality 标签                                         |
| migrations.test.ts     | 1    | 临时目录真实 Drizzle generate 无漂移、新 SQLite 全迁移/3 trigger/index/CAS/FK                           |
| web-review.test.ts     | 9    | 五字段迁移、独立实例、标量恢复、strict PATCH、导航 blocker、字段错误、DST、草稿所有权、大中文输入不冻结 |

| workerd/D1 文件   | 数量 | 实际覆盖                                                                                                                                                                                                                                                            |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exercises.test.ts | 3    | CAS/语义保护、稳定游标/归档/Agent 同源、strict 创建                                                                                                                                                                                                                 |
| m1.test.ts        | 12   | FK、seed 不覆盖、batch 回滚、排序/CHECK/级联、全部 malformed JSON、metadata、OpenAPI security、Agent 非 GET、JSON404、Origin/JSON、body limit、生产 fail closed                                                                                                     |
| m4.test.ts        | 4    | settings 纯读与首次/并发 CAS、完整 JSON/CSV、Agent 无管理、字节预算超限                                                                                                                                                                                             |
| stats.test.ts     | 12   | all-null 距离、10001 有氧明细拒绝、旧不完整子记录、1500/倍率、排除原因、辅助同阻力、320 总量比/心率、零距离/游泳/骑行、混合去重/桶、DST、空/Agent 同源、metadata/OpenAPI                                                                                            |
| workouts.test.ts  | 18   | 幂等归档交错、年份、混合聚合/备注、并发重放/更新删除后原响应、CAS/delete、历史快照、300 组、晚期碰撞回滚、游标、字段/幂等校验、引用竞争、stale guard、50条目300组/异正文 key、空草稿/版本、Agent 面、真实客户端 DELETE/当前 requestId、定向 guard 清理、中文体积413 |

Python 27 项均运行：metadata headers/timeout；配置拒绝脱敏；dev 去凭证及模式；版本/能力预检；status/redirect/HTML 不重试；非法 JSON/content/schema；network/429/5xx 有界重试；TLS 不重试；Retry-After；参数白名单；日期边界；stats 透传；nested stats/context；cardio nested 拒绝；cardio 合法维度；顶层 nullable 必须存在；metadata 时区；notes 显式；分页 records cap/resume；分页 pages cap/empty；坏分页无部分输出；分页日期钉住；OpenAPI/写路径拒绝；输出脱敏；真实本地 stdlib transport smoke；真实同/跨源 redirect 拒绝；真实 HTML/体积限制。

不是完整输入空间证明；未新增/削弱任何既有测试。签名 JWT 是合成密钥，真实 Access 验收仍无证据。

## 3. 旧项逐项复评

沿用 known-gaps 稳定 ID（session 表本身无 ID）。L1 指本次重跑到对应现有回归，不等于新写的独立测试。

| ID（HW-2026-09-14-） | 当前状态                                 | 证据与相邻扩散                                                                                                                                                                                     |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01                   | 已修复，L1                               | lib.ts:38–44 按 method 设置 JSON；workouts.test.ts:676–730 的真实 workerd 适配仅加浏览器 Origin/转换 redirect，不补 Content-Type。旧缺头400，对实际 api DELETE200；版本 CAS 回归仍在               |
| 02                   | 已修复，L1                               | migrations.test.ts 隔离生成 No schema changes，旧 SQL 未被本审查修改；全迁移、trigger 与 D1 并发正常                                                                                               |
| 03                   | 已修复，L1 组件层                        | main.tsx:30 挂 CloudTheme；CloudTheme.tsx:6–18 首次成功同步，失败不覆盖；settings 保存回归。未做真实主题视觉验收                                                                                   |
| 04                   | 已修复，L1                               | shared/stats.ts:42–75 键字典/schema，Stats.tsx:137/143 复用；所有标签组件与真实 stats 测试通过                                                                                                     |
| 05                   | 已修复，L1                               | workouts.ts:143–147 在分块前拒绝 0/101；最大真实 D1 写入仍通过                                                                                                                                     |
| 06                   | 已修复，L1                               | workouts.ts:439–444 逐 guard ID 清理；并发创建保留无关 guard 行，CAS/引用失败回滚通过                                                                                                              |
| 07                   | 已修复，L1                               | replay():212 更新当前 requestId；两个调用路径 :239/:449 均传当前值；数据仍是原始响应，header 对拍通过                                                                                              |
| 08                   | 已变化，L1                               | 不降低领域上限、承认组合张力；Workouts.tsx:721–729 在 setPending 之前 UTF-8 检查，api 再保护。50组中文组件不冻结、300组载荷拒绝、后端413无落库均通过                                               |
| 09                   | 仍存在，P3/L2，未运行专门测试            | Workouts.tsx:585 `const ready = true`，所有 !ready 永远假；不是 session 9 项声明之一。最小建议删除恒真状态及分支，重跑组件回归                                                                     |
| 10                   | 旧“手机没有入口”已被证伪，L2，未运行 GUI | Workouts.tsx:150–152 历史页“管理动作库”始终可达；App 手机导航有训练。Settings 本身没有设计要求的入口，属于已知位置偏离，不重报为完全不可达                                                         |
| 11                   | **部分修复/仍存在**，P3/L1               | 非字符串 UUID 已修并有回归；startedAt 非字符串仍 traceback，exportedAt 无校验，详见下节。无目标遗留，不称数据损坏                                                                                  |
| 12                   | 仍存在措辞歧义，P3/L1（现有测试）        | Python :129–141 负整数 Retry-After 走 fallback；test_healthworker.py:204 实测 '-1'→1，文档笼统称 numeric clamp 0–30。负数不符合 HTTP delta-seconds，建议文档说明非法值默认退避，不改为必须接受负数 |

Session 额外“非字符串 UUID 导致恢复堆栈”是 11 的子问题；“前端大中文失败冻结”是 08 的体验修复。二者不能被扩大为“所有畸形备份/所有恢复场景已安全”。

### HW-2026-09-14-11 的剩余证据

- 位置：`scripts/restore-local.py:31–65,179–188`。
- 现象：字段集合完整、合法 UUID 的草稿备份，将 `workouts[0].startedAt` 改为数字 5，`:61` `.replace()` 抛 AttributeError，main 捕获元组不含它，退出 1 并输出 traceback。无目标创建；正常 startedAt 对照退出0。
- 另将空合法备份的 exportedAt 改为 5，脚本退出0并创建新 SQLite；共享 `backupSchema` 明确要求 ISO datetime，脚本没有检查该字段。
- 影响：损坏输入不是受控拒绝，备份契约未一致执行；不改变已有数据库，不是远端恢复问题。
- 最小建议：在解析日期前校验类型及约定格式（覆盖 exportedAt），而非只给 UUID 补丁；保留不覆盖/失败清理。永久回归扩充 restore.test.ts，加入字段类型矩阵及 exportedAt 正反例。

## 4. 新候选发现（待 judge）

### HW-2026-09-14-13 · 接受有限极值后，有氧统计计算溢出为 500

- **建议严重度/证据**：P1 / L1 workerd+D1 路由实测。严重度考虑：需人为极端输入，单用户可编辑/删除修复，主 agent 可据发生概率降为 P2；不是安全绕过。
- **位置**：`src/shared/workouts.ts:59–70`；`src/worker/stats.ts:309–348`；`src/shared/stats.ts:14–15,168–170`。
- **现象/复现**：POST 合法 cardio 动作；完成训练填写 durationSeconds=1、distanceMeters=1e308，POST201、详情GET200；查询覆盖此日期的 `/stats/cardio` 返回500。5000米同样1秒的有限对照返回200，排除路由/认证/迁移整体不可用；1e308 为合法 JSON 有限数字，不是非法 JSON Infinity。
- **影响**：通过 API 接受并持久化的记录使包含它的有氧趋势（人类及共享 Agent 服务）不能返回契约数据。直接实测人类路径；Agent 数值路径共享，未再单独执行极值 Agent 请求。
- **根因**：仅限制非负/finite，不限制运算域；`distance / duration * 3.6` 溢出 Infinity，最终 DTO parse 拒绝，安全边界变成500。正常数值/配速算法本身未被此证据否定。
- **最小建议**：共享输入契约为会参与计算的量设置明确合理上限，并对旧极值记录的派生结果提供有文档的受控错误。不得直接把无限值改成0，也不要静默丢样本。同步 OpenAPI/数据字典；具体业务上限由设计核准。
- **回归建议**：在 stats.test.ts 加“合法输入永远不导致非有限输出”的 API 边界测试，含极大距离、极小正距离及大倍率；本轮只证实大距离，不把其余假设算已复现。
- **去重**：known-gaps 没有该数值运算边界，非既有10000行/512KiB张力。

### HW-2026-09-14-14 · 默认历史分页跨 UTC 午夜失去游标上下文

- **建议严重度/证据**：P2 / **L2 静态确证，未运行时间跳变或 GUI**。
- **唯一调用链**：`WorkoutHistory` (`src/web/Workouts.tsx:69–90`) 初始 from/to 为 null，queryFn 每次只带显式字段和 pageParam；`getNextPageParam` (:91) 仅返回 cursor → `src/worker/workouts.ts:542–560` 每次重新生成 UTC to/from 并放入 filter → 下一页在 :589 比较 cursor.filter，午夜后的新默认范围不匹配，:593 返回400 INVALID_CURSOR。
- **触发/影响**：午夜前已取得有 nextCursor 的默认历史页，页面保持打开且午夜后点击加载更多，整轮遍历失败而不是继续原范围；不是数据丢失。若在午夜后先成功 refetch 全部页可恢复，但用户未必触发它，不能保证。
- **证伪检查**：显式日期不受此问题；URLSearchParams 对 cursor 的二次编码与服务端 decode 配对正确，非编码缺陷；Python `Client.pages`:425–428 已把首个 meta.from/to 钉住，不能把 Python 也判为有问题。
- **最小建议**：前端页参数携带首个响应范围，后续请求固定该范围，主动刷新时再新建分页上下文；优先复用现有 query/pageParam，勿另造分页框架。
- **回归建议**：冻结午夜前后时间，以实际客户端参数访问 workerd，两页不重不漏；明确筛选变化仍拒绝旧 cursor。现有 D1 游标测试全部显式日期，抓不到此分支。
- **去重**：不是已知视口或 M5 空白，也无证据说明由本轮修复引入。

### HW-2026-09-14-15 · 动作查询校验错误与文档 HTTP 语义不一致

- **建议严重度/证据**：P2 / L1。
- **位置**：`src/worker/exercises.ts:34–46`；`src/shared/exercises.ts:64–75`；`docs/api.md:22`、design §6.4。
- **复现**：实际 GET `/api/v1/exercises?limit=101` 返回422；对照 workouts 相同 limit 返回400，stats 非法 category 返回400。
- **影响**：读接口格式错误被报告成业务字段错误，依赖契约区分参数错误/业务拒绝的客户端得到不同语义。现有前端并未据此破坏记录，不能上调为P1。
- **根因**：defaultHook 不区分 json 与 query/param，固定422。Workout hook 已有按 target 区分的范例。
- **最小建议**：json 字段422、query/param 格式400；测试参数上限/非法kind/未知字段与合法创建业务错误的对照；同步机器/文字契约。只读查询现有客户端自行 limit≤100，故常规页面难触发。
- **去重**：历史 review 无此条。版本头独立校验仍400，未把所有动作错误统称错码。

### HW-2026-09-14-16 · 部署文档保留旧“本轮”bundle 测量

- **建议严重度/证据**：P3 / L1 build 对拍。
- **位置**：`docs/deployment.md:9`。
- **现象**：该段称本轮主JS486.05/gzip153.53，Stats409.54/120.39；本次真实主JS623.87/195.20，Stats409.55/120.51，README/session 数值正确。
- **影响/根因**：部署阅读者低估首包；结果同步只更新部分文档，没有给此处历史日期。不是性能目标未验收这个已知缺口的新版本。
- **最小建议**：标明该段是历史测量或链接 README 当前结果；不建议为文档漂移擅自改应用拆包。
- **验证**：再次 build 对拍，区分原始/压缩字节；旧 reviews 保留当时证据。

## 5. 客户端协议矩阵

路径除 CLI 行外均相对 `/api/v1`。读请求不需要 Origin/Content-Type；所有人类写请求由浏览器管理 Origin，要求与 APP_ORIGIN 精确匹配。表中“JSON”指 api 按 method 自身设置，不由测试辅助函数填充。全局 Access/no-store/requestId 独立于正文契约；真实 Access 未验收。

| 客户端调用点                            | 方法/路径                 | Origin / Content-Type           | If-Match / Idempotency-Key | body 与响应/错误                                                                                                                                     |
| --------------------------------------- | ------------------------- | ------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| lib.ts:13，CloudTheme、Settings、Editor | GET settings              | 无要求 / 无                     | 无/无                      | settingsResponseSchema；失败不重置主题                                                                                                               |
| Settings.tsx:64                         | PATCH settings            | 浏览器 / JSON                   | data.version / 无          | settingsPatchSchema；200 settingsResponse；412保留当前表单但需刷新                                                                                   |
| Settings.tsx:31                         | GET export?format/dataset | 无要求 / Accept按附件           | 无/无                      | exportQuerySchema；原始Blob，校验类型与attachment，不误当envelope；非2xx统一提示                                                                     |
| Exercises.tsx:339                       | GET exercises             | 无要求 / 无                     | 无/无                      | query/kind/archive/limit/cursor；exerciseListSchema；格式错误实际422（-15）                                                                          |
| Exercises.tsx:80                        | POST exercises            | 浏览器 / JSON                   | 无/无                      | exerciseInputSchema；201 exerciseResponseSchema                                                                                                      |
| Exercises.tsx:80                        | PATCH exercises/id        | 浏览器 / JSON                   | existing.version / 无      | 仅name/aliases/equipment/muscleGroups投影；200 exerciseResponse；412不自动覆写                                                                       |
| Exercises.tsx:345                       | PATCH exercises/id        | 浏览器 / JSON                   | exercise.version / 无      | archived布尔；200 exerciseResponse                                                                                                                   |
| Workouts.tsx:89                         | GET workouts              | 无要求 / 无                     | 无/无                      | workoutListSchema；显式筛选全入queryKey；默认日期后续页未固定（-14）                                                                                 |
| Workouts.tsx:229/432                    | GET workouts/id           | 无要求 / 无                     | 无/无                      | workoutResponseSchema；404/登录错误提示                                                                                                              |
| Workouts.tsx:504                        | GET workouts参考          | 无要求 / 无                     | 无/无                      | exerciseId/status=completed/limit1；明确近28天，不分页                                                                                               |
| Workouts.tsx:645 新建                   | POST workouts             | 浏览器 / JSON                   | 无 / 固定request.key       | workoutInputSchema；201 workoutResponse；网络不明冻结原正文/key重放，422/400/409/404/413可解锁                                                       |
| Workouts.tsx:645 编辑                   | PUT workouts/id           | 浏览器 / JSON                   | baseVersion / 无           | 同聚合schema；200；412保留输入、禁止直接覆盖                                                                                                         |
| Workouts.tsx:233 删除                   | DELETE workouts/id        | 浏览器 / **JSON，无body也设置** | workout.version / 无       | workoutDeleteSchema；200；412重新读后确认，后端原子DELETE CAS                                                                                        |
| Stats.tsx:266/380/511                   | GET stats三路             | 无要求 / 无                     | 无/无                      | range及granularity/exercise/warmup/category/basis，全部在queryKey；共享stats response；422缩小范围、500安全错误                                      |
| Stats.tsx:641                           | GET workouts最近5条       | 无要求 / 无                     | 无/无                      | workoutListSchema；不分页                                                                                                                            |
| Python Client.get/pages                 | GET /api/agent/v1 白名单  | 无Origin / Accept JSON          | 无/无                      | Service Token只发正式HTTPS配置；metadata先验、独立响应检查、notes默认抑制；分页钉日期、截断显式；401/403/3xx/HTML/schema不重试，429/5xx/网络有限重试 |
| OpenAPI消费者                           | GET 两路openapi.json      | 受认证 / 无                     | 无/无                      | 原始OpenAPI，不是envelope；Agent只有GET、不含管理面                                                                                                  |

中间件：人类缺Origin403、缺JSON400；body超限413；Agent非GET（含HEAD/OPTIONS）405；不允许通过Agent访问settings/export；未知API JSON404。api credentials=same-origin，redirect=error；Access登录页与网络错误不被当成功。未声称 workerd 适配等于浏览器。

## 6. 已排除、未上报与待验证候选

本轮实际考虑过的候选全部列在这里或发现项中；静态排除只覆盖所列路径。

- **无正文DELETE仍400**：被现有真实 api→workerd 回归证伪；缺头变体400是服务端既定要求，不再当缺陷。
- **空草稿列表json_group_array返回null/500**：独立路由探针创建空草稿201、列表200、kinds=[]，证伪。
- **旧0001再次生成DDL**：隔离真实Drizzle生成回归通过；3触发器/FK/CAS仍通过，证伪。
- **guard定向清理留下正常残留或删除无关guard**：现有D1并发与stale guard回归通过；不将“D1串行”假设当证据替代。
- **当前requestId修复破坏原始幂等data**：测试data相等、更新/删除后重放、并发一个创建均通过。
- **大中文载荷继续冻结编辑**：组件大载荷回归保留输入/可编辑，纯逻辑50条目300组和后端413对照通过。上限组合本身已知，不报。
- **所有旧恢复异常已修**：未被证伪，仍在旧11；只UUID已修，日期类型独立实测失败。
- **手机动作库完全不可达**：静态训练历史入口证伪；Settings缺直接入口仅保留旧台账范围。
- **quality键缺中文/未知键悄悄fallback**：共享有界schema及全键渲染通过；真实SQL输出键与字典逐项对齐。
- **null距离聚合500、均值配速、热身/草稿漏过滤**：现有12个D1统计回归通过；不把-13极值错误扩大成正常统计口径错误。
- **strength读取10000限制等于必须限制原始所有组**：代码限制返回的趋势/纪录明细，SQL内聚合不等于读取所有原始组到客户端；本轮未构造新的超密力量证据，不据措辞歧义另报P1。
- **导出普通分页截断或读快照分裂**：exportBackup单D1 batch+预算gate、完整fixture/字节拒绝测试通过；150001行独立fixture未跑，不能称所有阈值均边界实测。
- **新增引用已归档/历史编辑误拒绝**：真实D1交错、历史entryId快照保留回归通过。
- **动作语义可由PATCH直接改写**：strict展示字段schema和SQL trigger双重限制，既有并发/字段回归通过。
- **cursor编码导致每次第二页失败**：URLSearchParams编码与路由decode配对，现有显式范围游标回归通过；-14仅未固定默认日期。
- **负Retry-After不clamp是传输bug**：负数不是合法HTTP delta-seconds，fallback合理；只旧文档措辞需收窄。
- **认证信任伪造身份头/生产mock**：auth.ts验证jose签名/issuer/aud/claims/owner；合成JWT与本地production fail-closed回归通过。没有把本地mock当边缘验收。
- **分层越界**：全src读取/搜索未见web导入worker或shared依赖DOM/D1/node对象；未新增依赖，未重做许可/供应链远程核查。
- **其他数值字段溢出**（极小距离、大倍率、大总时长）、设置表单后台refetch重置正在编辑内容、JSON body被截断时原生SyntaxError提示：仅待验证假设/L3，**不计必修**；本轮未运行对应复现，不从-13外推全部路径。

## 7. 验收覆盖坐标与未运行项

| 编号 | 本次证据范围，不代表正式验收                                       |
| ---- | ------------------------------------------------------------------ |
| A01  | 混合CRUD D1与组件部分覆盖；手机/桌面完整创建刷新闭环无证据         |
| A02  | 复制ID/完成标识与幂等回归覆盖；GUI无证据                           |
| A03  | schema/计量与统计热身回归覆盖                                      |
| A04  | 完成父子/草稿/null自动测试覆盖；视觉全状态无证据                   |
| A05  | D1 1500与倍率测试覆盖                                              |
| A06  | D1自重/辅助/计时/缺倍率排除覆盖                                    |
| A07  | D1 320秒/km及basis隔离覆盖                                         |
| A08  | UTC/localDate/DST/周月边界自动测试；午夜分页见-14未运行            |
| A09  | 真D1并发幂等与requestId回归覆盖                                    |
| A10  | 真D1 CAS/晚期SQL失败回滚覆盖                                       |
| A11  | 真D1删除/归档/历史编辑、真实客户端头覆盖；点击确认GUI无证据        |
| A12  | 仅合成签名JWT/本地fail closed；真实Access无证据                    |
| A13  | 本地路由方法/独立OpenAPI/JSON404覆盖；边缘策略无证据               |
| A14  | 组件错误/网络重放/体积保留覆盖；真实Access过期/离线全流程无证据    |
| A15  | D1完整导出/CSV及新SQLite恢复覆盖；日期畸形旧11仍在；远端恢复无证据 |
| A16  | 仅CSS/导航静态与少量组件；全部指定视口/键盘/200%无本次证据         |
| A17  | 主题/quality/空状态组件覆盖；真实明暗/焦点/图表视觉无证据          |
| A18  | Python27含真实本地HTTP transport；正式Service Token无证据          |
| A19  | 真D1最大50条目300组保存更新删除/参数分块；远端平台无证据           |
| A20  | 未部署/未读真实secrets；生产入口/日志/完整前端敏感值审计无本次证据 |
| A21  | 真D1引用竞态/历史快照/动作与训练游标回归覆盖                       |

明确不执行浏览器、E2E、真机、真实Access/JWKS/Service Token、dev库迁移seed、远端D1、部署、p95参考规模、生产资源操作。M5等缺口已知，未重复新编号。

## 8. 最小可重建复现

在仓库根执行下面命令（本报告根目录为 `/Users/andy/Desktop/Patent/HealthWorker`）。临时测试必须放 `tests/integration/zz-independent-followup.test.ts`，运行后删除。下面缩减掉辅助排版，保留原实际探针同样的断言/控制；不修改既有测试。

```ts
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../../src/worker/auth';
const b = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const base = 'http://127.0.0.1:5173';
beforeAll(async () => {
  await applyD1Migrations(b.DB, b.TEST_MIGRATIONS);
});
const req = (path: string, body?: unknown) =>
  SELF.fetch(
    base + '/api/v1' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            Origin: base,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        },
  );
it('numeric accepted input vs stats and normal control', async () => {
  const action = await req('/exercises', {
    name: 'Synthetic overflow probe',
    aliases: [],
    kind: 'cardio',
    equipment: null,
    muscleGroups: [],
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'run',
  });
  expect(action.status).toBe(201);
  const exerciseId = ((await action.json()) as { data: { id: string } }).data
    .id;
  for (const [date, distance] of [
    ['2026-08-01', 5000],
    ['2026-08-02', 1e308],
  ] as const) {
    const saved = await req('/workouts', {
      startedAt: date + 'T12:00:00Z',
      timezone: 'UTC',
      status: 'completed',
      durationSeconds: null,
      notes: null,
      entries: [
        {
          id: crypto.randomUUID(),
          exerciseId,
          kind: 'cardio',
          notes: null,
          cardio: {
            completed: true,
            durationSeconds: 1,
            durationBasis: 'elapsed',
            distanceMeters: distance,
            averageHeartRate: null,
            maxHeartRate: null,
            elevationGainMeters: null,
            inclinePercent: null,
            resistanceLevel: null,
            deviceCaloriesKcal: null,
          },
        },
      ],
    });
    expect(saved.status).toBe(201);
    const id = ((await saved.json()) as { data: { id: string } }).data.id;
    expect((await req('/workouts/' + id)).status).toBe(200);
    const stats = await req('/stats/cardio?from=' + date + '&to=2026-08-03');
    console.info(
      'PROBE numeric',
      distance,
      'create',
      saved.status,
      'stats',
      stats.status,
    );
    expect(stats.status).toBe(distance === 5000 ? 200 : 500);
  }
});
it('query errors and empty draft control', async () => {
  for (const path of [
    '/exercises?limit=101',
    '/workouts?limit=101',
    '/stats/cardio?category=invalid',
  ]) {
    const r = await req(path);
    console.info('PROBE query', path, r.status);
    expect(r.status).toBe(path.startsWith('/exercises') ? 422 : 400);
  }
  expect(
    (
      await req('/workouts', {
        startedAt: '2026-07-01T00:00:00Z',
        timezone: 'UTC',
        status: 'draft',
        durationSeconds: null,
        notes: null,
        entries: [],
      })
    ).status,
  ).toBe(201);
  const list = await req('/workouts?from=2026-07-01&to=2026-07-02');
  expect(list.status).toBe(200);
  expect(
    ((await list.json()) as { data: { kinds: string[] }[] }).data[0]?.kinds,
  ).toEqual([]);
  expect((await req('/unknown-independent')).status).toBe(404);
});
```

实际运行命令：

```sh
npx pnpm@10.34.5 exec vitest run --config /Users/andy/Desktop/Patent/HealthWorker/vitest.integration.config.ts /Users/andy/Desktop/Patent/HealthWorker/tests/integration/zz-independent-followup.test.ts
```

实际输出：1文件2测试通过（35ms测试、总1.07s）；numeric 5000/create201/stats200，1e+308/create201/stats500；query exercises422/workouts400/cardio400。测试是确认当前失败行为的探针，修复后应更换期望为受控拒绝/有限成功，不能永久保留“期望500”为产品回归目标。

Python最小重建（保存 `/tmp/healthworker-independent-restore-probe.py`；不需要import产品模块）：

```python
import json, pathlib, subprocess, tempfile
root = pathlib.Path('/Users/andy/Desktop/Patent/HealthWorker')
base = {'schemaVersion':'1', 'definitionsVersion':'1',
        'exportedAt':'2026-01-01T00:00:00Z', 'settings':None,
        **{k:[] for k in ('exercises','workouts','entries','strengthSets','cardioRecords')}}
w = {'id':'00000000-0000-4000-8000-000000000001',
     'startedAt':'2026-01-01T00:00:00Z', 'timezone':'UTC', 'localDate':'2026-01-01',
     'status':'draft', 'durationSeconds':None, 'notes':None, 'version':1,
     'createdAt':'2026-01-01T00:00:00Z', 'updatedAt':'2026-01-01T00:00:00Z'}
with tempfile.TemporaryDirectory(prefix='healthworker-independent-') as temp:
    p = pathlib.Path(temp)
    for label, data in [
        ('valid', {**base, 'workouts':[w]}),
        ('startedAt-number', {**base, 'workouts':[{**w,'startedAt':5}]}),
        ('exportedAt-number', {**base, 'exportedAt':5}),
    ]:
        source, target = p/(label+'.json'), p/(label+'.sqlite')
        source.write_text(json.dumps(data))
        r = subprocess.run(['python3', str(root/'scripts/restore-local.py'), str(source),
                            '--new-local-db', str(target)], capture_output=True, text=True)
        print(label, 'exit', r.returncode, 'traceback', 'Traceback' in r.stderr,
              'target', target.exists())
        if label == 'startedAt-number':
            assert r.returncode == 1 and 'AttributeError' in r.stderr and not target.exists()
        else:
            assert r.returncode == 0 and target.exists()
```

实际 `python3 /tmp/healthworker-independent-restore-probe.py` 输出：valid exit0 tracebackFalse targetTrue；startedAt-number exit1 tracebackTrue targetFalse；exportedAt-number exit0 tracebackFalse targetTrue。脚本上下文结束后3份输入/目标均删除。

## 9. 收尾与处理顺序

建议主 agent 先 judge -13 的功能影响与优先级、旧11“局部修复”状态，再考虑 -14 时间分页和 -15 读接口错码，最后旧P3与文档-16；不自动实施任何修复。

开始 Git status --porcelain 为 **26行**，git ls-files 为 **0**。所有产品代码与既有测试只读；报告是唯一预期持久新增。Git折叠的 `?? docs/` 不因新增报告增加行数，因此“26/0相同”不能冒充逐文件零差异。没有初始全文件哈希，不声称证明并发线程绝无修改。

已删除本次 zz 测试、/tmp Python脚本及临时输入/SQLite目录；Python探针曾用importlib读取模块，生成的 `scripts/__pycache__/restore-local.cpython-314.pyc` 也已删除；首次verify原始临时日志目录已删除。build重建被忽略的dist，测试可更新框架缓存，未复原构建产物，不操作开发运行库。

清理后第二次完整 verify 于 2026-09-14T05:15:47Z 开始，退出0、7/7通过，仍为49 TS / 49 D1 / 27 Python（1.654秒），bundle全项与首次相同；该次格式检查发生在报告写入之前，报告完成后另跑最终全库 format:check 已通过。最终 status仍26行、tracked仍0，计数差额均0；git diff --check通过；find未发现zz临时测试，/tmp探针不存在。报告是唯一预期持久新增，未通过修改产品代码消除任何基线差额。
