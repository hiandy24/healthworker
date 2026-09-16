# Agent 动作创建与迁移审查

日期：2026-09-15
范围：Agent create-only 权限、动作创建幂等/并发、append-only migration、Skill CLI 导入。

## 验证结果

- `npx pnpm@10.34.5 typecheck`：通过。
- `npx pnpm@10.34.5 test -- --run`：11 个测试文件、51 个测试通过。
- 迁移测试确认 `0000`、`0001`、`0002` 均登记于 journal，且 Drizzle 生成无 schema 漂移；未修改既有 SQL。

## 重点审查结论

1. Agent 路由仅允许已授权导入身份对 `/api/agent/v1/workouts` 使用 POST；动作 POST 不再被权限门放行，普通 Agent 写请求返回 405。
2. 动作创建实现严格共享 schema、Idempotency-Key、principal 隔离、请求体摘要和原子资源/幂等记录写入；同 principal 同 key 异 body 返回 409；并发同名由数据库唯一索引收敛为冲突。
3. CLI 导入的计划/确认/journal 流程保持只向固定白名单 workouts 端点 POST，并支持逐项停止与 resume；凭证不写入输出、计划或 journal。真实 Access、生产 API 和部署未执行。

## 未发现可实测确证的 P0/P1

本轮静态审查及现有本地测试未发现新的可复现 P0/P1。真实 Cloudflare Access 身份形状和线上 D1 仍需发布前单独验收，不以本地 mock 替代。

## 变更核对

`migrations/meta/_journal.json` 新增 `0002_exercise_name_unique` 登记；`migrations/0000*`、`0001*` 未改写。此前误将 Agent exercise POST 纳入权限放行条件已移除，符合设计中“Agent 不开放动作写入”。
