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
