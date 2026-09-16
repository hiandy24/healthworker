# 保存成功后多余离开确认弹窗修复记录（2026-09-16）

## 问题

手机视口（390×844，桌面浏览器模拟）端到端验收发现：新建训练页点击“完成并保存训练”后，云端保存已成功（出现“已保存到云端”提示），自动跳转训练详情页时仍触发应用自身的离开确认弹窗（“当前存在未保障本地恢复的输入……确认离开？”），需要额外点击一次“确认继续”。每次成功保存都会多一次点击。

## 根因

`src/web/NavigationGuard.tsx` 与 `src/web/Workouts.tsx` 的交互存在两个叠加缺陷：

1. **router 注册滞后（竞态）**：react-router 7.18.3 的 `useBlocker(enabled)`（布尔参数）只在 React 提交后的 effect 中调用 `router.getBlocker(key, fn)` 更新注册的拦截函数。`Workouts.tsx` 的保存成功回调在**同一任务**里 `setCloudSaved(true)` 后同步调用 `navigate()`，此时新状态尚未提交，router 手上仍是旧的 `() => true`，导航被旧注册拦截。
2. **blocked 状态不复核 enabled**：Guard 的 effect 收到 `blocker.state === 'blocked'` 后无条件调用 `confirmAction` 弹窗。而路由状态经 `startTransition` 投递，到达渲染时先前的 `setCloudSaved(true)`（默认优先级，先调度）必然已生效——守卫此时实际已禁用，弹窗却仍然出现。

## 修复

`src/web/NavigationGuard.tsx`：effect 中检测到 blocked 且 `enabled` 已为 false 时，直接 `blocker.proceed()` 恢复导航，不再弹窗。守卫对真实脏表单（enabled 保持 true）的行为不变。

## 测试

- 新增回归测试 `tests/unit/web-review.test.ts`（“P1 successful save disabling the guard resumes its own navigation without a prompt”）：模拟保存成功回调——同一任务内先禁用守卫再 `navigate()`。修复前该测试失败（`expected '/' to be '/other'`，与浏览器实测一致）；修复后通过。既有守卫弹窗测试（取消/确认继续）不回归。
- 全量验证：typecheck、lint、format:check、`test`（11 文件 / **52 passed**）、`test:integration`（6 文件 / **55 passed**）全部通过。
- 浏览器复验（本地 dev，手机视口 390×844）：实际录入杠铃深蹲 10 次 × 120 kg 并保存，页面直接跳转 `/workouts/{id}`，无确认弹窗。本地 dev 数据为合成数据，未触碰生产。

## 边界

- 修复已于 2026-09-16 UTC 经用户授权发布生产（版本 641031e1-3734-4d7b-9464-362a0afa03c3，100% 流量；线上 Access 拦截与 Service Token metadata 验证正常）。修复后的真实页面保存流程未在生产页面以人类身份操作验证（需 OTP 登录，未执行）。
- 真机（iOS Safari）验收仍未完成，本修复不代表真机验收通过。
