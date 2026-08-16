# dsh-hot-installer

**给 DeepSeek Harness 装上之后，`dsh plugin add` 和 `dsh plugin remove` 都不再需要重启。** 装一次、重启一次，之后这个插件替你监听 profile 的插件清单，新装的包当场挂载、卸掉的包当场卸载。

## 这是什么

DeepSeek Harness 里一切皆插件，但你用 `dsh plugin --profile web add <pkg>` 装一个新 bundle 后，必须重启 `dsh web` 它才生效——因为 profile 的插件清单（`package.json` 里的 `dsh.profile.bundles`）只在启动时读取，运行中的进程不会再看它。更糟的是卸载：`dsh plugin remove <pkg>` 把包从磁盘删掉，但已挂载的插件行还留在内存里，此时刷新网页会看到 "Failed to load plugins" 报错（客户端还在向已删除的包要代码）。

这个插件把这条唯一的"冷路径"变热。它装好后常驻在 profile 里，监听清单文件的变化：发现新 bundle 就读取该包声明的补丁（`cordis.patch.yml`），把里面的插件行注入到运行中的插件树，loader 的 diff 机制当场激活（实测十几毫秒）；发现 bundle 被移除，就按启动时建立的"包→行"映射把对应行从树里摘掉，插件当场卸载。整个过程不写任何配置文件、不改你的补丁层，重启后依然与正常启动完全一致。

## 安装与使用

```sh
# 一次性安装（换成你实际在用的 profile 名），然后重启一次 dsh
dsh plugin --profile web add dsh-hot-installer
```

重启之后，插件就永久生效了，日常操作和原来一模一样：

```sh
dsh plugin --profile web add some-plugin      # 立即生效，不用重启
dsh plugin --profile web remove some-plugin   # 立即卸载，不用重启，页面也不会报错
```

日志在 `~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log`，每次热装/热卸都有记录（如 `hot-applied dsh-alive (1 patch entry)`、`hot-removed dsh-alive (1 patch entry)`）。

## 工作原理

清单文件每次变化（`dsh plugin add` 会写两次：pnpm 写依赖、再同步 bundles 列表，插件用 300ms 防抖合并），插件对比自己维护的快照找出新增和移除的包。对新增的包：从 profile 的 node_modules 解析出包目录，读取它 `package.json` 里 `dsh.bundle.patch` 指向的补丁文件（用与启动完全相同的 YAML 方言解析，包括 `!!js` 表达式），把解析出的 patch 条目追加到根 include entry 的 `config.patches` 并调用 `entry.update`——这正是启动时挂载插件的同一条通道，所以热装与冷装的结果完全一致。对移除的包：反向操作，把该包贡献的 patch 条目从 `config.patches` 里按深度相等逐个摘除再 `entry.update`，loader 卸载对应行。包→行的映射在启动时对清单里所有包建立（重启后 boot 挂载的包同样可热卸），每次热装时更新，只存在于内存。

## 已知边界

热装的插件行只活在内存里，如果之后**手动编辑** profile 的 `cordis.patch.yml`，HMR 会按启动时的快照全量重组插件树，热装的行会被卸掉（重启后恢复，因为清单里还有这些包）。同理，官方"设置 → 插件列表"显示的是启动时的快照，热装的包要等重启才出现在那里。**版本更新（`dsh plugin add pkg@latest`）不改变插件行，热安装器不会重载它**：刷新页面后浏览器拿到的是新版客户端代码，但进程里的主机半端还是旧版（ESM 缓存），极端情况下新版客户端可能调用不存在的旧主机接口——更新后建议重启一次。这几个都属于设计内行为：本插件只管清单的增删，不碰版本和补丁层。

## 开发与验证

```sh
npm install && node --test test/   # 纯函数单测（diff / 解析 / 去重 / 移除）
```

仓库自带一个测试用 bundle（`examples/dsh-hot-test-bundle`，装它后写一条激活日志），可用来做免重启的装/卸演练。要求 Node >= 20、带 HMR 的长驻表面（如 `dsh web`）；没有 HMR 的一次性命令行面会正常启动但永不激活监听。

## License

MIT，见 [LICENSE](./LICENSE)。
