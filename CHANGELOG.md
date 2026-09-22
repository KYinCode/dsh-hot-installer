# 更新日志

dsh-hot-installer 的所有已发布版本。版本号遵循 SemVer；0.x 期间次版本号承担不兼容变更，补丁号用于修复与文档。

日期为发布者本地日期（UTC+8），与 npm 页面显示的日期一致。

## [0.5.4] — 2026-09-22

### 修复
- **看不见「随 dsh 安装自带」的 bundle，误报 `cannot index <pkg>`**。实测触发：在 Web UI 里启用 `@deepseek-ai/dsh-experimental-agent-team-profile` 后，每次启动都有一条
  `cannot index … for hot removal (cannot resolve …)`，可是该 bundle 已被平台正常挂载（`dsh --profile web --dump-config` 里能看到它贡献的 7 行）。
  根因是**解析顺序**：平台 `resolveBundleDir`（dsh-app-boot `:702-708`）**先试 `installAnchor`（dsh 安装树）**、失败才回落 profile，契约是"in-box bundle 永远来自与当前 dsh 同一个安装，而不是 profile 本地副本"；本插件此前只按 profile 解析，而这类包（`dsh-base`、`dsh-web-app`、`voice-input`、`agent-team-profile` 等）**既不在 profile 的 `node_modules` 里、也不在 `dependencies` 里**，于是被判成"未安装"。
  现在 `resolveBundleDir(profileDir, packageName, installAnchor)` 复刻平台的锚点顺序，`installAnchor` 取自 `ctx.get('profileContext').installAnchor`（`profile-context.d.ts:16` 暴露的就是启动器实际使用的那个），并透传给 `readBundlePatch` 与 `hotInstall`。取不到该服务时保持原行为（仅 profile），所以非 dsh 启动的宿主不受影响。

### 影响
- 误报消失，且 in-box bundle 现在能被本插件索引（可参与热卸载/热更新的行记录）。
- 顺带修正**来源与路径形态**：in-box bundle 与平台读的是同一份、同一个路径字符串 —— 0.5.3 记录的那条残留（"安装树里的 bundle 若用相对 name，锚定 URL 会与平台不一致"）随之关闭。
- profile 本地包（`dsh-hot-installer`、`@local/*` 等）行为不变：安装锚点里找不到它们，自然回落到 profile。

### 新增
- 单测 17 → 18：`resolveBundleDir` 的安装锚点优先 / profile 回落 / 两处都有时安装锚点胜出 / 空锚点被忽略。

### 验证
- **与平台逐条对照**（一次运行里同时比较"解析到的目录"和"解析出的补丁条目"）：web profile 全部 6 个 bundle **dir mismatches 0 / parse mismatches 0**；其中 `agent-team-profile` 两侧都落到安装树、都得到 5 个条目（旧代码这一项是 `ours=undefined`）。
- **scratch 活测**（profile `inbox-live`：web 模板 + `link:` 本地构建 + 只把它加进 `bundles`、故意不给 dependency 条目，正是 in-box 形态）：启动日志**只有一行** `active … v0.5.4`、**无任何 warn**；`dump-config` 确认平台确实挂了它贡献的 7 行。对照：0.5.2/0.5.3 在同一形态下共留下 4 条 `cannot index @deepseek-ai/dsh-experimental-agent-team-profile`。

## [0.5.3] — 2026-09-22

### 修复
- **补丁里用相对/绝对路径声明插件名时，热装 / 热更新 / 热卸会静默失效**。平台的解析器（`dsh-app-boot` 的 `parsePatchList`——bundle 补丁、`--patch` overlay、profile 补丁层都走它）在收尾时会把 insert 行里**绝对路径或 `./` / `../` 开头的 `name`** 改写成"紧邻该补丁文件"的 `file://` URL；本插件此前不做这个改写，于是**记录的行与活配置里的行深度相等匹配不上**：热卸摘不掉（日志退化成 `rows already gone … nothing to unload`），重挂又被去重成空（`all rows already present`），既不打印 `hot-reloaded`、行也继续跑旧模块——正是 0.4.6 揭穿过的那类"假成功"。现在 `parsePatchList` 收尾调用与平台逐字一致的 `anchorInsertedPluginNames`（含 `group.config` 递归；裸包名如 `@deepseek-ai/dsh-persona`、断言式名字与 `some.pkg` 这类非路径值保持字面量）。
- 该改写对**目前所有已发布 bundle 都是 no-op**：实测本 profile 的 9 个 bundle 补丁文件（含 `dsh-web-app` 的 5 个）里 anchor-relevant 的 `name` = 0 个。它只影响未来这么写的 bundle，因此本次改动对现有行为零影响。

### 新增
- 单测 16 → 17：`parsePatchList` 的 name 锚定（相对、`../`、绝对、裸包名、带点非路径、`group` 递归），以及 `readBundlePatch` 数组声明下**每个文件各自目录**的锚定（`presets/x.patch.yml` 里的 `../lib/y.mjs` 落在包根，不是 `presets/` 下）。

### 验证
- 用平台自己导出的 `bundlePatchPaths` + `loadOverlayPatches` 做逐条对照：本 profile 全部可解析 bundle（含 `dsh-base`、`dsh-web-app` 33 条）在两种安装锚点下均**深度相等**；另造一个含相对/绝对 name 的合成 bundle，对照结果 **0 处不一致**。
- scratch 活测 A/B：同一个含相对 name 的 bundle，同一份 profile，只切换本插件是否为锚定版本——有锚定 → `evicted 1 cached module` + `hot-reloaded anchor-live-bundle (1.0.0 -> ^1.0.0, 1 patch entry)`，行真的摘掉又重挂（激活日志 1 → 2）；无锚定（对照）→ `rows already gone … nothing to unload` + `all rows already present`，行**从未重载**（激活日志停在 1）。

## [0.5.2] — 2026-09-22

### 修复
- **兼容 dsh 0.1.7-alpha.1 的「有序补丁文件数组」**：`dsh.bundle.patch` 从单个文件路径扩展为**有序文件数组**（`@deepseek-ai/dsh-web-app` 已改成 5 个文件：主补丁 + 4 个 agent preset）。此前 `readBundlePatch` 把声明直接当字符串交给 `path.join`，凡是数组声明的 bundle，每次启动都抛 `TypeError [ERR_INVALID_ARG_TYPE]`，只在日志里留一条 `cannot index <pkg> for hot removal`。现在按**声明顺序**逐个解析并拼接（与平台 `bundlePatchPaths()` → `flatMap` 的顺序一致；顺序错了，`removePatches` 的深度相等匹配就摘不掉行）；单文件声明行为完全不变；空数组返回 `[]`；既非字符串也非字符串数组时抛出与平台同义的清晰错误（`dsh.bundle.patch must be a file path or a list of file paths`），不再漏出 `path.join` 的内部错误。
- **不再把「没有 dependency 条目」的 bundle 纳入版本热更新**：`dsh-base` / `dsh-web-app` 这类由 profile 模板贡献的 bundle 在 `dependencies` 里没有条目，插件记录到的 spec 是空串。此前它们的 spec 一旦变化就会走升级路径，而升级失败后的「回滚到空 spec」执行的是 `pnpm add <pkg>@` —— 实测这**不是**一条失败命令：它退出 0 并安装该包的 `latest`（`@deepseek-ai/dsh-web-app@` 解析到 **0.0.1-rc.1**），而 0.0.1-rc.1 仍声明可解析的补丁，于是回滚后的校验**通过**、profile 被**静默降级**——比 `emergencyUnmount` 更隐蔽。现在这类 bundle 只做索引与记账，spec 变化只记一条日志，交给平台或重启处理。新增纯函数 `classifySpecUpdates`。

### 新增
- `scripts.test`：`npm test` 即 `node --test`；中英 README 的开发命令同步改为 `npm test`。
- 单测 14 → 16：`readBundlePatch` 的单文件声明 / 数组声明（含顺序）/ 空数组 / 非法声明，以及 `classifySpecUpdates` 对平台自有 bundle 的分流。

### 说明
- 本次修复对 dsh 稳定线（npm `latest` = 0.1.5-rc.2、`next` = 0.1.5-rc.3）**没有行为变化**：那条线上所有已发布的 bundle 都声明单个文件路径，而且平台自己的 `dsh-app-boot` 也只接受字符串（`join(packageDir, declared)`），数组声明在 boot 阶段就会 fail-loud，轮不到插件。上面两条加固同样只在失败路径上生效——把「静默改坏 profile」换成「不动作 + 一条日志」。

## [0.5.1] — 2026-09-20

### 文档
- 中英 README 各加「我需要装吗（按 dsh 版本看）」矩阵：npm `latest`（0.1.5-rc.2）没有任何平台原生能力，装/卸/升级全靠本插件；`alpha`（0.1.6-alpha.2）装/卸已原生，本插件补版本升级与容错链。仅文档变化，代码与 0.5.0 相同。

## [0.5.0] — 2026-09-20

### 修复
- **兼容 dsh 0.1.6-alpha.2**：HMR 实现包由 `cordis-plugin-hmr` 换成 `dsh-hmr`，服务方法 `registerConfig` 改名为 `watchConfig`，旧调用抛 `TypeError` 导致热装静默失效。改为特性探测（`watchConfig ?? registerConfig`），两代 dsh 用同一份代码。
- **loader settle**：新版 loader 下 `entry.update()` 会在树真正摘掉行之前 resolve（实测配置 4→3 时行仍挂载），使去重逻辑误判"行还在"而跳过重挂，只打印 `all rows already present`——**模块永不重载**。改为删除后有界等待行真正离开树，并按权威的 `config.patches` 而非滞后的树去重。

### 新增
- **模式自适应**：平台（`dsh-hmr`）已自行监听 profile 清单并原生重组装/卸，路径注册会撞车。撞车时进入 specOnly 模式——不抢路径，改为每秒轮询清单，只处理平台跳过的依赖版本变化，保留缓存驱逐、预检、回滚、紧急卸载整条链。启动日志写明当前模式。
- `patchRowIds` 纯函数（+单测，共 14 个）。

## [0.4.8] — 2026-08-18

### 修复
- 缓存驱逐同时匹配包目录与它的 realpath：Windows 上 pnpm 装的包缓存键保留 node_modules 软链路径，而 `link:` junction 到外部目录的包缓存键是 junction 目标的真实路径，只匹配一种会漏掉另一种。

## [0.4.7] — 2026-08-18

### 修复
- 重放日志按**实际补回**的条目计数并列出包名。此前按"判定缺失"计数，导致真实补回 1 条也打印 `replayed 3`（含 `!!js` 行被加载器求值后与原记录不再 deep-equal 的误判）。

## [0.4.6] — 2026-08-18

### 修复
- **升级真的会换代码了**：重挂前驱逐 `loader.internal.loadCache` 与 CJS `require.cache` 中该包的模块。此前 loader 按 URL 缓存，摘行重挂拿到的仍是旧模块——0.3.0 以来所有 `hot-reloaded` 日志都是假象（行重挂了，代码没换）。新增 `evicted N cached modules` 日志。

## [0.4.5] — 2026-08-18

### 新增
- 启动日志带上自身版本号（从本包 `package.json` 读取）。磁盘与运行进程的版本可能漂移，日志必须说明实际加载的是哪个版本。

## [0.4.4] — 2026-08-18

### 修复
- **自更新死锁**：HMR 的 refresh 任务会一直等到回调完成，而注册返回的 disposer 又要等这个任务；自更新（升级热安装器自己）时形成循环等待，watcher 永久失聪且行半卸载。回调改为立即返回 void，处理链在插件内部自行串行。

## [0.4.3] — 2026-08-18

### 修复
- 卸载竞态误报：5 秒重放对账与补丁层重组撞车时，`dsh plugin remove` 会因"记录的行已不在活配置里"而误报 `restart required`。现在视为**已卸载成功**。

## [0.4.1 / 0.4.2] — 2026-08-17

### 修复
- 0.4.1 引入**紧急卸载**：升级失败且回滚也失败时，把该包从 profile 的 bundles 列表摘掉，保证 dsh 仍可启动，并在日志给出精确的重新安装命令。
- 0.4.2 修掉由此引入的死循环：pnpm 对悬空 `link:` 也可能退出 0，于是"回滚成功"与"spec 变化"互相触发。现在回滚后必须验证包确实可用，不可用即走紧急卸载。

## [0.4.0] — 2026-08-17

### 新增
- **升级失败自动回滚**：新版本 import/apply 失败时，用 pnpm 把依赖装回旧版本并重新挂载，插件无感地继续用旧代码工作（日志 `update failed ... rolling back` / `rolled back`）。

## [0.3.2] — 2026-08-17

### 新增
- 更新前**预检**新版本的补丁声明；解析失败时旧行保持不动，只记录 `restart required`——失败的升级绝不拆掉正在工作的插件。

### 文档
- 修正"插件列表"边界描述：官方列表读取的是运行时插件树，热装的包即时可见。

## [0.3.1] — 2026-08-17

### 文档
- 中文成为默认 README，新增英文版 `README.en.md`，索引行置于标题正下方。

## [0.3.0] — 2026-08-17

### 新增
- **重放保护**：手动编辑 `cordis.patch.yml` 会触发按启动快照的全量重组、冲掉热装行；新增 5 秒对账把丢失的行补回，并尊重补丁文件里显式的 `disabled: true`。
- **版本热更新**：快照从"包名列表"升级为"包名→版本 spec"，spec 变化时摘旧行重挂新行。（当时以为这样就绕开了 ESM 缓存，0.4.6 才真正修好。）

## [0.2.0] — 2026-08-17

### 新增
- **热卸载**：`dsh plugin remove` 当场卸载。此前包已从磁盘删除但行仍挂载，刷新页面会报 "Failed to load plugins"。实现包→行映射（启动时索引全部 bundle + 每次热装更新，仅存内存）。

## [0.1.1] — 2026-08-16

### 修复
- 启动失败：插件级 `inject: ['hmr']` 会让 entry 在 boot 时 pending，触发 fail-loud（`1 entry did not activate`）。去掉插件级 inject，改用子 fiber 等待 HMR 服务出现。

## [0.1.0] — 2026-08-16

### 新增
- 首个版本：监听 profile 清单（`package.json` 的 `dsh.profile.bundles`），把新 bundle 的补丁行注入运行中的插件树，`dsh plugin add` 免重启生效（实测约 8ms）。
