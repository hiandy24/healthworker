# 已知缺口与历史台账（动手前先读）

这里记录**不得作为"新发现"重复上报**的条目。它们要么已被仓库文档承认，要么是设计明确接受的权衡。复核后如事实变化，可以更新"状态"列，但不要删除来源引用——引用是这份清单可信的前提。

## 1. 已被文档承认的能力与验收缺口

| 条目                                                                                                                       | 来源                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 未部署，M5 未做；真实 Access、Service Token、单 AUD 身份隔离边缘策略未验收（A12）                                          | `README.md`「未部署，M5 未做」；`docs/design.md §13 M5`、`§12.1`                                           |
| 无浏览器 E2E：没有 `tests/e2e/`，`package.json` 无 `test:e2e`                                                              | `README.md`「当前脚本还包括…没有 test:e2e、deploy 或 db:migrate:remote」；`docs/design.md §10`             |
| 视口、键盘、200% 缩放、明暗主题、加载/失败状态、真机（A16、A17）未验收；IAB click timeout / snapshot 空 / 截图失败导致阻塞 | `docs/reviews/m2.md`、`m3.md`、`m4.md` 的「GUI 与验收边界」；`README.md`「浏览器验收：部分完成且工具阻塞」 |
| 性能目标（2000 训练 / 100000 组，p95 < 1s）未测量                                                                          | `docs/design.md §12.3`；`docs/deployment.md`「未做 p95 参考规模实测」                                      |
| 生产入口、备份、限流未配置；生产配置清单 1–6 条未执行                                                                      | `docs/deployment.md`「生产配置清单」「阻塞与 M5 验收」                                                     |
| 设计 1.7 已授权单 AUD，原私有 human AUD 可作为来源；真实身份分类/策略未验收                                                | `.local/deployment-notes.md`（私有，勿在报告中引用真值）                                                   |
| `metadata.milestone='M1'` 只是旧契约兼容标记，不代表能力或验收状态                                                         | `docs/design.md` 1.3 变更记录；`docs/api.md`「Metadata」                                                   |

## 2. 设计明确接受的权衡（不是缺陷）

- 备注单条 ≤ 4000 字符、单训练 ≤ 50 条目 / 50 组每组 / 合计 300 组、请求体 ≤ 512 KiB；上限集中定义，可依需求调整（`design §6.1`）。UI 上限与服务端上限的极端组合（大量长备注）由用户自行缩小规模，属已知张力。
- 导出先过 150000 行与 20 MiB **保守预算**，可能在实际附件不足 20 MiB 时就拒绝（`design §11.1`、`docs/api.md`）。
- CSV 是查阅格式、不是恢复格式；`restore-local.py` 只恢复到**不存在的新本地 SQLite**，不提供远端 D1 恢复（`design §11.1`）。
- 统计单次读取明细上限 10000，超限 422 要求缩小范围，不截断（`design §5`）。
- 第一版不提供英制、不做动作合并、不算 1RM、不做自动建议与医疗判断（`design §1.4`、`§4.2`、`§5.3`）。
- 静态 CSP 允许 `style-src 'unsafe-inline'`（Mantine 需要），脚本不使用 `unsafe-eval`（`docs/deployment.md`「安全头与边界」）。

## 3. 已知工具/上游提示

- Zod 上游 `@__PURE__` 注释导致 Rollup 警告，不影响构建（`README.md`、`docs/deployment.md`）。
- drizzle-kit 的间接依赖 esbuild-kit 有上游弃用提示（`docs/deployment.md`）。
- 本地 mock 认证只在 `env.local` 生效；生产缺配置 503（`docs/deployment.md`「本地」）。

## 4. 每次现场核验后才允许当作事实

- 仓库提交状态：2026-09-14 时 `git ls-files` 为 0（分支 `chore/project-bootstrap` 无任何提交），因此 `git diff --check` 覆盖有限。若已建立基线提交，本条失效。
- README 中的测试数量、bundle 体积等数字：必须用 `scripts/verify-baseline.sh` 重跑对拍后再引用。

## 5. 待复评台账（2026-09-14 全仓审查，修复由其他 agent 执行）

来源：2026-09-14 的对话式全仓审查（证据为当时的实测输出与临时复现测试）。复评时**不要重复上报**，直接进入工作流第 5 步逐条核对，并在报告里给"已修复 / 仍存在 / 已变化"。

| ID               | 严重度 | 位置                                                            | 一句话描述                                                                     | 状态   |
| ---------------- | ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| HW-2026-09-14-01 | P1     | `src/web/lib.ts:33`、`src/worker/index.ts:90-103`               | 无 body 的写请求不带 `Content-Type`，前端删除训练固定 400                      | 修复中 |
| HW-2026-09-14-02 | P2     | `migrations/meta/_journal.json`、手写 `0001_workout_guards.sql` | 手写迁移未进 journal/snapshot，`db:generate` 会产出重复 DDL                    | 修复中 |
| HW-2026-09-14-03 | P2     | `src/web/main.tsx:26`、`src/web/Settings.tsx:77`                | 服务端主题在启动时不应用，新设备仍为浅色                                       | 修复中 |
| HW-2026-09-14-04 | P2     | `src/web/Stats.tsx:137,146`                                     | 统计 `quality` 新增键缺中文标签，界面显示英文键名                              | 修复中 |
| HW-2026-09-14-05 | P3     | `src/worker/workouts.ts:145`                                    | 分块 `Math.floor(100/keys.length)` 在键数 >100 时为 0，存在死循环隐患          | 修复中 |
| HW-2026-09-14-06 | P3     | `src/worker/workouts.ts:429`                                    | `DELETE FROM workout_write_guards` 无 WHERE，依赖 D1 事务串行假设              | 修复中 |
| HW-2026-09-14-07 | P3     | `src/worker/workouts.ts:189-207`                                | 幂等重放的 `meta.requestId` 是首次创建请求的 ID                                | 修复中 |
| HW-2026-09-14-08 | P3     | `src/shared/contracts.ts` LIMITS 与 design §6.1                 | 备注长度 × 组数可超过 512 KiB 请求体上限                                       | 修复中 |
| HW-2026-09-14-09 | P3     | `src/web/Workouts.tsx:586`                                      | 死代码 `const ready = true`                                                    | 修复中 |
| HW-2026-09-14-10 | P3     | `src/web/Settings.tsx`、`src/web/styles.css:41-43`              | 手机端没有动作库入口（与 design §3.4 不一致）                                  | 修复中 |
| HW-2026-09-14-11 | P3     | `scripts/restore-local.py:182`                                  | 异常捕获面漏 `AttributeError`，损坏备份输出 traceback；`exportedAt` 未校验格式 | 修复中 |
| HW-2026-09-14-12 | P3     | `skills/healthworker/scripts/healthworker.py:133-141`           | 负数 `Retry-After` 走默认退避，与 `references/api.md` 措辞不一致               | 修复中 |
