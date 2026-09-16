# Current read contract and statistical semantics

JSON uses camelCase. Null means missing/not applicable, not zero. Fields below describe the current shared DTOs and Worker computations; settings/export are now implemented for the human API, not exposed to this Agent Skill. Use the protected `openapi` command for machine-readable schema detail. Python does not duplicate backend calculations.

## Authentication boundary (design 1.8)

`authentication=access` means the Worker verified the shared application JWT and enforced the route identity; it does not expose claims or credentials and is not proof of deployment acceptance. Agent is service-only: type=app, sub="", common_name=verified Service Token Client ID, no email; human owner is denied here. See [authentication contract](api.md#transport-and-authentication). No data/schema/definitions version changes.

## Metadata

`apiVersion`, `schemaVersion`, `definitionsVersion` are strings `1`. `milestone=M1` is a legacy compatibility marker, not current implementation or acceptance status; ordinary read-only Agent capabilities are `metadata`, `openapi`, `exercises`, `workouts`, `stats`; authorized import identities additionally advertise `exercises:create` and `workouts:create`. Human metadata additionally advertises `settings` and `export`; these are not Agent routes. `timezone` now comes from the singleton settings' IANA timezone; when no settings row exists, `readSettings` returns a virtual UTC/auto/zh-CN/metric default (version 1, epoch audit times). UTC fallback does not prove the user confirmed that timezone. The shared metadata schema still permits null for compatibility. The current default does not replace each historical workout's timezone/localDate, and changing settings does not rewrite history. Omitted stats/history date ranges still use UTC calendar defaults, not this setting. `authentication` is `access` or explicit local `local_mock`.

`units`: load `kg`, storageLoad `g`, distance `m`, duration `s`, heartRate `bpm`. Storage grams are not the API load unit. `dateBasis=workout_local_date`, `rangeSemantics=[from,to)`, `weekStartsOn=monday`, `warmupDefault=exclude`.

`coverage`: `dateBasis`, `workoutCount`, `completedWorkoutCount`, `draftWorkoutCount`, `firstLocalDate`, `lastLocalDate`, `firstCompletedLocalDate`, `lastCompletedLocalDate`. Dates are nullable when no corresponding records exist. Coverage is database-wide, not the selected range; extrema are actual inclusive record dates, not a ready-to-use exclusive `to`.

## Exercise

`id` UUID; `name`, `aliases[]`, `kind` (`strength`/`cardio`), nullable `equipment`, `muscleGroups[]`, nullable `cardioCategory` (`run/walk/cycle/swim/row/elliptical/other`), `isBuiltin`, nullable `archivedAt`, `createdAt`, `updatedAt`, positive `version`.

Measurement fields are top-level on exercises, and inside immutable `measurementSnapshot` on historical entries:

- `measurementMode`: `reps`, `duration`, `cardio`.
- `resistanceMode`: `external`, `bodyweight`, `assisted`; null for cardio.
- `loadConvention`: `total`, `per_implement`, `none`.
- `repConvention`: `total`, `per_side`, `not_applicable`.
- `volumeMultiplier`: positive number or null; meaningful only for explicitly supported external-load repetition movements. Never infer a dumbbell or unilateral multiplier from a name.

Archived actions remain in history; list lookup excludes them unless requested. Display names may change; historical name/measurement snapshots retain the original semantics. Current Worker strength calculations use snapshots, not edited labels.

## Workout list and detail

Summary fields: `id`, UTC RFC3339 `startedAt`, IANA `timezone`, derived `localDate`, `status` (`draft`/`completed`), nullable `durationSeconds`, nullable `notes`, positive `version`, UTC `createdAt/updatedAt`, `entryCount`, `kinds[]`. Mixed workouts may contain both kinds. List has no `entries` or sets; do not mistake entryCount for set count. Same-day workouts are distinct workouts.

Detail adds ordered `entries[]`: `id`, `exerciseId`, `position`, `kind`, `exerciseNameSnapshot`, `measurementSnapshot`, nullable `notes`, and either `sets[]` or `cardio`. Repeating an exercise in a workout is allowed with different entry IDs/positions. Server supplies snapshots. With `includeNotes=false`, workout, entry and strength-set notes are **null**, not removed; CLI also suppresses any returned notes defensively. Cardio record itself has no notes property (entry does).

Strength set: `id`, `position`, `setType` (`warmup`/`working`), `completed`, nullable `reps`, nullable `durationSeconds`, nullable `loadKg`, nullable `assistanceKg`, nullable `effortType` (`rpe`/`rir`), nullable `effortValue`, nullable `notes`. Completed repetition and duration modes are mutually exclusive. Loads are nonnegative kg up to 10,000 with ≤3 decimal places; explicit 0 is valid. External load requires loadKg; assisted requires assistanceKg and no loadKg; bodyweight may have extra load but no body-mass history is available. RPE 1–10 in half steps; RIR 0–10 integer. Draft/incomplete fields can be missing.

Cardio: `completed`, nullable positive `durationSeconds`, `durationBasis` (`elapsed`/`moving`), nullable nonnegative `distanceMeters`, `averageHeartRate`, `maxHeartRate` (positive bpm, average ≤ max when both known), nullable nonnegative `elevationGainMeters`, `inclinePercent` (−100 to 100), nonnegative `resistanceLevel`, nonnegative `deviceCaloriesKcal`. Distance zero is known zero but cannot produce a rate. Device calories are estimates, resistance levels are not comparable across machines, and elapsed/moving must stay separate.

## Shared statistics context and quality

All three data objects contain `definitionsVersion=1`, `dateBasis=workout_local_date`, `from`, exclusive `to`, `status=completed`, `warmup` and `granularity`, plus `quality={validSamples,missing,excluded}`. Only completed workouts and completed relevant records/sets count. Quality maps contain nonnegative counts; allowed keys are centralized in shared qualityLabels/QualityKey/qualitySchema and generated OpenAPI, unknown keys are rejected to expose drift; different reasons can overlap and should not be blindly summed. Statistics themselves are not list-page results.

### Summary

`granularity=day/week/month`; `warmup=not_applicable`. `totals` and each `buckets[]` item have:

- `workoutCount`: distinct completed workouts.
- `recordedDurationWorkoutCount`, `durationSeconds`: coverage count and sum of recorded **whole workout** durations.
- `durationCoverage`: recorded count/workout count, null when no workouts.
- `strengthWorkoutCount`, `cardioWorkoutCount`: mixed workouts may count in both.
- `cardioDurationSeconds`: completed cardio durations, independent of whole-workout duration; never add the two.

Buckets add `bucketStart` (Monday/week or natural month/day boundary), clipped `from/to` for partial edge buckets. Empty buckets have zero known sums/counts, not invented measurements.

`cardioByCategory[]`: `category`, `durationBasis`, `recordCount`, `durationSeconds`, `distanceMeters`, `distanceSampleCount`. This is not a pace series. Distance sum uses known values including zero; interpret alongside coverage.

Quality: validSamples counts workouts; missing keys `workoutDuration`, `cardioDistance`; excluded `draftWorkouts`.

### Strength (one exercise)

`exerciseId`, `granularity=workout`; `warmup=exclude` unless explicitly include. `totals` and `workouts[]` metrics: `setCount`, `workingSetCount`, `warmupSetCount`, `reps`, `durationSeconds`, nullable `maxLoadKg`, nullable `volumeKgReps`, `volumeSampleCount`. Workout rows add `workoutId`, `localDate`, `startedAt` in ascending chronology. `setCount` includes selected warmup when enabled; reps retain the action's recorded convention, not inferred bilateral reps.

Backend volume: sum `loadKg × reps × snapshot.volumeMultiplier` only for eligible external-load repetition sets. Null volume means no eligible samples; an eligible zero load can produce 0. Bodyweight, assisted, duration, unknown multiplier and missing measurements are excluded. Never aggregate across actions as whole-body tonnage.

`records` contains nullable `maxLoad`, nullable `longestDuration`, and `mostRepsByResistance[]`. Record identity/data: `workoutId`, `localDate`, `startedAt`, `entryId`, `setId`, `loadKg`, `assistanceKg`, `reps`, `durationSeconds`; resistance-group records add `resistanceMode`. Records are actual results **within the requested range and selected warmup policy**, not automatically lifetime PRs. Repetition groups partition by resistanceMode/loadKg/assistanceKg; do not compare assisted reps at different assistance, or null bodyweight added load to known zero. No estimated 1RM.

Quality validSamples = selected setCount; missing keys `load`, `assistance`, `reps`, `duration` (load can be naturally absent in assisted/bodyweight modes). Excluded keys `draftSets`, `incompleteSets`, `warmupSets` plus present volume-exclusion keys `bodyweight`, `assisted`, `duration`, `unknownMultiplier`, `missingLoad`, `missingReps`. Volume classification chooses one reason per selected set in that order; omitted reason keys mean absent counts, not measurements. Excluded volume sets may still contribute valid reps/duration.

### Cardio

`granularity=record`, `warmup=not_applicable`; top-level selected `category`/`durationBasis` are required fields but nullable when unfiltered. In every `groups[]` and `records[]` row, both fields are required non-null strings: category is `run/walk/cycle/swim/row/elliptical/other`, durationBasis is `elapsed/moving`. Missing, null or unknown nested dimensions are invalid responses, not unfiltered samples. `heartRateDefinition=record_mean_duration_weighted_estimate`.

`groups[]` partition by `category` and `durationBasis`, with `recordCount`, `durationSeconds`, `distanceMeters`, `distanceSampleCount`, `elevationGainMeters`, `elevationSampleCount`, `paceSampleCount`, `paceDurationSeconds`, `paceDistanceMeters`, nullable `speedKmh`, nullable `paceSecondsPerKm`, nullable `paceSecondsPer100m`, `heartRateSampleCount`, `heartRateDurationSeconds`, nullable `averageHeartRate`.

Pace eligibility requires both positive duration and positive distance. `paceSampleCount` is a nonnegative integer and is 0 when every distance is missing (the Worker uses CASE/ELSE 0 rather than a nullable predicate sum); corresponding rates remain null. Backend speed uses eligible distance/duration ×3.6 km/h. Pace is eligible total duration/total distance ×1000 seconds/km for run/walk, ×100 seconds/100m for swim; non-applicable pace fields are null. Other categories still have speed where eligible. Do not average per-record rates or divide all-duration by partial-distance sums.

`records[]` retain individual `workoutId`, `entryId`, `exerciseId`, `localDate`, `startedAt`, `category`, `durationBasis`, `durationSeconds`, nullable distance/heart rates/elevation and the rate fields. Aggregate heart rate is a duration-weighted estimate from records with known average heart rate, not a continuous sample mean. No maximum-heart-rate aggregate is supplied.

Quality validSamples = completed records; missing keys `distance`, `heartRate`, `elevation`; excluded `draftRecords`, `incompleteRecords`, `paceMissingDistance`, `paceZeroDistance`. A zero distance counts as a recorded distance sample but not a pace sample. Known distance/elevation sums may be zero even when no measurements exist; always report their sample counts.

## 本轮数值与日期安全契约（设计 1.5）

共享 `NUMERIC_LIMITS` 及生成 OpenAPI 为准：时长 1–31536000 整秒，次数 1–1000000，心率 1–1000 整数，距离为 0 或 0.001–100000000 米，爬升 0–10000000 米，阻力 0–1000000，设备热量 0–100000000 kcal，倍率 0.001–1000。重量 0–10000 kg/三位小数、坡度 ±100、effort 原约束不变，null 仍为缺失。限制是宽裕资源安全界限，不是医疗阈值，不改变常规统计定义。统计范围内旧超界操作数、非有限/绝对值超过 MAX_SAFE_INTEGER 的累计或派生结果返回 422 `STATS_NUMERIC_OUT_OF_RANGE`，要求修正记录或缩小累计范围，不静默丢样本或当零。动作 query/param 格式错误 400，JSON 业务错误 422。

前端无限分页将首响应 from/to 放入后续 pageParam；主动刷新重算首范围，筛选切换使用新 queryKey，旧 cursor 在不同筛选仍被拒绝。分页不是并发快照备份。

恢复在创建目标前验证 exportedAt、全部 createdAt/updatedAt/archivedAt/startedAt/localDate 的类型及真实 UTC ISO 格式；不接受数字时间、偏移形式或无时区。workout 日期限 1900–9999，其他 ISO 审计年份允许 0000–9999，与 TS 一致。localDate 必须符合 startedAt + IANA timezone。历史名称/计量快照保持不变，不用当前动作覆盖。

本次独立复评追加修复（设计 1.6）：新写入继续使用严格安全范围，历史详情/列表/动作/JSON backup 使用兼容旧 finite 非负范围的 read schema（正整数保持 MAX_SAFE_INTEGER），不再将新写上限施加于已有记录。旧 distance=100000001 详情及完整导出 200，前端共用 toInput 可保留旧值供用户修正，修正 PUT 后统计 200。TS backup 与 Python restore 均保留旧 duration=31536001、次数及倍率，不重写快照。统计只检查实际选中操作数；run 超界不阻断 cycle/strength，未完成明细和默认排除热身不参与检查。summary 不计算配速，因此极小正距离本身不构成 summary 错误。受控 422 仍用于真正选中超界计算，绝不静默丢弃。

## 受控导入增量（1.8 / 2.0）

单 AUD 保持；默认 service 只读，精确 ACCESS_IMPORT_TOKEN_IDS 授权的已验 service 增加 metadata capabilities `exercises:create` 与 `workouts:create`，仅 POST `/api/agent/v1/exercises` 与 `/api/agent/v1/workouts`。总体 ACCESS_SERVICE_TOKEN_IDS 仍先检查。空/非法导入配置 fail closed，未配置不授权。human 管理入口不接受任何 service；所有 Agent PUT/PATCH/DELETE、POST settings/export/未知路径拒绝。读取命令仍为严格 GET 白名单。OpenAPI 允许文档出现条件 POST /workouts 与 /exercises，绝不执行文档中的任意 URL。

缺失动作在批量 JSON `exercises` 列表中声明（客户端选定稳定 UUID + 完整 ExerciseInput，语义字段同动作读取契约），计划阶段列出待审批表；用户确认计划后由导入身份先创建动作、再创建训练。Agent 创建固定非内置、未归档；同名动作、指定 UUID 冲突、同 key 异正文 409；动作创建失败即停止导入且后续训练 not_attempted。Agent 不修改、归档或删除动作，不更新/删除历史训练。
