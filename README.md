# dsh-hot-installer

**给 DeepSeek Harness 装上之后，`dsh plugin add` / `remove` / `update` 都不再需要重启。** 装一次、重启一次，之后这个插件替你监听 profile 的插件清单：新装的包当场挂载、卸掉的包当场卸载、升级的包当场重载；就算你手动编辑了补丁文件，它也会把被冲掉的热装行自动补回来。

中文 | [English](README.en.md)

## 这是什么

DeepSeek Harness 里一切皆插件，但你用 `dsh plugin --profile web add <pkg>` 装一个新 bundle 后，必须重启 `dsh web` 它才生效——因为 profile 的插件清单（`package.json` 里的 `dsh.profile.bundles`）只在启动时读取，运行中的进程不会再看它。卸载更糟：`dsh plugin remove <pkg>` 把包从磁盘删掉，但已挂载的插件行还留在内存里，此时刷新网页会看到 "Failed to load plugins" 报错（客户端还在向已删除的包要代码）。版本更新同样冷：新代码要等重启才会被加载。

这个插件把这条唯一的"冷路径"变热。它装好后常驻在 profile 里，监听清单文件的变化：发现新 bundle 就读取该包声明的补丁（`cordis.patch.yml`），把里面的插件行注入到运行中的插件树，loader 的 diff 机制当场激活（实测十几毫秒）；发现 bundle 被移除，就按"包→行"映射把对应行从树里摘掉；发现版本号变了，就把行摘掉再重挂，让 loader 重新加载新模块。整个过程不写任何配置文件、不改你的补丁层，重启后依然与正常启动完全一致。

## 安装与使用

```sh
# 一次性安装（换成你实际在用的 profile 名），然后重启一次 dsh
dsh plugin --profile web add dsh-hot-installer
```

重启之后，插件就永久生效了，日常操作和原来一模一样：

```sh
dsh plugin --profile web add some-plugin      # 立即生效，不用重启
dsh plugin --profile web remove some-plugin   # 立即卸载，不用重启，页面也不会报错
dsh plugin --profile web add some-plugin@latest   # 立即升级重载，不用重启
```

日志在 `~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log`，每次热装/热卸/热重载都有记录（如 `hot-applied dsh-alive (1 patch entry)`、`hot-removed dsh-alive (1 patch entry)`、`hot-reloaded dsh-pomodoro (0.1.0 -> 0.3.0, 1 patch entry)`）。

## 工作原理

清单文件每次变化（`dsh plugin add` 会写两次：pnpm 写依赖、再同步 bundles 列表，插件用 300ms 防抖合并），插件对比自己维护的快照（包名 → 版本号）找出新增、移除和升级的包。对新增的包：从 profile 的 node_modules 解析出包目录，读取它 `package.json` 里 `dsh.bundle.patch` 指向的补丁文件（用与启动完全相同的 YAML 方言解析，包括 `!!js` 表达式），把解析出的 patch 条目追加到根 include entry 的 `config.patches` 并调用 `entry.update`——这正是启动时挂载插件的同一条通道，所以热装与冷装的结果完全一致。对移除的包：把该包贡献的 patch 条目从 `config.patches` 里按深度相等逐个摘除再 `entry.update`，loader 卸载对应行。对升级的包：先摘除旧行再重新挂载新行，loader 会重新 import 拿到新版代码（绕开 ESM 模块缓存）。包→行的映射在启动时对清单里所有包建立（重启后 boot 挂载的包同样可热卸），每次热装时更新，只存在于内存。

**补丁层保护（重放）**：dsh 的补丁监听在 `cordis.patch.yml` 被手动编辑时会用启动时的快照全量重组插件树，这会丢掉热装的行。本插件每 5 秒做一次对账：发现记录的某行从活配置里消失了，就把它补回去；如果补丁文件里显式写了某行的 `disabled: true`（比如插件开关工具做的禁用），则尊重它、不补。所以手动编辑补丁文件不会再"冲掉"热装插件。

## 已知边界

官方"设置 → 插件列表"显示的是启动时的快照，热装的包要等重启才出现在那里（展示层问题，不影响功能）。更新的热重载发生在包已落盘之后、行被摘除重挂的瞬间，极端情况下如果新版代码本身无法加载，该行会保持缺席并记录 `restart required`，重启后按清单正常恢复。

## 开发与验证

```sh
npm install && node --test test/   # 纯函数单测（diff / 解析 / 去重 / 移除 / 重放）
```

仓库自带一个测试用 bundle（`examples/dsh-hot-test-bundle`，装它后写一条激活日志），可用来做免重启的装/卸演练。要求 Node >= 20、带 HMR 的长驻表面（如 `dsh web`）；没有 HMR 的一次性命令行面会正常启动但永不激活监听。

## License

MIT，见 [LICENSE](./LICENSE)。
