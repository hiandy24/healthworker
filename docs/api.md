# 当前 API 与数据字典

实施基线为设计 1.8。机器契约由 `src/shared/{contracts,exercises,workouts,stats,settings,backup}.ts` 与 Worker 路由生成；受保护的 `/api/v1/openapi.json`、`/api/agent/v1/openapi.json` 是各自接口面，不维护另一份静态 OpenAPI。详细统计字段见 [Skill 数据字典](../skills/healthworker/references/data-dictionary.md)。实现不等于生产或 GUI 验收完成。

## 接口面

以下路径相对人类 `/api/v1`；Agent `/api/agent/v1` 默认提供标记的 GET；导入身份额外提供 POST workouts（见本页受控导入章节），复用查询、统计和原子创建服务。

| 路径                                                 | 人类方法         | Agent                |
| ---------------------------------------------------- | ---------------- | -------------------- |
| `/metadata`、`/openapi.json`                         | GET              | GET                  |
| `/exercises`                                         | GET、POST        | GET                  |
| `/exercises/{id}`                                    | PATCH            | 无                   |
| `/workouts`                                          | GET、POST        | GET；仅导入身份 POST |
| `/workouts/{id}`                                     | GET、PUT、DELETE | GET                  |
| `/stats/summary`、`/stats/strength`、`/stats/cardio` | GET              | GET                  |
| `/settings`                                          | GET、PATCH       | 无                   |
| `/export`                                            | GET              | 无                   |

所有入口验证 Access JWT、共同 issuer/单 ACCESS_AUD/签名/有效期；人类入口要求已验 owner 邮箱、非空 sub 且无 common_name，Agent 入口 service-only（已验 common_name Client ID、空 sub、无 email），两者 type 均为 app，混合/未知形状拒绝。可选 ACCESS_SERVICE_TOKEN_IDS 进一步限制 service；旧双 AUD 不读取。OpenAPI security 为 Cf-Access-Jwt-Assertion，CLI 仍向边缘发送 Service Token 两个头，人类写入另需精确同源 Origin 与 application/json（包括 DELETE）。普通只读 Agent 非 GET 返回 405；导入身份仅额外允许精确 POST workouts 与 POST exercises，其他非 GET（含 HEAD/OPTIONS）仍返回 405；无 settings/export 或人类入口回退权限。未知 API 返回 JSON 404，不返回 SPA。数据响应 no-store。

普通响应 `{data,meta}`，meta 含当前请求 requestId（与 X-Request-Id 一致，幂等重放也不沿用旧 ID）；错误 `{error:{code,message,fields?},requestId}`。OpenAPI 是原始文档，导出是原始附件，不是 data envelope。400 表示 JSON/查询/游标/版本格式错误，401/403 认证或权限错误，404 不存在，409 幂等正文不一致或引用竞争，412 版本冲突，428 缺版本，422 字段/计量错误或统计过密，413 请求体/导出超限，503 认证配置缺失，500 安全内部错误。边缘 Access HTML/重定向不是合法 JSON 成功响应。

## Metadata

apiVersion/schemaVersion/definitionsVersion 均为字符串 `1`。`milestone=M1` 仅保留为旧契约兼容标记，**不是当前功能范围或验收状态**；以 capabilities 与 review 记录判断。人类 capabilities 为 metadata/openapi/exercises/workouts/stats/settings/export；Agent 不含 settings/export；仅导入身份额外含 exercises:create 与 workouts:create。

units 为 kg/g/m/s/bpm；dateBasis=workout_local_date、rangeSemantics=[from,to)、weekStartsOn=monday、warmupDefault=exclude。timezone 读取设置，未持久化时虚拟 UTC，不代表用户确认；schema 为兼容仍允许 null。coverage 为全库训练/完成/草稿数及各自实际首末 localDate（无数据为 null），不是查询范围；authentication 为 access 或 local_mock。

## 日期、列表与记录

日期支持 1900–9999 年真实 ISO 日期。训练 startedAt 为 UTC RFC3339，timezone 为 IANA，localDate 由服务器派生。查询 `from <= localDate < to`，范围 1–366 天；缺省 to 为 UTC 明日，from 为 to 前 28 天，**默认边界用 UTC 日历，归属仍用各训练 localDate**。9999 年最后一天无法用超出支持范围的 exclusive to 完整包含。

列表 limit 默认 25、最大 100。动作 query/kind/includeArchived 筛选，按 BINARY name ASC/id ASC；训练 from/to/status/kind/exerciseId/includeNotes 筛选，按 localDate DESC/startedAt DESC/id DESC。meta.nextCursor 为空表示本次遍历结束；游标绑定筛选。Agent 备注默认 null，显式 includeNotes=true 才读取。

动作 POST 接受严格创建契约；PATCH 仅展示字段、archived，计量语义变化须新建动作。训练 POST 要求固定 `Idempotency-Key`；相同 key/正文重放原始响应并标记 meta.replayed，不同正文 409。PUT/DELETE、动作 PATCH、设置 PATCH 使用 `If-Match: "<version>"`，不另设正文版本方案。训练创建/更新/删除由 D1 batch 与事务守卫保护，新增引用原子核对动作版本/归档，历史条目保留原始快照。客户端不提交计量快照。

单训练最多 50 条目、每条 50 组、合计 300 组，备注各 4000 字符、请求 512 KiB（序列化 JSON 的 UTF-8 字节，客户端在冻结提交前预检，后端限制不放宽）。API 重量最多三位小数 kg，存储整数 g；null 不等于 0。完成训练不能包含未完成或计量不完整明细，草稿不计统计。

## 统计

summary 接受 from/to、granularity=day/week/month（默认 week）；strength 需 exerciseId，可 includeWarmup（默认 false）；cardio 可 category、durationBasis=elapsed/moving。三个接口只计完成父与完成明细，返回定义版本、范围、质量/缺失/排除计数。每次读取统计明细上限 10000，超限 422 STATS_RANGE_TOO_DENSE，要求缩小范围，绝不返回截断统计。

容量按单动作历史快照计算 loadKg × reps × volumeMultiplier；自重/辅助/计时/未知倍率等排除，不跨动作吨位合计。配速按同项目/同 basis 的有效时长与距离总和之比，不平均逐条配速。全 null 距离组 paceSampleCount=0，配速/速度 null。整次时长与有氧时长独立，不相加。

质量键与中文标签集中在 `src/shared/stats.ts` 的 qualityLabels/QualityKey/qualitySchema，生成 OpenAPI 同步限制合法键，未知键拒绝以暴露漂移；完整键见 Skill 数据字典。

## 设置、附件与恢复边界

GET settings 纯读；无行时虚拟 UTC/auto/zh-CN/metric、version=1、createdAt/updatedAt=1970-01-01T00:00:00.000Z。首次有效 PATCH（If-Match 1）才在 batch 中持久化并递增版本；错误版本不初始化。修改时区不重写历史 localDate。

GET export 默认 format=json；CSV 使用 format=csv 与 dataset=workouts/strengthSets/cardioRecords（默认 workouts）；JSON 不接受 dataset。JSON 包含版本、导出时间、实际 settings 或 null、完整动作（含归档）、训练（含草稿）、entries/strengthSets/cardioRecords、ID/快照/备注，不含凭证与幂等技术表。CSV 使用 csv-stringify 转义与公式注入防护，重量单位 kg。

一次 D1 读取 batch 保持一致视图。所有导出先受 150000 行与 20 MiB **保守预算**约束（文本字节加每行 2 KiB，可能在实际附件不足 20 MiB 时拒绝），另检查最终字节数；超限 413 EXPORT_TOO_LARGE，不静默截断，CSV 同样先通过完整快照预算。需更大备份时使用另行授权的受控数据库流程。

`scripts/restore-local.py` 只接受版本化 JSON，恢复到**不存在的新本地 SQLite 文件**，校验版本、引用、快照计量语义、完成父子、外键与数量，拒绝覆盖和 --remote。不恢复远端 D1，不提供上传 UI；CSV 不是完整恢复格式。

## 本轮数值与日期安全契约（设计 1.6）

共享 `NUMERIC_LIMITS` 及生成 OpenAPI 为准：时长 1–31536000 整秒，次数 1–1000000，心率 1–1000 整数，距离为 0 或 0.001–100000000 米，爬升 0–10000000 米，阻力 0–1000000，设备热量 0–100000000 kcal，倍率 0.001–1000。重量 0–10000 kg/三位小数、坡度 ±100、effort 原约束不变，null 仍为缺失。限制是宽裕资源安全界限，不是医疗阈值，不改变常规统计定义。统计范围内旧超界操作数、非有限/绝对值超过 MAX_SAFE_INTEGER 的累计或派生结果返回 422 `STATS_NUMERIC_OUT_OF_RANGE`，要求修正记录或缩小累计范围，不静默丢样本或当零。动作 query/param 格式错误 400，JSON 业务错误 422。

前端无限分页将首响应 from/to 放入后续 pageParam；主动刷新重算首范围，筛选切换使用新 queryKey，旧 cursor 在不同筛选仍被拒绝。分页不是并发快照备份。

恢复在创建目标前验证 exportedAt、全部 createdAt/updatedAt/archivedAt/startedAt/localDate 的类型及真实 UTC ISO 格式；不接受数字时间、偏移形式或无时区。workout 日期限 1900–9999，其他 ISO 审计年份允许 0000–9999，与 TS 一致。localDate 必须符合 startedAt + IANA timezone。历史名称/计量快照保持不变，不用当前动作覆盖。

本次独立复评追加修复（设计 1.6）：新写入继续使用严格安全范围，历史详情/列表/动作/JSON backup 使用兼容旧 finite 非负范围的 read schema（正整数保持 MAX_SAFE_INTEGER），不再将新写上限施加于已有记录。旧 distance=100000001 详情及完整导出 200，前端共用 toInput 可保留旧值供用户修正，修正 PUT 后统计 200。TS backup 与 Python restore 均保留旧 duration=31536001、次数及倍率，不重写快照。统计只检查实际选中操作数；run 超界不阻断 cycle/strength，未完成明细和默认排除热身不参与检查。summary 不计算配速，因此极小正距离本身不构成 summary 错误。受控 422 仍用于真正选中超界计算，绝不静默丢弃。

## 受控导入增量（1.8 / 1.9）

单 AUD 保持；默认 service 只读，精确 ACCESS_IMPORT_TOKEN_IDS 授权的已验 service 增加 metadata capabilities `exercises:create` 与 `workouts:create`，仅 POST `/api/agent/v1/exercises` 与 `/api/agent/v1/workouts`。总体 ACCESS_SERVICE_TOKEN_IDS 仍先检查。空/非法导入配置 fail closed，未配置不授权。human 管理入口不接受任何 service；所有 Agent PUT/PATCH/DELETE、POST settings/export/未知路径拒绝。读取命令仍为严格 GET 白名单。OpenAPI 允许文档出现条件 POST /workouts 与 /exercises，绝不执行文档中的任意 URL。

Agent 动作创建接受可选客户端选定稳定 UUID（供批量导入前向引用），必须 `Idempotency-Key` 与 application/json；同 key 同正文重放原始响应并标记 meta.replayed，同 key 异正文 409 IDEMPOTENCY_CONFLICT，同名 409 EXERCISE_EXISTS，指定 UUID 已占用 409 EXERCISE_ID_EXISTS。创建在单个原子 D1 batch 中条件执行：同名/同 ID 竞争不落地，replay 记录仅在动作行真实写入时生成，失败整体回滚；新建动作固定非内置、未归档。人类管理仍保留同名动作能力，故不施加 schema 级名称唯一约束。Agent 不修改、归档或删除动作，不更新/删除历史训练。

缺失动作由批量 JSON `exercises` 列表声明（客户端选定 UUID + 完整拟定语义），计划列出待审批表；用户确认计划后导入身份先创建动作、再创建训练。同名、无引用声明、能力缺失均 fail closed；Skill 详见 references/api.md。
