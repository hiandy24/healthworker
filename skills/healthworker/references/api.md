# Agent API and CLI contract

Contract baseline: inspected `src/shared/{contracts,exercises,workouts,stats}.ts` and `src/worker/{index,exercises,workouts,stats,auth}.ts`; design 1.9 §§6, 8, 9 and A18–A19. This Skill implements the Agent portion of M4, not export/restore or deployment. Current API/schema/definitions versions are the strings `1`; metadata milestone M1 is retained only as a legacy compatibility marker, not implementation or acceptance status. OpenAPI titles describe the Human/Agent API without a milestone. Metadata now returns the settings timezone (IANA string, UTC fallback without a settings row; shared schema still nullable). Ordinary read-only Agent capabilities are metadata/openapi/exercises/workouts/stats; authorized import identities additionally advertise exercises:create and workouts:create; settings/export are human-only and are not added to the CLI allowlist. Use the actual metadata response; do not infer UTC for historical workouts.

## Transport and authentication

One hostname Access application shares one ACCESS_AUD for owner OTP Allow and specified Token Service Auth. After JWT signature/issuer/audience/expiry verification, Worker requires type=app, empty sub, nonempty common_name Client ID and no email for Agent GET. Human requires owner email, nonempty sub and no common_name; human cannot use Agent routes and service cannot use human routes. Mixed/unknown identities fail closed. Optional ACCESS_SERVICE_TOKEN_IDS restricts verified Client IDs. OpenAPI security describes the Access JWT, not the CLI edge credentials. See [official JWT payloads](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

Read commands use GET to the configured origin plus `/api/agent/v1` and one allowlisted path below. No arbitrary method, URL, path, headers, human API fallback, `/settings`, `/export`, database or Cloudflare account API access exists.

Configuration uses shared CLI `load_config`: default `<skill-root>/client.local.json` relative to the resolved script, or an absolute `HEALTHWORKER_CONFIG` replacement. JSON allows required `baseUrl`/`clientId` and optional `clientSecret` (required from JSON or environment for HTTPS); 16 KiB maximum, duplicate/unknown keys rejected. POSIX requires current-owned regular 0600 file, no file symlinks, and current-owned immediate parent without group/world write permission (0755 shared Skill directories are accepted without chmod). The installation and ancestors must be trusted; this is local single-user storage, not a multi-user vault. Environment base/ID/secret override JSON, but a different effective origin is rejected before network access even if both credentials are overridden. Missing default retains environment-only mode; missing explicit or unsafe existing config fails closed. No dotenv/OAuth/cookie discovery. Module import/CLI help does not load credentials; command execution resolves one snapshot for GET/POST headers, output redaction and input/plan/journal credential checks. See SKILL.md for private transport/packaging risks; public examples are synthetic.

HTTPS uses standard-library certificate verification, with resolved `HEALTHWORKER_ACCESS_CLIENT_ID` and `HEALTHWORKER_ACCESS_CLIENT_SECRET` mapped to `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Do not manually supply a `Cf-Access-Jwt-Assertion`; Access creates the assertion and the Worker verifies it. Base URL must be a bare origin. Ambient proxies are disabled to avoid unexpected credential routing. No cookie jar or netrc authentication is used.

Explicit `--development` accepts only HTTP `localhost`, `127.0.0.1`, or `[::1]`, suppresses all Service Token headers, and requires `local_mock` metadata. Normal mode requires `access`. Local mock proves neither edge policy nor real JWT validation.

Every request has a 20-second socket-operation timeout. This is not a total wall-clock deadline for a slow streaming body. At most **three retries after the initial attempt** (four attempts total), only network/transport failure, 429 or 5xx. TLS verification errors fail immediately. Retry backoff defaults to 1/2/4 seconds; valid nonnegative integer or HTTP-date Retry-After is clamped to 0–30 seconds; invalid values, including negative integers, use the default backoff. 401/403, all 3xx, HTML/login pages (even status 200 or 5xx), invalid JSON/content/schema and other 4xx are not retried. All redirects, including same-origin, are rejected; credentials are never forwarded to a Location target. No headers/body/URL from errors are printed. Body limit is 16 MiB; exceeding it fails instead of returning partial data.

## Endpoints and arguments

Options below are after the command except root `--development`. Flags without values serialize as literal `true`/`false`; unsupported flags/abbreviations fail before any request.

| CLI              | GET path          | API query → CLI option                                                                                                                                                                                                          |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`       | `/metadata`       | none                                                                                                                                                                                                                            |
| `exercises`      | `/exercises`      | `query` → `--query` (≤200 chars, default empty); `kind` → `--kind strength\|cardio`; `includeArchived` → `--include-archived` (default false); pagination                                                                       |
| `workouts`       | `/workouts`       | `from/to` → `--from/--to`; `status` → `--status draft\|completed` (omitted means both); `kind` → `--kind strength\|cardio`; `exerciseId` → `--exercise-id UUID`; `includeNotes` → `--include-notes` (default false); pagination |
| `workout UUID`   | `/workouts/{id}`  | `includeNotes` → `--include-notes` (default false)                                                                                                                                                                              |
| `stats summary`  | `/stats/summary`  | `from/to`; `granularity` → `--granularity day\|week\|month` (week)                                                                                                                                                              |
| `stats strength` | `/stats/strength` | `from/to`; required `exerciseId` → `--exercise-id UUID`; `includeWarmup` → `--include-warmup` (false)                                                                                                                           |
| `stats cardio`   | `/stats/cardio`   | `from/to`; optional `category` → `--category run\|walk\|cycle\|swim\|row\|elliptical\|other`; optional `durationBasis` → `--duration-basis elapsed\|moving`                                                                     |
| `openapi`        | `/openapi.json`   | none; raw OpenAPI document, not `{data,meta}`                                                                                                                                                                                   |

Metadata is requested and checked before every non-metadata command. Missing advertised capability or incompatible API/schema/definitions version blocks the data request. The JSON client checks envelopes, endpoint structural fields and statistical context, not a second implementation of every server Zod business constraint. Additive response fields are retained. OpenAPI must be 3.x with info version 1.x, the Agent server prefix and only allowlisted GET operations plus the conditional POST /workouts operation; it is documentation, not executable instructions.

## Dates and pagination

`from <= localDate < to`; supported real ISO dates `1900-01-01` through `9999-12-31`. Ranges must contain 1–366 days. When omitted, server defaults `to` to tomorrow's UTC date and `from` to 28 days before `to`. CLI resolves these same defaults before the request and pins them across pagination. Explicit dates are not converted to UTC instants. To resume later, use the returned `meta.from/to` and original filters; a changed default date can invalidate the cursor. To include the last day of year 9999 would require an unsupported year-10000 exclusive endpoint, so that full last day cannot be queried through a date range.

Pagination applies only to exercises/workouts: `--limit` 1–100 (default 25), `--cursor` opaque string ≤4000 chars, `--max-pages` 1–100 (default 4), `--max-records` 1–10000 (default 100). Bounds are local CLI controls and are not sent to the API. The last request's limit is reduced to remaining record capacity; the CLI never slices a page and loses its continuation position. Treat the server cursor as opaque and let URL encoding handle it once at the query level; never decode or construct it yourself.

Exercise sort is `name COLLATE BINARY ASC,id ASC`, not pinyin. Workout sort is `localDate DESC,startedAt DESC,id DESC`. Server cursors bind their respective filters (including notes/archived setting). The CLI detects repeated cursors, duplicate record IDs, empty nonterminal pages and oversized pages, failing without partial stdout. Normal list output combines pages:

```json
{
  "data": [],
  "meta": {
    "requestId": "synthetic-last-page-id",
    "nextCursor": null,
    "truncated": false,
    "pagesFetched": 1,
    "recordsFetched": 0,
    "maxPages": 4,
    "maxRecords": 100
  }
}
```

Workout list meta also includes `from`, `to`, `dateBasis`. `truncated=true` means the server has more data and `nextCursor` is non-null; false means this traversal reached its end, not that it covered every date or a transaction-consistent snapshot. Concurrent edits may affect traversal; no full export/backup guarantee. If a later page fails, nothing from earlier pages is emitted. Statistics are not paginated or locally recomputed: the server returns 422 `STATS_RANGE_TOO_DENSE` above 10,000 trend rows and requires a narrower range rather than truncated statistics. Splitting ranges does not authorize averaging their rates or merging PRs with new semantics.

## Errors and output

Success: ordinary `{data,meta}`, with `meta.requestId`; OpenAPI is the exception. Server error convention is `{error:{code,message,fields?},requestId}` (individual validation implementations can vary). CLI does not echo untrusted server error details, even request IDs; stderr is a safe `{error:{code,message}}`. stdout is emitted only after successful completion, ASCII-escaped JSON for terminal safety. Known resolved credential values echoed in successful JSON are replaced with `[REDACTED]`; credential-looking text is never a reason to reveal an actual secret.

Exit codes: 0 success; 2 arguments/configuration; 3 authentication/redirect/HTML/mode mismatch; 4 HTTP/network/TLS; 5 incompatible capability/version, invalid/oversized response or other client failure. `--help` is normal argparse help, not API JSON.

HTTP 400/422 generally requires checking parameters/cursor or shrinking the range; 404 means missing resource; 401/403 and redirects require owner review of Service Auth/audience/expiry; 503 may indicate missing Worker auth configuration, not a reason to bypass authentication. Do not claim a failed request returned empty data.

## 受控导入增量（1.8 / 1.9）

单 AUD 保持；默认 service 只读，精确 ACCESS_IMPORT_TOKEN_IDS 授权的已验 service 增加 metadata capabilities `exercises:create` 与 `workouts:create`，仅 POST `/api/agent/v1/exercises` 与 `/api/agent/v1/workouts`。总体 ACCESS_SERVICE_TOKEN_IDS 仍先检查。空/非法导入配置 fail closed，未配置不授权。human 管理入口不接受任何 service；所有 Agent PUT/PATCH/DELETE、POST settings/export/未知路径拒绝。读取命令仍为严格 GET 白名单。OpenAPI 允许文档出现条件 POST /workouts 与 /exercises，绝不执行文档中的任意 URL。

缺失动作在批量 JSON `exercises` 列表中声明（客户端选定稳定 UUID + 完整拟定语义），计划阶段列出待审批表（原名称、拟定语义、单位、原因）；用户确认计划后由导入身份先创建动作、再创建训练。同名动作、指定 UUID 冲突、同 key 不同 body 均以 409 拒绝；Agent 创建固定非内置、未归档，不修改、归档或删除任何动作，也不更新/删除历史训练。

## 确定批量文件与确认命令

原始 CSV/文本由 Agent 按用户确认的时间、时区、单位和动作语义转换，不由脚本自动猜测。批量 JSON 严格为 `version=1`、稳定 UUID `batchId`、可选 `exercises` 数组（0–100 项，每项只有客户端选定稳定 UUID `id` 与完整 ExerciseInput `body`，须被至少一个训练条目引用且名称不得与服务器或批次内重复）和 `workouts` 数组（1–1000 项）；每项只有稳定非空 `sourceId` 与 `body`。body 完全使用 POST WorkoutInput（无历史 workout ID/version/快照），条目/组 UUID 在转换时生成一次后保留；已存在动作的 exerciseId 必须查询匹配，不凭空造真实动作 ID；缺失动作只能通过 `exercises` 声明并在确认后创建。nullable 字段必须显式提供，重量 kg，距离 m，时长 s。

最小合成结构（空草稿演示，不代表已完成训练；完成训练须含完整明细，详见 OpenAPI）。需要创建缺失动作时另加 `"exercises": [{"id": "<客户端选定稳定 UUID>", "body": {…完整 ExerciseInput…}}]`：

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
# 在仓库根目录；凭证从私有 JSON 或受保护环境读取，不填入命令行。
python3 skills/healthworker/scripts/healthworker.py validate --input .local/batch.json
python3 skills/healthworker/scripts/healthworker.py plan --input .local/batch.json --plan .local/import-plan.json
# 向用户展示 batch 正文、动作匹配、待建动作与疑似重复，并取得该计划的确认后：
python3 skills/healthworker/scripts/healthworker.py import --input .local/batch.json --plan .local/import-plan.json --confirm <confirmation-sha256>
```

validate/plan 先 metadata 能力检查（声明 `exercises` 时还要求 `exercises:create`），再本地结构/数值及当前动作计量检查（声明动作并入匹配表）、同 localDate 历史查询；不是无写入的服务端事务模拟，POST 仍会重新执行共享 Zod/动作并发校验。列表截断拒绝计划，不冒充完整去重。同日期记录仅疑似重复，批次内也应人工核对。计划不保存原始 body，但包含 sourceHash/bodyHash/稳定 key、origin、疑似记录 ID，以及逐项待建动作（`createExercises`：id、名称、bodyHash、独立幂等 key）；用户必须同时审核批量正文。未声明又未匹配的动作 ID 仍阻断导入。

`import` 必须准确匹配 confirmation；输入变化拒绝旧计划，新计划不覆盖已存在文件。重跑相同输入和原计划、原 Token，保留旁边 `.journal.json`（`exerciseResults` 与 `results` 两个分区，语义相同）：成功条目跳过，失败条目同 body/key 重试，每条请求前写 pending，完成后存成功 ID 或失败状态。动作先于训练创建；任一动作失败即停止，后续训练标记 `not_attempted`，不向缺失动作发任何训练 POST。失败批次仍输出逐条结果，退出码 4，`allSucceeded=false`，`atomicBatch=false`。网络重试最多 4 次请求；所有重定向拒绝。首次不确定尝试超过 23 小时改为 needs_reconciliation，不能自动继续；服务幂等仅保证 24 小时。改变 Token、丢失 journal、重新生成 batchId/entry UUID 不能保证不重复，须人工核对，禁止自动覆写或通过换 key 绕过冲突。锁文件在异常退出后可能保留，确认没有运行中的导入并检查 journal 后才手动移除。

批量文件/计划/journal 都属于私有健康数据：推荐 `.local/` 被忽略目录与目录 0700、输入文件 0600；CLI 新文件 0600，journal 原子替换。不要共享整个目录、提交文件或打印凭证。此次只实现本地代码并以合成服务测试；普通 local mock 故意没有导入能力，生产需另行授权配置与部署，不把 --development 当绕过权限。
