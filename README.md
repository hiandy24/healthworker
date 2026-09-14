# HealthWorker

基于 Cloudflare Workers 与 D1 的个人训练记录系统。实施基线见 [完整设计 1.8](docs/design.md) 和 [执行规则](AGENTS.md)。

## 当前状态：M2–M4 本地实现，验收未全部完成

- M1：React/Mantine/Hono/本地 D1 骨架、Access JWT 单应用/单 audience 与已验身份分类、人类 allowlist、同源写入及安全限制。
- M2：动作库、混合训练 CRUD、历史/详情/复制、D1 原子保存、幂等与 If-Match 并发保护；本地草稿独立 UUID，每个 document 独立存储 key，显式恢复复制不删除源草稿；提交不确定时重放原正文/key，不重复创建。
- M3：summary/strength/cardio 共享统计服务，总览与 Recharts 趋势、范围/质量信息/明细表。缺失不当零，容量按单动作快照，配速按同项目/同 basis 总量比。
- M4：设置及首次时区确认、JSON/CSV 附件导出、新本地 SQLite 恢复脚本、默认只读、授权后受控创建的 Agent CLI/Skill。

**已首次生产部署至 <https://health.tokenflare.top>（2026-09-14 UTC）；M5 部分完成。** 独立生产 D1 已应用两份既有迁移，仅初始化 3 条内置动作，训练为 0。公共 DNS/TLS 可用，无凭证页面、人类/Agent/未知 API 均真实返回 Access 302；远端 workers.dev / preview 已关闭。OTP 登录和 Service Token 身份隔离、完整 GUI/真机仍待验收。 本地 mock、独立代码 review 与自动测试不是真实 Access、全 GUI 或真机验收。metadata 的旧 milestone=M1 仅保留兼容；实际能力以 capabilities 为准，不代表阶段验收完成。独立 review 与修复证据见 [M2](docs/reviews/m2.md)、[M3](docs/reviews/m3.md)、[M4](docs/reviews/m4.md)。

## 单 Access 应用 / 单 AUD（设计 1.8）

用户已授权替换旧双应用要求。同 hostname 的唯一 self-hosted 应用同时配置 owner 邮箱 OTP Allow 和仅指定 Agent Token 的 Service Auth。Worker 统一验证 ACCESS_AUD，再以已验 type/sub/email/common_name 互斥分类：管理 human-only，Agent service-only：普通身份只读，导入 allowlist 身份仅额外 POST workouts，混合/未知拒绝。旧双 AUD 不读取，无静默回退；可选 ACCESS_SERVICE_TOKEN_IDS 限制 Client ID。步骤及官方证据见 [部署说明](docs/deployment.md#单-aud-身份与真实-access-验收)。私有原 human AUD 可作为单 AUD 来源，不在公共文件列值。

历史单 AUD 实现轮完整运行 typecheck、lint、format、format:check、build、50 个 TS 测试、55 个 workerd/D1 测试及 27 个 Python unittest 均通过。新增合成签名 JWT 测试覆盖身份混淆与跨入口拒绝；workerd app.request 走真实 HTTP 路由/认证/jose 远程 JWKS 流程，仅 mock 公钥传输，不 mock authenticate。初次测试类型错误已修复。该轮测试并非真实边缘、浏览器或 OTP 验收。后续首次部署轮另通过生产 build/dry-run、typecheck、lint、50 项 TS 与 55 项集成测试；已授权创建独立 D1 和发布 Custom Domain，未改 Access 策略。根 Wrangler 保留本地环境，真实生产绑定仅在被忽略的私有配置。

## 本地运行

要求 Node 24（本轮 24.15.0）、pnpm 10.34.5；Python 3.11+ 用于 Skill 与恢复。直接依赖固定版本，只有一个 pnpm lockfile。

```sh
npx pnpm@10.34.5 install --frozen-lockfile
npx pnpm@10.34.5 db:migrate:local
npx pnpm@10.34.5 db:seed:local
npx pnpm@10.34.5 dev
```

打开 <http://127.0.0.1:5173>。Vite Cloudflare plugin 提供同域 API，本地数据在被忽略的 `.wrangler/state`。dev 显式选择 local 模拟身份，不能发布 local 环境；生产缺认证配置拒绝访问。进入新训练时先确认时区，可保存云端草稿或完成训练；此处“云端”仅描述 API 保存状态，本地运行实际写本地 D1，不代表已上线。

默认历史/统计范围是 UTC 日历近 28 天，但归属依然按训练 localDate。日期支持 1900–9999，半开范围最多 366 天。统计超 10000 明细返回 422，须缩小范围，不静默截断。

## 验证命令与真实结果

```sh
npx pnpm@10.34.5 typecheck
npx pnpm@10.34.5 lint
npx pnpm@10.34.5 format:check
npx pnpm@10.34.5 test
npx pnpm@10.34.5 test:integration
python3 -m unittest discover -s tests/skill -v
npx pnpm@10.34.5 build
git diff --check
```

历史确认项修复后，typecheck、lint、format/format:check、build、50 个 TS 单元/组件测试、55 个 workerd/D1 集成测试、27 个 Python Skill unittest 全部通过。新增真实客户端 InfiniteQueryObserver→workerd UTC 午夜分页、数值边界/历史坏值/累计倍率、动作状态码/OpenAPI、恢复日期矩阵回归；不代表 GUI 或真实 Access 验收。该历史轮 Git 文件均未跟踪，git diff --check 覆盖有限；没有修改 SQL 迁移。当前首次基线收尾结果见下文。

当前脚本还包括 db:generate、format；schema 变更须追加迁移，不改已应用迁移。没有 test:e2e、deploy 或 db:migrate:remote 脚本，不把目标脚本当作已提供能力。本轮未重跑开发库迁移/seed，沿用 M1 的历史本地记录；隔离集成测试已执行迁移；新增临时 SQLite 全迁移/触发器校验与临时目录 drizzle-kit generate 无变更回归。已有 SQL 未改，仅补齐 0001 journal/snapshot。

构建成功；主 JS 624.82 kB/gzip 195.40 kB，Stats 路由块 409.55 kB/gzip 120.51 kB，CSS 225.33 kB/gzip 32.92 kB。Zod 上游 PURE 注释有 Rollup 警告，未影响构建；主块超过 500 kB 有构建警告，未做本轮范围外拆包优化。未做设计参考规模的 p95 性能验收。

## 导出、恢复与 Skill

设置页提供 JSON 和三个 CSV 数据集下载。JSON 包含草稿、归档动作、ID/历史快照及全部备注；CSV 用于查阅，不是完整恢复格式。导出在一个 D1 batch 读取一致视图，150000 行/20 MiB 保守预算（文本字节加每行 2 KiB）及最终字节检查；超限 413 并引导受控备份，不提供截断附件。

```sh
# 将设置页下载的 JSON 放到被忽略的 backups/，目标文件必须不存在。
python3 scripts/restore-local.py backups/backup.json --new-local-db .local/restored.sqlite

# 无凭证的明确本地开发模式；不会发送继承的 Service Token。
HEALTHWORKER_BASE_URL=http://127.0.0.1:5173 \
  python3 skills/healthworker/scripts/healthworker.py --development metadata
HEALTHWORKER_BASE_URL=http://127.0.0.1:5173 \
  python3 skills/healthworker/scripts/healthworker.py --development stats summary
```

恢复只创建新本地 SQLite，拒绝覆盖/远端参数，不是远端 D1 恢复工具。正式 Agent 使用 HTTPS origin 与本地环境变量 HEALTHWORKER_ACCESS_CLIENT_ID/HEALTHWORKER_ACCESS_CLIENT_SECRET，不把凭证放命令行或仓库。详见 [Skill](skills/healthworker/SKILL.md) 与 [CLI 契约](skills/healthworker/references/api.md)；源目录不会被所有平台自动发现，不自动安装到全局。读取命令只用白名单 GET；导入命令仅在能力检查和用户确认后 POST workouts，每次 socket 操作 20 秒（非总截止时间），初次后最多 3 次重试，拒绝所有重定向/HTML，分页截断显式返回。

本轮 session review 另修复无正文 DELETE JSON 请求头、启动云端主题、统计中文质量键、UTF-8 载荷预检、UUID 类型安全、D1 插入宽度、guard 定向清理和幂等当前 request ID。新增测试未使用浏览器；既有 dev server 未重启。逐项修复、迭代失败与最终证据见 [本次 session review](docs/reviews/session-2026-09-14.md)。

## 浏览器验收：部分完成且工具阻塞

以下是主 agent 的 IAB 实际检查记录，本收尾仅同步，不冒充重新执行 GUI：

- 已确认 768px 总览侧栏不再覆盖内容、空状态统计；通过导航到训练记录及新训练的首次时区提示；直接 `/settings` 能加载设置表单。
- 旧版首页曾检查 360/390/1024/1440 宽度；不能替代 M2–M4 新版多视口回归。
- Playwright click 持续 timeout，domSnapshot 间歇为空，截图再次报 `browser screenshot activity capture failed for guest`。上述部分可见结果不代表所有点击流程成功。
- **未完成**训练录入/保存闭环、主题、新版完整多视口、附件下载、键盘、200% 缩放、加载/失败等完整状态与真机验证。需用户协助恢复浏览器能力或人工验收，不声明 GUI 全通过。
- 生产入口无凭证 Access 拦截已实测；OTP/Service Token 登录后的单 AUD 身份隔离仍待真实边缘确认，完整 GUI 与真机也待验收。私有配置已另存且忽略，公共文档不列邮箱、AUD 或凭证。

更多见 [API](docs/api.md)、[部署说明](docs/deployment.md)。未经明确授权不远端迁移、发布、提交或推送 Git。

## 2026-09-14 确认项修复状态

- HW-2026-09-14-13（原 P2）：共享全部测量范围及 SQL 操作数/累计/派生保护，坏值明示 422 STATS_NUMERIC_OUT_OF_RANGE，正常总量比和容量不变。
- HW-2026-09-14-14（原 P2）：首范围钉住后续 pageParam，主动刷新首请求、切换筛选新 queryKey；冻结 UTC 午夜的真实客户端/workerd 三页无重漏回归通过。
- HW-2026-09-14-15（原 P2）：query/param 400，JSON 业务 422，OpenAPI GET 不再宣告业务 422。
- HW-2026-09-14-16（原 P3）：deployment 仅链接本 README 当前 build，历史 review 数值保留。
- HW-2026-09-14-11（旧 P3 部分修复）：UUID 原回归保留，补全部日期字段类型/ISO/时区/合法边界及 exportedAt 检查；数字日期无 traceback、无目标残留。
- HW-2026-09-14-09/12（旧 P3）：删除恒真 ready 死分支；澄清负 Retry-After 非法值走默认退避，不改传输行为。

以上是实现者的本地修复记录，待主 agent 独立复评。旧 01–08 修复回归未削弱，旧 10 入口位置偏离未改。迭代期间发现 Zod UTC ISO 要求秒字段，恢复解析器与正边界测试据实际契约修正后重跑通过。统计安全检查已按真实动作/category/basis、完成明细与热身策略筛选，仅检查实际计算操作数；无关训练或字段不再阻断。单结果绝对值上限 MAX_SAFE_INTEGER 用于避免不可靠累计数值，非新的训练统计定义。无 GUI、真机、真实 Access、远端、提交/推送或全局操作。

最小独立复评：运行 `npx pnpm@10.34.5 test:integration`（重点 history-midnight、stats、exercises）及 `npx pnpm@10.34.5 test`（重点 restore、workouts）；比较两个受保护 OpenAPI 接口中的范围及状态码；按本页命令重跑全套。不要用本地 mock 或组件测试声称真实 Access/GUI 已验收。

本次独立复评追加修复（设计 1.6）：新写入继续使用严格安全范围，历史详情/列表/动作/JSON backup 使用兼容旧 finite 非负范围的 read schema（正整数保持 MAX_SAFE_INTEGER），不再将新写上限施加于已有记录。旧 distance=100000001 详情及完整导出 200，前端共用 toInput 可保留旧值供用户修正，修正 PUT 后统计 200。TS backup 与 Python restore 均保留旧 duration=31536001、次数及倍率，不重写快照。统计只检查实际选中操作数；run 超界不阻断 cycle/strength，未完成明细和默认排除热身不参与检查。summary 不计算配速，因此极小正距离本身不构成 summary 错误。受控 422 仍用于真正选中超界计算，绝不静默丢弃。

## 受控导入增量（1.8）

单 AUD 保持；默认 service 只读，精确 ACCESS_IMPORT_TOKEN_IDS 授权的已验 service 增加 metadata capability `workouts:create`，仅 POST `/api/agent/v1/workouts`。总体 ACCESS_SERVICE_TOKEN_IDS 仍先检查。空/非法导入配置 fail closed，未配置不授权。human 管理入口不接受任何 service；所有 Agent PUT/PATCH/DELETE、POST exercises/settings/export/未知路径拒绝。读取命令仍为严格 GET 白名单。OpenAPI 允许文档出现条件 POST /workouts，绝不执行文档中的任意 URL。未发布线上。

缺失动作先列待审批表（原名称、拟定语义、单位、原因），用户确认后由 human 建立，再替换真实 exerciseId 重新计划；不开放 Agent 动作创建，不修改归档历史。

## 确定批量文件与确认命令

原始 CSV/文本由 Agent 按用户确认的时间、时区、单位和动作语义转换，不由脚本自动猜测。批量 JSON 严格为 `version=1`、稳定 UUID `batchId` 和 `workouts` 数组（1–1000 项）；每项只有稳定非空 `sourceId` 与 `body`。body 完全使用 POST WorkoutInput（无历史 workout ID/version/快照），条目/组 UUID 在转换时生成一次后保留；exerciseId 必须查询匹配，不凭空造真实动作 ID。nullable 字段必须显式提供，重量 kg，距离 m，时长 s。

最小合成结构（空草稿演示，不代表已完成训练；完成训练须含完整明细，详见 OpenAPI）：

```json
{
  "version": 1,
  "batchId": "11111111-1111-4111-8111-111111111111",
  "workouts": [
    {
      "sourceId": "synthetic-row-1",
      "body": {
        "startedAt": "2026-08-01T00:00:00Z",
        "timezone": "UTC",
        "status": "draft",
        "durationSeconds": null,
        "notes": null,
        "entries": []
      }
    }
  ]
}
```

```sh
# 在仓库根目录；凭证只从受保护环境读取，不填入命令行。
python3 skills/healthworker/scripts/healthworker.py validate --input .local/batch.json
python3 skills/healthworker/scripts/healthworker.py plan --input .local/batch.json --plan .local/import-plan.json
# 向用户展示 batch 正文、动作匹配、待建动作与疑似重复，并取得该计划的确认后：
python3 skills/healthworker/scripts/healthworker.py import --input .local/batch.json --plan .local/import-plan.json --confirm <confirmation-sha256>
```

validate/plan 先 metadata 能力检查，再本地结构/数值及当前动作计量检查、同 localDate 历史查询；不是无写入的服务端事务模拟，POST 仍会重新执行共享 Zod/动作并发校验。列表截断拒绝计划，不冒充完整去重。同日期记录仅疑似重复，批次内也应人工核对。计划不保存原始 body，但包含 sourceHash/bodyHash/稳定 key、origin、疑似记录 ID；用户必须同时审核批量正文。未匹配动作 ID 的名称与拟建语义由 Agent 单列审批表，human 建立后使用真实 ID 重新计划。

`import` 必须准确匹配 confirmation；输入变化拒绝旧计划，新计划不覆盖已存在文件。重跑相同输入和原计划、原 Token，保留旁边 `.journal.json`：成功条目跳过，失败条目同 body/key 重试，每条请求前写 pending，完成后存成功 ID 或失败状态。失败批次仍输出逐条结果，退出码 4，`allSucceeded=false`，`atomicBatch=false`。网络重试最多 4 次请求；所有重定向拒绝。首次不确定尝试超过 23 小时改为 needs_reconciliation，不能自动继续；服务幂等仅保证 24 小时。改变 Token、丢失 journal、重新生成 batchId/entry UUID 不能保证不重复，须人工核对，禁止自动覆写或通过换 key 绕过冲突。锁文件在异常退出后可能保留，确认没有运行中的导入并检查 journal 后才手动移除。

批量文件/计划/journal 都属于私有健康数据：推荐 `.local/` 被忽略目录与目录 0700、输入文件 0600；CLI 新文件 0600，journal 原子替换。不要共享整个目录、提交文件或打印凭证。此次只实现本地代码并以合成服务测试；普通 local mock 故意没有导入能力，生产需另行授权配置与部署，不把 --development 当绕过权限。

历史导入契约修复轮实测：`npx pnpm@10.34.5 typecheck`、`lint`、`test`（11 files / **51 passed**）、`test:integration`（6 files / **55 passed**）、`build` 全部 exit 0；`python3 -m unittest discover -s tests/skill -v` 为 **30 tests / OK**。`--help` 与 `import --help` 已运行，validate/plan/import 参数仍可用。仅新增两端矩阵各1个测试项，子案例不混算测试数量；构建保留已知 Zod 注释与大 chunk 警告。

## 首次 Git 基线收尾（2026-09-15 本地）

本轮重新运行 `corepack pnpm`（10.34.5）的 typecheck、lint、format:check、test、test:integration、build 及 Python unittest，全部通过：TS 单元/组件 **11 files / 51 passed**，隔离 workerd/D1 **6 files / 55 passed**，Python **39 tests / OK**。构建使用根配置，显式移除生产配置选择环境变量，不读取生产绑定、不发布；已知 Zod 注释与大 chunk 警告保留。未新增或改动应用逻辑、测试和 SQL 迁移。

Skill 私有绑定已本地实现：显式 `HEALTHWORKER_CONFIG` 指向绝对 JSON 路径，仅含 baseUrl/clientId；Secret 仍只从安全进程环境读取。仓库私有绑定位于被忽略的 `.local/healthworker-client.json`（文件 0600、父目录 0700），不随 Skill 分发、不自动全局安装。环境优先但跨 origin 覆盖拒绝，读取与导入共用校验及脱敏；39 个 Python 测试包含这些离线回归。

本轮授权仅为本地提交与归入 main。起点为无提交、0 tracked 的 `chore/project-bootstrap`，main 不存在，因此采用首次基线提交后创建 main 指向同一提交，而非伪造两条历史的 merge commit。现有 `.agents/skills/healthworker-review` 原样保留为独立审查工具；其中历史缺口/契约示例须以当前设计、代码和实测为准。

生产状态沿用首次部署证据，本轮未访问远端：线上仍为旧只读 Agent 版本，受控导入与 Skill 私有配置增量仅本地完成，未发布、未执行生产导入。真实 OTP/Service Token 身份隔离、导入授权、完整 GUI/真机及 p95 性能验收仍未完成；本地测试和首次基线不代表这些验收通过。
