# HealthWorker 循证训练知识接入说明

日期：2026-10-28

## 改动目的

在现有 HealthWorker Skill 内加入供外部 Agent 使用的科学训练知识与证据索引，使 Agent 结合用户实际记录提出条件性建议；**不添加固定课表生成器、训练计划表、自动康复评分或复杂决策状态机**。

## 改动文件

- skills/healthworker/SKILL.md：扩大知识场景触发并明确知识、安全及写入边界。
- skills/healthworker/references/scientific-training.md：训练编排、训练量、频率、RIR、渐进超负荷、恢复、现场指导及复盘的原则。
- skills/healthworker/references/scientific-evidence.md：研究文献和外推限制。
- tests/skill/scientific-coaching-cases.md：12项合成场景人工回归用例。

## 与原有设计兼容

docs/design.md仍明确不在后端或前端加入自动训练计划及AI诊疗；知识层仅由外部Agent按需引用。原有数据库、共享统计口径、Worker/API、MCP工具、授权边界、CLI和数据导入安全策略均保持不变。

## 审查与验证建议

1. 审查新增研究引用，检查是否把经验参数写成强制阈值。
2. 核对原有Skill关于数据查询、热身口径、预览与用户确认后create-only写入的条款仍完整。
3. 运行合成数据Agent评测，覆盖安全表述、跨器械比较、缺失RIR、保存边界和过量加组。
4. 目前属于文档与Skill指导改动；不能据此宣称已验证训练效果，也不应触发生产环境部署或数据写入。

参考来源：[Surge-Dan/healthy-fitness-coach-skill](https://github.com/Surge-Dan/healthy-fitness-coach-skill)，MIT许可；本改动为原则摘要而非复刻其执行代码。
