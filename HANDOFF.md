# dsh-hot-installer — 交接清单（给新会话）

> 新会话的 agent：按本文件 + `idea.md` 实现 dsh-hot-installer。
> 本文件由前一会话（2026-08-14）整理，包含所有已验证事实，无需重新调研。

## 任务

实现"热安装器"宿主插件：**装一次后，`dsh plugin add <pkg>` 免重启**。
监听 profile 的 `package.json` 的 `dsh.profile.bundles` 变化 → 读取新
bundle 的 `cordis.patch.yml` → 把其行注入 root include entry → 热生效。

## 已验证的机制（PoC 结论，直接可用）

1. **宿主插件能找到 root include entry**：
   - `ctx.get('loader')` 可用
   - `loader.entries()` 是 **Generator**（不是 Map！用 `for...of` 迭代）
   - root include entry：`id="include"`，`name="cordis:include"`
   - 其 `options.config = { path, patches }`（patches 是数组）
2. **`entry.update(options)` 可调用**：
   - 签名 `update(options, create?, force?)`（cordis-plugin-loader 类型）
   - 热应用生效实测：`entry.update({ config: { ...config, patches: [...patches, { insert: [行] }] } })` → 注入行 **8ms 内激活**
3. **write() 是 no-op**：注入只活在内存，重启即清；patch 文件不会被改写（安全，无持久化污染）
4. **ESM 模块缓存坑**：覆盖插件文件不会重载（行必须移除/重加或 URL bump）
5. 挂载方式：`cordis.patch.yml` 的 `- insert:` 行 + `file://` 绝对路径（HMR ~4s 生效，免重启）

## 实现要点（来自 idea.md 的设计）

- 监听 `~/.dsh/profiles/web/package.json`（`hmr.registerConfig` 或 fs 监听 + 防抖；注意 `dsh plugin add` 会写两次文件——dependencies 和 bundles，防抖要覆盖）
- diff `dsh.profile.bundles` 快照 → 找出**新增**的 bundle 名
- 从 node_modules 解析新包 → 读其 `dsh.bundle.patch`（cordis.patch.yml）→ 解析出行
- 把行 append 到 include entry 的 `config.patches` → `entry.update`
- 失败处理：保持旧 config，日志"restart required for <pkg>"
- v1 只做 add；remove 留 v2（需要 bundle→行映射）
- 防重复：bundle patch 的行 id 与已存在行冲突时需合并/跳过

## 环境事实

- profile：`~/.dsh/profiles/web/`（cordis.patch.yml 是用户补丁层，HMR 热）
- 插件日志目录惯例：`~/.dsh/logs/<插件名>/<插件名>.log`（logs 根只放目录）
- 发布流程（已走通）：`npm version patch; npm publish; git push; dsh plugin --profile web update; 重启`
- git 身份（本机仓库级）：name=`KYinCode`，email=`104397972+KYinCode@users.noreply.github.com`
- npm 发布：granular token 已配置（bypass 2FA），无需 OTP
- 代理（git 用）：`http://127.0.0.1:7897`

## 参考代码

- `dsh-project-mcp-bridge` 的 `index.mjs`（同款结构：ESM、name/inject/apply 导出、文件日志、bundle 打包）
- `dsh-hot-installer/idea.md`（完整设计 + PoC 记录）
- `~/.dsh/profiles/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts`（Entry/update 类型）

## 收尾检查

- [x] 装一次热安装器 → 重启 → 用 `dsh plugin add` 装一个测试包 → 观察免重启生效
  （2026-08-16 实测：经用户补丁层热挂载插件本体后，`dsh plugin add dsh-hot-test-bundle`
  的插件行 **13ms 内激活**并写入日志，全程无重启）
- [x] 双语 README + 发布 npm + 推 GitHub（仓库名建议 `dsh-hot-installer`）
  - npm：`dsh-hot-installer@0.1.1`（2026-08-16 发布；0.1.0 → 0.1.1 修复见下）
  - GitHub：https://github.com/KYinCode/dsh-hot-installer

## 0.1.1 修复记录（2026-08-16）

- **症状**：0.1.0 用 `inject: ['hmr']` 声明依赖，但 HMR 服务在 boot **之后**才由
  profile-boot 创建 → entry 在 boot 时 pending → `assertEntriesActivated` fail-loud，
  `dsh web` 启动失败（`1 entry did not activate`）。
- **修复**：去掉插件级 inject（`inject: []`），apply 立即激活；用
  `ctx.inject(['hmr'], ...)` 起一个**子 fiber** 等 HMR 出现后再
  `hmr.registerConfig`（Cordis 的 `ctx.inject(inject, callback)` 不会阻塞本 entry）。
  无 HMR 的面永远不会启动监听，boot 不可能失败。
- **验证**：`dsh --profile hotboot`（临时 scratch profile，base + hot-installer）
  实测 boot 成功、插件日志出现 `active`；web profile 已重装 `dsh-hot-installer@^0.1.1`。

## 0.2.0 记录（2026-08-16）— V2：remove 热卸载

- **动机**：v1 卸载后行保留到重启，期间刷新页面报 "Failed to load plugins"
  （客户端仍向已删除的包要 bundle，404）——真实用户可见故障。
- **实现**：包→行映射（启动时扫描 manifest 全部 bundle 建立 + 每次热装更新，
  仅内存）；manifest diff 增加 removed 分支，按深度相等从 include config.patches
  逐个摘除该包贡献的 patch 条目再 `entry.update`，loader 当场卸载行。
  新增纯函数 `deepEqual` / `removePatches`（有单测）。
- **验证**（scratch profile hotboot2，registry 0.2.0）：boot 挂载的 dsh-alive
  remove → `hot-removed`（8ms）；热装的 dsh-alive remove → `hot-removed`（5ms）；
  add→remove 循环无残留。
- **README 已重写**（段落式），边界写入"已知边界"节。
- web profile 已装 `dsh-hot-installer@^0.2.0`（下次重启生效；运行中的 0.1.1
  继续工作到重启为止，无回归）。

## 0.3.0 记录（2026-08-16）— V3：重放保护 + 更新热重载

- **重放保护**：手动编辑 cordis.patch.yml → watchUserPatches 按 boot 快照重组
  → 热装行被丢。新增 5s 轮询对账（`missingPatches` + `replayablePatches`），
  缺失的记录行自动补回；补丁文件里显式 `disabled: true` 的行（插件开关工具
  的禁用）被尊重、不补。
- **更新热重载**：快照从"包名列表"升级为"包名→版本 spec"（`readDependencySpecs`
  / `diffSpecs`）；spec 变化 → 摘旧行 → 重挂新行 → loader 重新 import 新模块
  （绕 ESM 缓存），日志 `hot-reloaded X (from -> to, N patch entr...)`。
- **验证**（scratch hot-test2，registry 0.3.0）：补丁文件编辑 → HMR 丢行 →
  5s 内 `replayed 1 patch entry lost to a patch-layer refresh`（连续触发两次均
  成功）；pomodoro 0.1.0 → 0.3.0 → `hot-reloaded dsh-pomodoro (0.1.0 -> 0.3.0)`。
- **README**：中英互索引；边界节改写（只剩 inventory 快照展示层问题）。
- **仓库 About**（gh 已设置）：双语 description + topics（dsh/deepseek-harness/
  hot-reload/cordis 等）。
- web profile 已装 `dsh-hot-installer@^0.3.0`（下次重启生效）。

## 0.4.x 记录（2026-08-18）— 更新防护链（预检/回滚/紧急卸载）+ 卸载竞态修复

- **0.4.0 预检（preflight）**：`hotReload` 先解析新包的补丁声明再动旧行——
  解析失败时旧行保持不动、只记 `restart required`，失败的更新绝不拆掉正在
  工作的插件。
- **0.4.1/0.4.2 回滚 + 紧急卸载**：新代码 import/apply 失败 →
  `rollbackDependency` 用 pnpm 把依赖装回旧 spec，manifest 重写重新触发更新
  路径（to→from）重载旧行。0.4.2 修死循环：pnpm 对 dangling `link:` spec 也
  退出 0 却装不回可用包 → 回滚后必须 `readBundlePatch` 验证；验证失败 →
  `emergencyUnmount`：把包从 bundles 摘掉保证 dsh 可启动，日志给出精确的
  重新安装命令。
- **0.4.3 卸载竞态修复**：5s 重放对账与补丁层重组存在竞态——重组先丢行、
  对账时行还在树里就跳过补录，之后 `dsh plugin remove` 时行已不在活配置 →
  旧逻辑抛 `no matching rows found` 误报 `restart required`（web 实测复现：
  11:08:58 卸载 pomodoro）。修复：`hotRemove` 找不到记录行时视为已卸载成功
  （行不在 include config，重组后必然已卸载），返回 false、不再抛错；
  `hotReload` 同路径顺带受益（更新不再被同一竞态误判为失败）。
- **验证**：0.4.2 在 scratch 实测（坏补丁被预检拦截、升级失败自动回滚、
  回滚失败 emergencyUnmount、死循环终止）；0.4.3 修完后 web profile 更新为
  `dsh-hot-installer@^0.4.3`，观察自热重载日志（`hot-reloaded dsh-hot-installer`）
  或重启一次生效。

## 0.4.4 记录（2026-08-18）— 自更新死锁修复（重要）

- **症状**：web profile 重启到 0.4.2 后，第一次 `dsh plugin add
  dsh-hot-installer@latest`（升级自己）之后 watcher 永久失聪——后续所有
  manifest 写入（add/remove/原地改写）都无任何日志反应；插件列表显示
  `hot-installer, 未挂载`（自己的行被摘掉后重挂从未完成）。旧 0.3.0 进程
  在 11:08 之后同样失聪（同一死锁的不同触发路径）。
- **根因（循环等待）**：HMR 的 `refreshConfig` 会 `await` 回调，回调挂起
  期间 refresh 任务一直"运行中"；`registerConfig` 返回的 disposer 会
  `await` 这个运行中的任务。自更新时：热摘自己的行 → loader 卸载本 entry
  → 本插件的子 fiber 被 dispose → 执行我们自己挂的 disposer → 它调用 HMR
  disposer → HMR disposer 等 refresh 任务 → refresh 任务等我们的回调 →
  回调返回的是整条处理链（`enqueueRefresh()` 返回 chain）→ chain 正等
  `includeEntry.update()` → update 等 entry 卸载完成 → **循环等待，永不
  结束，无任何日志**。replay 定时器也排在同一条 chain 上，一并卡死。
- **修复**：`registerConfig` 的回调改为 `() => void enqueueRefresh()`——不
  再返回 chain，HMR refresh 任务立即结束，disposer 不再等待；chain 仍在
  内部自行串行所有刷新。循环断裂，自更新可以完成（摘行→disposer 快速
  收尾→重挂新行→新实例重新 registerConfig 并再次打印 `active`）。
- **恢复**：include 的 config.patches 只活在内存（write 是 no-op），重启
  时 boot 从磁盘（各 bundle 补丁 + cordis.patch.yml）重新合成，行必然
  回来；manifest 磁盘状态本身干净。
- web profile 已装 `dsh-hot-installer@^0.4.4`（重启生效；重启后先做一次
  add/remove 往返验证 watcher 存活，再观察自更新是否打印
  `hot-reloaded dsh-hot-installer` + 第二次 `active`）。

## 0.4.5 / 0.4.6 记录（2026-08-18）— 自更新实测 + ESM 缓存谎言揭穿

- **0.4.5 自更新首次成功**：`add dsh-hot-installer@latest`（0.4.4→0.4.5）日志
  出现 `hot-reloaded dsh-hot-installer` + 3ms 后第二次 `active`——死锁修复
  生效。0.4.5 同时给启动日志加自身版本号（`OWN_VERSION` 从 ./package.json
  读取；磁盘与进程版本可漂移，日志必须说明实际加载的是哪个版本）。
- **ESM 缓存谎言**：0.4.5 自更新后的 `active` 没有 `v0.4.5` 后缀——不是
  读版本号失败，而是**重挂后 import 的仍是旧模块**。探针（esm-cache-probe.mjs）
  实证：`import()` 按 URL 缓存，同 URL 二次 import 返回旧模块，URL 加 query
  才加载新的。loader 的 `internal.import(name, baseUrl)` 不做缓存失效，所以
  0.3.0 以来所有 `hot-reloaded` 日志都是假象：行重挂了，代码还是旧的。
- **0.4.6 修复**：`hotReload` 重挂前 `evictBundleModules`——按包目录前缀清掉
  `loader.internal.loadCache`（用 `Map.prototype.delete`，Node 24 的
  LoadCache.delete 只清槽位）和 CJS `require.cache`，与 HMR 服务自己的缓存
  处理一致；新增日志 `evicted N cached modules for <pkg> (from -> to)`。
- **0.4.6 实测**：① 进程内一次性驱逐（动态插件 evict-1）→ `add pkg@0.4.6`
  精确版 → `active ... v0.4.6`——驱逐后确实加载新代码；② 手改 manifest
  spec（0.4.6→^0.4.6）→ 内置驱逐触发：`evicted 2 cached modules` +
  `hot-reloaded` + `active ... v0.4.6`——内置路径全通。
- 诊断工具：`esm-cache-probe.mjs`（仓库根，复现同 URL 缓存行为）。
- web profile 现装 `dsh-hot-installer@^0.4.6`，运行中即 0.4.6（自更新，
  全程未重启）。

## 0.4.7 / 0.4.8 记录（2026-08-18）— 重放计数诚实 + 驱逐双前缀 + 回滚演练

- **0.4.7 重放计数诚实化**：`!!js` 表达式的行被加载器求值后与原记录 deepEqual
  不等，每次补丁层重组都被误判"缺失"，`dedupeInserts` 正确地跳过（行还在树
  里），但日志按"判缺失数"统计（真实补 1 却报 `replayed 3`）。改为按**实际
  追加数** + 列出包名：`replayed 1 patch entry for dsh-alive lost to a
  patch-layer refresh`。
- **0.4.8 驱逐双前缀**：Windows 上 pnpm 装的包缓存键保留 node_modules 软链
  路径，而 `link:` junction 到外部目录的包缓存键是 junction 目标的 realpath
  （解析跟随 junction）。只按包目录前缀驱逐会漏掉 junction 情况。改为同时匹配
  `packageDir` 和 `realpathSync(packageDir)`。
- **回滚演练（scratch hot-roll，0.4.8 实测）**：
  - A 热装 good → `hot-applied` + bundle 激活日志 ✓
  - B 升级到坏补丁 → 预检报错（带 YAML 定位）→ `rolling back` → `rolled back
    ... reloading from the manifest` → `hot-reloaded` 回 good，bundle 日志再次
    `ROLL v1.0.0 active` ✓（坏补丁绝不拆掉工作中的旧行）
  - D 升级到含 `dsh.bundle` 但回滚目标（good 目录）被删 → 回滚 pnpm 退出 0 但
    验证失败 → `emergencyUnmount`：从 bundles 摘掉 + 精确恢复命令 + watcher
    顺手 `hot-removed`，profile 保持可启动、无死循环 ✓
  - C（apply 抛错触发回滚）未拿到干净复现：`link:` junction 在某次换目标后，
    进程内 Node 的 fs realpath 缓存让重解析仍返回旧目标 realpath，import 撞上
    旧模块缓存 → 更新"假成功"。**结论：`link:` 本地 bundle 走 junction、换目标
    需重启才可靠；npm 正式包不受影响**（web 自更新 0.4.6→0.4.7→0.4.8 三次均
    加载新代码，`v0.4.x` 后缀为证）。
- web profile 现装 `dsh-hot-installer@^0.4.8`，运行中即 0.4.8（自更新，
  全程未重启）。
