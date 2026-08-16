# dsh-hot-installer

**DeepSeek Harness 的 profile bundle 热安装器 —— 装一次、重启一次，之后永远不用再重启。**

`dsh plugin add <pkg>` 会把包装好，但新 bundle 要等重启 `dsh` 才挂载：
`dsh.profile.bundles` 只在启动时组装，HMR 只盯着用户补丁文件——装包是整棵热树上
唯一"冷"的路径。

这个插件把它补上。它用 app-boot 监听 `cordis.patch.yml` 的同一套 HMR 机制监听
profile manifest，发现新 bundle 时读取该包的 `cordis.patch.yml`，追加到根 include
entry 的 patch 列表，让 loader diff 当场激活新行（PoC 实测约 8ms）。

## 安装

```bash
# 一次性安装（装进你实际在跑的 profile，比如 web）：
dsh plugin --profile web add dsh-hot-installer

# 重启一次 dsh 让插件挂载
```

完了。之后：

```bash
# 新 bundle —— 立即生效，不用重启：
dsh plugin --profile web add some-other-bundle
```

## 工作原理

```
dsh-hot-installer（作为 profile bundle 挂载）
  ├─ hmr.registerConfig(<profile>/package.json, refresh)   // 与 watchUserPatches 同款 API
  ├─ 变更时（防抖）：
  │    1. diff dsh.profile.bundles 快照 → 找新增的 bundle 名
  │    2. 从 profile 的 node_modules 解析已安装的包目录
  │    3. 读它的 dsh.bundle.patch（cordis.patch.yml）→ patch 列表
  │    4. 按行 id 对活树去重，把剩下的追加到根 include entry 的 config.patches
  │    5. entry.update({ config }) → loader diff 当场激活新行
  └─ 失败时：保持旧 config，日志 "restart required for <pkg>"
```

设计要点：

- **注入的行与启动时组装完全一致。** patch 列表落在 boot 填写的同一个
  `config.patches` 槽位、走同一个 include entry，所以下次重启得到的树和热注入的
  树一模一样。磁盘上不写任何东西——注入只活在内存里（本部署中 include 的
  `write()` 是 no-op）。
- **重复 id 跳过而不是重复。** 若插入行的 id 在活树里已存在（来自更早的 bundle
  或你自己的 `cordis.patch.yml`），该行被剔除；按 id 定向的 patch 原样保留。
- **v1 只做 add。** `dsh plugin remove` 后行会一直挂到下次重启——移除需要
  bundle→行映射，留给 v2。
- **失败是逐包、非破坏性的。** 解析不了的 bundle 记一条 `restart required for
  <pkg>`；已生效的包和现有树不受影响。
- **profile 目录从 include entry 推导**，装一次即可服务任意 profile——每个
  profile 的进程各自监听自己的 manifest。

## 日志

```
~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log
```

每次热安装都有记录（`hot-applied <pkg> (N patch entries)`）；需要重启的包会连
同原因一起记录。

## 要求

- 带 HMR 服务的 DeepSeek Harness profile 常驻面（如 `dsh web`）。插件在 boot
  时立即激活——不会因缺服务而挂起，所以不可能导致启动失败——HMR 出现后才开始
  监听；没有 HMR 的面永远不会启动它。
- Node >= 20。

## 验证

仓库自带一个一次性测试包：

```bash
dsh plugin --profile web add file:./examples/dsh-hot-test-bundle
# 不重启！测试包立即挂载，并写日志
# ~/.dsh/logs/dsh-hot-test-bundle/dsh-hot-test-bundle.log
dsh plugin --profile web remove dsh-hot-test-bundle
```

## 开发

```bash
npm install          # js-yaml（解析 patch 用）
node --test test/    # 纯函数的单元测试
```

## License

MIT —— 见 [LICENSE](./LICENSE)。
