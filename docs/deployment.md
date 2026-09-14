# 本地环境、恢复与生产部署

## 首次生产部署实测（2026-09-14 UTC）

用户明确授权后，已发布 <https://health.tokenflare.top>，创建独立生产 D1 并应用既有 `0000_silent_liz_osborn.sql`、`0001_workout_guards.sql`。核验 `seeds/local.sql` 仅三条合成内置动作后用于初始化；没有导入本地数据库或测试训练。动作/内置动作均为 3，workouts、workout_entries、strength_sets、cardio_records、settings、idempotency_keys、workout_write_guards 均为 0。迁移列表无待应用项。

- 公共 DNS A/AAAA 有效，HTTPS 证书校验通过（SAN 覆盖域名，TLS 1.3）。本机 DNS 被代理映射到 198.18 网段，因此另用 Cloudflare DNS-over-HTTPS 验证真实公共记录。
- 无凭证 GET `/`、`/api`、`/api/v1/workouts`、`/api/agent/v1/workouts`、`/api/unknown`、`/unknown`、Agent metadata 尾斜杠均返回真实 Access HTTP 302，不跟随登录跳转。公共 JWKS 可读取两把公钥。
- 远端读取核验 production vars / D1 绑定与私有配置一致；workers.dev 和 preview 均关闭，Custom Domain 记录属于本 Worker。没有修改 Access 策略或覆盖已有 DNS。
- typecheck、lint、50 项 TS 单元/组件、55 项 workerd/D1 集成、生产 build 和 deploy dry-run 通过；前端产物未含私有邮箱、AUD、issuer、账户/数据库 ID。既有主块体积和 Zod 注释警告仍在。
- **不等于完整 M5 验收**：OTP 必须由用户登录；Agent Secret 未持有，真实 Service Token GET/越权/撤销验收未执行。秘密仅在本地受保护环境变量或密钥管理中提供，不发聊天。没有浏览器/真机验证，也未向生产写测试训练。

资源 ID、部署/version ID、精确 UTC 时间和日志保存在被忽略、权限受限的 `.local/deployment-notes.md`，公共文档不列私有值。

### 生产构建与重部署（示例路径，不含私值）

生产源配置为 `.local/wrangler.production.json`（0600），其中 `main=../src/worker/index.ts`、`assets.directory=../dist/client`、`migrations_dir=../migrations` 均相对于该配置文件。不覆盖根 `wrangler.jsonc`，不设置 `CLOUDFLARE_ENV=local`。

```sh
# 在仓库根目录，使用已安装的 Node 24 / Corepack pnpm 10.34.5。
env -u CLOUDFLARE_ENV CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$PWD/.local/wrangler.production.json" corepack pnpm run build
chmod 600 dist/healthworker/wrangler.json
corepack pnpm exec wrangler deploy --config "$PWD/dist/healthworker/wrangler.json" --dry-run --no-autoconfig
# 检查生成配置、前端无私值、远端资源及迁移兼容性后，在交互终端执行。
corepack pnpm exec wrangler deploy --config "$PWD/dist/healthworker/wrangler.json" --no-autoconfig --strict
```

构建会生成含私有 Worker vars 的被忽略配置，不能分享整个 dist。每次 build 之后都重新检查生成配置；普通本地 build 可能替换同名产物。生产迁移使用**源私有配置**而非 dist 配置，先只读 list，新增迁移审阅/授权后再 remote apply；重部署不重复创建数据库，不上传本地数据。

**Wrangler 4.131.1 安全注意**：源码核验发现非 TTY Custom Domain 部署会自动允许覆盖冲突 origin/DNS。必须用交互终端，任何意外覆盖提示回答 No 并停下；不能用 CI/自动 Yes 绕过。首次发布已使用 PTY 且无冲突提示。官方 [Vite API](https://developers.cloudflare.com/workers/vite-plugin/reference/api/) 支持上述配置选择变量，[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) 说明自动 DNS/证书配置。

回滚只回滚 Worker，不回滚 D1。首次上线没有更早的生产版本可退；后续使用已验证且兼容当前数据库的 version ID，经授权运行 `corepack pnpm exec wrangler rollback <known-good-version-id> --config "$PWD/.local/wrangler.production.json"`。不删库、不反向修改已执行迁移、不覆盖恢复，生产恢复需另行授权。

以下历史准备清单中“未部署/未执行”描述首次发布前状态；当前事实以上述实测为准。

## 环境与依赖核验

Node 24.15.0、pnpm 10.34.5；`compatibility_date=2026-09-13`。React 19.2.4 / Mantine 8.3.18、Vite 7.3.6 / React plugin 5.2.0 / Cloudflare Vite plugin 1.54.8 / Wrangler 4.131.1、Vitest 4.1.11 / Cloudflare vitest-plugin 1.1.8 使用 npm 官方元数据核查 peerDependencies 后锁定。最新 Vitest 5 不符合 Cloudflare 插件 `^4.1.0` peer，故使用稳定 4.1.11；TypeScript 5.9.3 在 typescript-eslint 支持范围内。ESLint 使用受维护 10.10.0，不采用已经弃用的 9.x。

Context7 工具本轮不可用，改查 [Cloudflare Vite](https://developers.cloudflare.com/workers/vite-plugin/get-started/) 与 [Workers Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) 官方页面及 npm 官方包元数据。使用新的 `cloudflareTest` API，不混用旧 pool 配置。直接依赖使用 MIT / Apache-2.0 / BSD 类许可（实际安装包信息为准）；M2–M4 已增加 Mantine form/dates/modals、Recharts 3.10.1、csv-stringify 6.8.3、jsdom 30.0.1 等，固定版本见 package.json；浏览器 E2E 脚本尚未提供。Drizzle Kit 的间接 esbuild-kit 依赖存在上游弃用提示，不影响本轮测试，后续升级需复核。pnpm 仅允许 esbuild/workerd 必需安装脚本，无全局配置修改。

当前构建测量统一见 [README 验证结果](../README.md#验证命令与真实结果)，不在部署说明重复维护数值。历史 review 的数值仅表示当时测量；未做 p95 参考规模实测。

## 本地

遵循 README 命令。`wrangler.jsonc` 的 `env.local` 仅绑定全零前缀的合成本地数据库 ID；不存在真实生产 ID。Wrangler migration / seed 必须带 `--local --env local`，与 Vite 本地环境共享默认 `.wrangler/state`。集成测试使用独立 Miniflare D1，不读开发数据。

`APP_ENV=local` 且 `LOCAL_AUTH_MOCK=true` 才启用 mock；生产不能仅凭 mock flag 启用。mock 允许两个 API 读取以便本地测试，不能证明身份隔离；合成签名 JWT 测试另外验证单 audience 与已验 JWT 身份互斥分类、issuer、有效期、签名和 allowlist。远程 JWKS / Service Auth 必须在真实 Access 验收。

## 生产配置清单（仅私有部分配置已保存，未验收/部署）

1. 授权后创建独立 D1，增加正式绑定和正式域名 route；不要把生产 ID 放入 local / 测试环境。
2. 唯一 self-hosted Access 应用保护整个 hostname：个人 Allow 仅 OWNER_EMAILS 对应本人邮箱（OTP）；同应用 Service Auth 只指定 Agent Token。无需另建 `/api/agent` 应用。Allow 不使用 Everyone、整个邮箱域或仅 Login Methods=OTP 的宽泛 Include；Service Auth 不使用 Any Access Service Token、mTLS 或 Bypass。官方执行顺序为 Service Auth/Bypass 先于 Allow/Block，须核对实际规则而非仅 UI 排列。若旧重叠应用存在，用户先查看控制台应用/路径优先级，解除旧匹配后核验整个 hostname、尾斜杠、未知路径都落到唯一应用；不得未经查看删除旧应用。
3. 配置 `APP_ENV=production`、`APP_ORIGIN=https://正式域名`、`ACCESS_ISSUER=https://团队.cloudflareaccess.com`、单一 `ACCESS_AUD`、逗号分隔 `OWNER_EMAILS`；可选 `ACCESS_SERVICE_TOKEN_IDS` 为 Client ID 精确 allowlist（未设置依赖指定 Token 的边缘策略，空值非法）。旧双 AUD 不再读取，无兼容回退。不配置 `LOCAL_AUTH_MOCK`，不将 JWT / Service Token 放入源码或前端。
4. 正式配置保持 `workers_dev=false`、`preview_urls=false`；静态资源由 Access 边缘保护，`/api` 与 `/api/*` Worker 优先、未知路径 JSON 404。静态资源不经过 Worker API 中间件，因此根域名 Access 不能省略。
5. 生产构建使用普通 `build`，不设置 `CLOUDFLARE_ENV=local`。检查生成的 `dist/healthworker/wrangler.json` 中没有本地 mock / 数据库 ID。
6. 评估备份、追加迁移和回滚兼容性，获得对应授权后才执行远端迁移/发布。当前未执行任何远端操作。

## 单 AUD 身份与真实 Access 验收

规则见设计 §8.1：[官方 Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) 明确两种 type 均为 app，service common_name=Client ID/sub 为空，人类 email 为 IdP 验证邮箱/sub 为用户 ID；[验证文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) 要求验签及 issuer/audience。管理 human-only，Agent service-only；混合或未知 claims 拒绝。只 mock JWKS 公钥传输的合成签名 workerd 测试不是真实 Access。

配置修改后先结束旧人类 Access 会话并重新 OTP 登录，刷新 JWT；不得沿用旧应用 cookie 推断新配置。部署前仍须补正式 D1/route/认证配置（当前 Wrangler 故意缺少生产绑定，不能直接发布）。获授权后执行真实边缘验收：owner 管理读写、非 owner 拒绝、指定 Service Token Agent GET 成功、该 Token 对管理 GET/POST/PATCH/PUT/DELETE 全拒绝、human 对 Agent 拒绝、Token 轮换/撤销及过期、错误 AUD/未知身份拒绝。安全检查已验 claims 形状但不记录 JWT/Client Secret/邮箱真值。混合 Allow/Service Auth 策略签发不符合文档形状时停止上线，不添加邮件单条件回退。[策略官方说明](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) 与 [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) 应与控制台实际配置共同核对。当前未修改远端 Access、DNS、D1 或发布。

## 安全头与边界

`public/_headers` 设置静态资源 CSP、nosniff、frame 限制和 Referrer Policy。Mantine 动态 style / CSS variables 需要 `style-src 'unsafe-inline'`，仅放宽样式；script 限于 self，无 unsafe-eval、外部字体或追踪。开发 HMR 不代表生产 CSP 验收，必须对正式构建再验收。API 无公共缓存、无通配 CORS，写操作要求配置的精确 Origin。错误仅提供安全 JSON 与随机请求编号，不输出堆栈、身份头、数据库错误或健康数据。当前不主动记录请求，部署后如添加结构化日志只能记录路由模板、状态码、耗时和 request ID。

## 阻塞与 M5 验收

- 私有配置已保存到被忽略文件，公共文档不披露真值；不能据此推断真实 Access/Service Token 已验收。原私有 human AUD 可作为唯一应用 ACCESS_AUD 来源，保留私有并核验复制准确；无需等待第二个 AUD。生产绑定/策略/授权仍需 M5 核验，尚未上线。
- 必须实测 Access 路径优先级、尾斜杠、未知/标准化路径、过期凭证、错误 audience、人类 allowlist、Agent 写入拒绝以及 workers.dev / preview 关闭。
- 无真实设备验收；桌面/手机不同宽度、键盘、200% 缩放、明暗主题、加载/失败状态由主代理浏览器回归，真实 iOS Safari 等仍需真机。
- 限流按实际 Cloudflare 套餐配置，目前未伪造 isolate 内全局计数器。
- M2–M4 已本地实现并自动测试，见 reviews；M5 未做。主 agent IAB 已确认 768px 总览布局、空统计与部分导航/设置表单加载，但 click 持续 timeout、snapshot 间歇空及 screenshot activity capture failed 阻塞完整 GUI。需用户协助恢复浏览器或人工验收；未验证新版全视口、保存、下载、主题、键盘/200% 与真机。

## 受控本地恢复

设置页导出 JSON 保存到 backups/ 等被忽略目录。执行 `python3 scripts/restore-local.py backups/backup.json --new-local-db .local/restored.sqlite`，目标文件必须不存在；脚本使用当前追加迁移、参数化写入，校验版本、引用、历史计量语义、完成父子、外键与数量。拒绝覆盖和 --remote；仅生成新本地 SQLite，不写远端 D1，也不自动替换 Wrangler 开发库。TS 单测的合成演练验证 ID/备注/引用与 1500 kg·次容量；这不是全量生产恢复认证。

导出上限为 150000 行/20 MiB 保守预算，超限 413 不截断。更大备份及任何生产恢复须另行授权、备份、演练与平台方案核验；本轮没有远端操作。

## 1.8 导入配置（此次仅本地，不发布）

新增可选 ACCESS_IMPORT_TOKEN_IDS，逗号分隔精确已验 service common_name Client ID，大小写敏感；省略全部只读，空值/空项/内嵌空白/通配星号非法并 503。总体 ACCESS_SERVICE_TOKEN_IDS 拒绝的身份不能靠导入列表绕过。单 ACCESS_AUD 不变；不更改边缘策略、DB、DNS。未来获发布授权后另验只读 Token 拒 POST、导入 Token 仅 POST workouts、human/service 互斥、所有历史修改/动作写入/管理拒绝及撤销。Client Secret 仅 Agent 密钥环境。不要将整批健康数据、计划或 journal 放进公开仓库；用 .local 私有目录并保留恢复 journal。
