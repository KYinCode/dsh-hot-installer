# dsh-hot-installer

[English](README.en.md) | [中文](README.md) | [Changelog](CHANGELOG.md)

**Once installed, `dsh plugin add` / `remove` / `update` never require a restart again.** Install once, restart once, and this plugin watches your profile's bundle list for you: newly added packages mount immediately, removed ones unload immediately, upgraded ones reload in place — and even if you hand-edit your patch files, it replays hot-installed rows that the rebuild dropped.

## Do I need this? (by dsh version)

| Your dsh | What the platform itself does | What this plugin adds |
| --- | --- | --- |
| `0.1.5-rc.2` (npm `latest`, what a normal install gets) | HMR only watches patch files and **never looks at the profile manifest**: every add/remove/update needs a restart | **Everything** — add, remove and upgrade all take effect without a restart |
| `0.1.6-alpha.2` and later | The platform ships `dsh-hmr`, which owns the manifest and **reconciles add/remove natively** | The part the platform skips: **dependency version upgrades** (`add pkg@<new version>`) still stay hot, plus pre-flight, rollback on failure and emergency unmount |

So on the stable line this plugin is not redundant — it *is* the mechanism; on the newer alpha line it still earns its place (the platform neither handles version upgrades nor rolls back a failed one). If the platform ever covers both, this plugin can be uninstalled.

## What it is

In DeepSeek Harness everything is a plugin, but after `dsh plugin --profile web add <pkg>` you had to restart `dsh web` for the new bundle to mount — the profile's bundle list (`dsh.profile.bundles` in `package.json`) is only read at startup and nothing in the running process watches it. Removal was worse: `dsh plugin remove <pkg>` deletes the package from disk, but the mounted plugin row stays alive in memory, so the next page reload shows "Failed to load plugins" — the client still asks the deleted package for its code. Version updates were equally cold: the new code only loaded on restart.

This plugin turns that one cold path hot. It lives in the profile and watches the manifest file: when a new bundle appears it reads the package's declared patch (`cordis.patch.yml`) and injects the rows into the live plugin tree, which the loader's diff activates in milliseconds; when a bundle disappears it strips the matching rows (tracked via a package→rows map) and the loader unloads them; when a version spec changes it drops the row and re-adds it so the loader re-imports the new module. Nothing is written to your config files or patch layer, and after a restart the tree composes exactly as a normal boot would.

## Install & use

```sh
# one-time install (use your actual profile name), then restart dsh once
dsh plugin --profile web add dsh-hot-installer
```

From then on, your usual commands just work without restarts:

```sh
dsh plugin --profile web add some-plugin            # live, no restart
dsh plugin --profile web remove some-plugin         # live unload, no restart, no page errors
dsh plugin --profile web add some-plugin@latest     # live upgrade reload, no restart
```

Every hot install/remove/reload is logged to `~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log` (e.g. `hot-applied dsh-alive (1 patch entry)`, `hot-removed dsh-alive (1 patch entry)`, `hot-reloaded dsh-pomodoro (0.1.0 -> 0.3.0, 1 patch entry)`).

## How it works

On every manifest change (`dsh plugin add` writes twice — pnpm's dependency pass, then the bundle reconciliation — so changes are debounced by 300ms), the plugin diffs its snapshot (bundle name → version spec) to find additions, removals and upgrades. For an addition it resolves the package under the profile's node_modules, reads the patch file its `dsh.bundle.patch` points to (parsed with the exact YAML dialect boot uses, `!!js` expressions included), appends the parsed entries to the root include entry's `config.patches`, and calls `entry.update` — the same channel boot mounts plugins through, so hot and cold installs compose identically. For a removal it strips that package's recorded entries from `config.patches` (deep-equality match, one removal per entry) and updates the entry, and the loader unloads the rows. For an upgrade it removes the old row and re-adds the new one so the loader re-imports the module (bypassing the ESM cache). The package→rows map is built at startup for every bundle already in the manifest (so boot-mounted packages are removable too) and extended on each hot install; it lives in memory only.

**Patch-layer protection (replay)**: dsh's patch watcher recomposes the tree from a startup snapshot whenever `cordis.patch.yml` is hand-edited, which drops hot-installed rows. This plugin reconciles every 5 seconds: any recorded row that vanished from the live config is re-appended — unless the patch file explicitly disables it (`disabled: true`, e.g. from a plugin-toggle tool), in which case the intent is respected. Hand-editing patch files can no longer wipe out hot-installed plugins.

## Known limits

Upgrade reloads have a full protection chain: the new version is pre-flighted (its patch declaration parsed) before the live row is touched — a parse failure keeps the old row mounted and only logs `restart required`. If the new code itself fails to load (import/apply failure), the dependency is automatically reinstalled at its previous spec via pnpm and the row remounted (`update failed ... rolling back` / `rolled back` logs), so the plugin keeps working on the old code almost unnoticed; only when the rollback itself fails (e.g. the old version was unpublished) is a restart needed. Removal is equally honest: when the recorded rows are already absent from the live include config (e.g. a patch-layer refresh just dropped them), the removal counts as successful instead of falsely reporting `restart required`. Even the hot-installer itself can be hot-updated (since 0.4.4): a self-update no longer deadlocks against its own file watcher, so `dsh plugin add dsh-hot-installer@latest` also works without a restart. The official Settings → plugin list reads the live loader tree, so hot-installed packages are visible immediately.

Local-development `link:` installs have one known corner: on Windows pnpm links them through a junction reparse point into your local directory, and the Node process caches the real path that junction resolves to. So when you switch the link target to a *different* directory during one running dsh and hot-upgrade, the row keeps running the OLD directory's old code — the log prints `hot-reloaded` (a false success), but the new code is never loaded and the bundle's own activation log still shows the old version. Published npm packages are unaffected (every version switch loads fresh code), and editing files in place inside the same link directory simply never triggers an auto-update (no spec change to detect). Mitigation: restart dsh after switching a link to a different directory, or publish the local package to npm and hot-upgrade via `dsh plugin add pkg@<new version>`.

**Division of labour since dsh 0.1.6-alpha.2**: the platform's own `dsh-hmr` now watches the profile manifest and reconciles bundle add/remove natively, but it returns early when only a dependency spec changed — so hot version upgrades remain this plugin's job. It no longer competes for the same watched path (the platform registered it first): instead it polls the manifest once a second and handles only spec changes, keeping cache eviction, pre-flight, rollback and emergency-unmount intact. Both HMR service method names (`watchConfig` / `registerConfig`) are feature-detected, so one build runs on either dsh generation; the startup log states which mode is active.

**Since dsh 0.1.7-alpha.1**: `dsh.bundle.patch` widened from one file path to an **ordered list of files** (`dsh-web-app` now names five: its main patch plus four agent presets). The plugin parses and concatenates them in declaration order, matching the platform (`bundlePatchPaths()` then a `flatMap`) — the order is load-bearing, because recorded rows are matched against the live include config by deep equality and a differently ordered concatenation would fail to strip them. Single-path declarations behave exactly as before. Also, bundles the profile template contributes (`dsh-base` / `dsh-web-app`, which have **no** `dependencies` entry) are indexed but excluded from version updates: the platform owns how they are composed, and a "rollback to an empty spec" runs `pnpm add <pkg>@` — which does not fail, it installs that package's `latest` (`dsh-web-app@` resolves to 0.0.1-rc.1), a silent downgrade.

**Since 0.5.3** the plugin mirrors one more platform detail: every patch file the platform parses (bundle patches, `--patch` overlays, the profile layer) has insert-row `name` values that are absolute or start with `./` / `../` rewritten into `file://` URLs anchored beside that patch file. Without the same rewrite the recorded rows no longer match the live include config: hot-remove degrades to `rows already gone`, the re-add dedupes to nothing, and the row keeps running stale code without any error. Bare package names (e.g. `@deepseek-ai/dsh-persona`) stay literal.

**Since 0.5.4** bundle directories resolve in the platform's order: the dsh installation first, then the profile. Bundles that ship with dsh (`dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, …) are in **neither** the profile's `node_modules` nor its `dependencies`; the platform mounts them through the installation anchor, while a profile-only lookup reports them as not installed. The anchor comes from the platform's own `profileContext.installAnchor`, and is simply absent on hosts that do not expose it (previous behaviour).

## Development

```sh
npm install && npm test   # pure-helper unit tests (diff / parse / dedupe / remove / replay / patch declaration)
```

The repo ships a throwaway test bundle (`examples/dsh-hot-test-bundle`, writes an activation log line) for a no-restart install/uninstall drill. Requires Node >= 20 and a long-lived HMR surface (e.g. `dsh web`); one-shot CLI surfaces boot normally but never start the watcher.

## License

MIT — see [LICENSE](./LICENSE).
