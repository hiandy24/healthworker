---
name: healthworker-review
description: 对 HealthWorker 仓库做深度代码审查（功能正确性、实现缺陷、健壮性、可维护性、架构与数据安全设计），产出可复评的审查报告；复评时逐条核对既有发现是否真的修好、有没有引入新问题。当用户说“review/审查/检查一下这个仓库的代码”“看看有没有 bug 或实现缺陷”“这块健壮吗、好维护吗”“架构/并发/一致性/数据安全设计合不合理”“复评上一次的发现”“按设计文档核对实现”，或在合并、交付、部署前要求把关时使用。只适用于本仓库：源码在 src/，产品与验收基线是 docs/design.md，历史轮次在 docs/reviews/。
---

# HealthWorker 深度代码审查

目标是找出**测试跑绿也照样存在**的缺陷，并把每一条都变成可复现、可复评的证据。本文档是流程骨架；每层的详细检查项在 `references/`，按需读取。

## 三条铁律

1. **只信实测数字。** README、设计文档、上一轮 review 的结论都只是待验证声明，必须重跑并给出真实输出才能引用。
2. **先证伪再上报。** 每条候选发现都要先尝试否定它；做不到就标为"疑似未复现"，不计入必修项。范例：曾怀疑"空草稿条目"会让 `json_group_array` 返回 NULL 导致列表 500，实测返回 `[]`，于是**不报**——错误的发现比漏报更消耗修复方，也会毁掉整份报告的可信度。
3. **区分新缺陷与已知空白。** 已被 `docs/reviews/*`、`README`、`docs/design.md` 承认的缺口（M5 未部署、真实 Access 未验收、无 E2E 等）只能在报告里标"仍存在"，不得当作新发现重复上报。清单见 `references/known-gaps.md`，动手前先读。

## 工作流（5 步）

### 1. 定范围与基线

读 `AGENTS.md`、`docs/design.md`（重点 §3–§12 与 §12.2 的 A01–A21）、`README.md`、`docs/reviews/*.md`、`docs/api.md`、`references/known-gaps.md`。

记录工作区基线，收尾必须回到同一数值：

```sh
git status --porcelain | wc -l
git ls-files | wc -l
```

确定模式：全仓分层（默认）/ 指定模块 / 指定 diff / 复评上一份报告。

产出：审查坐标系——本次涉及的 design 章节、对应验收项、以及"已知不得重复上报"的条目。

### 2. 核验事实 + 分层审查

先跑 `scripts/verify-baseline.sh`（typecheck、lint、format:check、单元、集成、Python、build），把**真实数字**与文档声明对拍；不一致本身就是一条"文档漂移"发现项。跑不了的项目按"未运行"记录，不得默认为通过。

再按层过检查清单：

- 契约、数据模型、迁移、统计口径 → `references/playbook-contracts.md`
- 架构边界、一致性、写路径并发原语、约束分层、架构漂移 → `references/playbook-architecture.md`
- 前端、状态、草稿、可访问性、响应式 → `references/playbook-web.md`
- 健壮性、可维护性、测试覆盖空洞 → `references/playbook-robustness.md`

产出：候选发现（含位置与初步证据）+ 已排除项（写进报告，避免修复方重复排查）。

### 3. 对拍与复现（核心步骤）

**契约对拍**：把每个客户端调用点与服务端前置条件做成矩阵（方法、路径、`Origin`、`Content-Type`、`If-Match`、`Idempotency-Key`、body/响应 schema、错误码语义）。关键规则：**按真实客户端语义取证，不按测试辅助函数的语义**——测试里的 `request()` 常常无条件补齐 Content-Type/Origin，正好掩盖协议差异。矩阵中的空档就是候选发现。

**动态复现**：API 层缺陷用 `cloudflare:test` + 真实 workerd/D1 路由复现（模板 `assets/repro.integration.test.ts`，复制到 `tests/integration/zz-*.test.ts`）；非 API 缺陷（迁移应用顺序、`db:generate` 漂移、脚本异常路径）用 `/tmp` 下的独立脚本，以命令与输出为证。

门槛：**P0/P1 必须在这一步复现成功才允许上报**；禁止远端资源、生产库、`--remote`、`deploy`、破坏性迁移。

### 4. 判定与产出

对每条候选先证伪，标注信任级别与严重度，与 `known-gaps.md` 去重，然后写报告。

- 信任级别：`L1` 实测复现 / `L2` 静态确证（给出唯一调用链）/ `L3` 疑似未复现。
- 严重度：`P0` 安全边界被绕过、数据损坏或不可恢复 / `P1` 用户可见功能失败或数据不一致 / `P2` 工作流缺陷或用户可见瑕疵 / `P3` 健壮性与可维护性隐患。
- 门槛：P0/P1 必须 `L1`；P2 允许 `L2` 但须显式写"未运行"；`L3` 只进"待验证假设"，不计入必修项。

报告写到 `docs/reviews/YYYY-MM-DD-<scope>.md`，结构见 `references/report-template.md`。每条发现给稳定 ID（`HW-<date>-NN`），供复评引用。

### 5. 清理与复评

删除本次新增的全部临时文件（`tests/integration/zz-*.test.ts`、`/tmp` 脚本），再跑一次第 1 步的基线命令，确认工作区回到原值。报告里要写明临时复现已删除、以及如何重建。

复评模式：读入上一份报告的 Finding ID 列表，逐条给"已修复 / 仍存在 / 已变化 / 引入新问题"，并做一次修复面扩散检查——改动点相邻的调用点、错误路径、测试断言有没有被顺带削弱。允许把复现文件留在被忽略的 `.local/reviews/<date>/` 以便重跑，默认仍删除。

## 测试策略

审查的职责是证明缺陷可复现，不是替修复方写测试（`AGENTS.md §5` 规定回归测试由改动方补）。

| 级别             | 形态                                                              | 生命周期                      |
| ---------------- | ----------------------------------------------------------------- | ----------------------------- |
| 临时复现（默认） | `tests/integration/zz-*.test.ts` 或 `/tmp` 脚本                   | 用完删除，收尾校验基线        |
| 永久测试建议     | 只写进报告：测试名、位置、断言、为什么现有测试抓不到              | 由修复方决定是否落进 `tests/` |
| 验收真空         | 只在报告章节列明（A12 真实 Access、A16 视口、A17 主题、A20 部署） | 不代做                        |

硬规则：

1. **不修改任何既有测试文件。** 审查期间只新增 `zz-*`；若必须改既有测试才能证明某事，那本身就是发现项（断言被削弱或掩盖了协议差异），要上报而不是动手。
2. **临时测试必须可重建。** 报告里给文件名、关键断言、运行命令、观察到的输出，而不是只写"我跑过"。
3. **复现走真实测试栈。** API 层用 workerd/D1 路由，不用 JSDOM、不 stub fetch；后者正是掩盖本次 DELETE 缺陷的手法。
4. **不把 mock 当验收。** 本地 mock 认证、JSDOM 渲染、静态 CSS 断言都不等于真实 Access、真机与 GUI 验收，报告里必须写明边界。

## 发现项必备字段

```text
ID: HW-2026-09-14-01
严重度: P1          信任级别: L1 实测复现
位置: src/web/lib.ts:33；src/worker/index.ts:90-103
现象: 详情页“删除训练”固定返回 400 INVALID_CONTENT_TYPE
复现: 临时集成测试 zz-contract-probe（浏览器同款请求头）→ bodyless DELETE 400、带 Content-Type 200
影响: 用户无法删除训练；与 design §7.4 的删除流程不符
根因: api() 仅在存在 body 时设置 Content-Type；中间件对所有非 GET 人类写请求强制 application/json
最小修复: lib.ts 非 GET 一律带 JSON Content-Type
结构性建议: 增加按真实客户端请求头构造的契约测试，避免测试辅助函数掩盖协议差异
回归测试建议: 集成测试断言 bodyless DELETE 返回 200
与既有文档关系: 新缺陷（README/reviews 未承认）
修复验证方法: 重跑该集成测试 + 手动删除一次
```

只有"现象 + 复现 + 影响 + 根因"齐全的条目才算完成；缺任何一项就降级为 `L3` 待验证假设。

## 安全与边界

- 默认**只读**：不改产品代码、不提交/推送、不碰远端资源与生产库、不改用户全局配置。
- 临时产物只允许出现在 `tests/integration/zz-*.test.ts` 与 `/tmp`，收尾必须删除并校验基线。
- 报告与示例中不得出现真实凭证、audience、邮箱、域名或训练数据；需要引用时只写出处（如 `.local/deployment-notes.md`）。
- 不代写验收（真实 Access、真机、E2E、性能测量）；结论只覆盖本次真正运行过的范围。
- 与 `skills/healthworker/`（产品交付的只读 Agent Skill）严格区分：不得修改它，也不得混用其命名与契约。

## 参考文件

| 文件                                  | 何时读                                            |
| ------------------------------------- | ------------------------------------------------- |
| `references/playbook-contracts.md`    | 第 2 步：契约、数据模型、迁移、统计口径           |
| `references/playbook-architecture.md` | 第 2 步：架构边界、一致性、并发控制、数据安全设计 |
| `references/playbook-web.md`          | 第 2 步：前端、草稿、可访问性、响应式、图表       |
| `references/playbook-robustness.md`   | 第 2 步：健壮性、可维护性、测试覆盖空洞           |
| `references/known-gaps.md`            | 第 1 步先读：不得重复上报的清单与历史台账         |
| `references/report-template.md`       | 第 4 步：报告结构                                 |
| `scripts/verify-baseline.sh`          | 第 2、5 步：验证记录                              |
| `assets/repro.integration.test.ts`    | 第 3 步：临时复现模板                             |
