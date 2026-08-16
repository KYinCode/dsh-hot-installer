# dsh-hot-installer

**Once installed, `dsh plugin add` / `remove` / `update` never require a restart again.** Install once, restart once, and this plugin watches your profile's bundle list for you: newly added packages mount immediately, removed ones unload immediately, upgraded ones reload in place — and even if you hand-edit your patch files, it replays hot-installed rows that the rebuild dropped.

English | [中文](README.md)

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

The official Settings → plugin list reflects the startup snapshot, so hot-installed packages only appear there after a restart (a display-layer quirk, no functional impact). An upgrade reload happens after the new package is on disk and briefly unmounts the row; in the worst case, if the new code itself fails to load, the row stays absent with a `restart required` log entry and a restart restores it from the manifest.

## Development

```sh
npm install && node --test test/   # pure-helper unit tests (diff / parse / dedupe / remove / replay)
```

The repo ships a throwaway test bundle (`examples/dsh-hot-test-bundle`, writes an activation log line) for a no-restart install/uninstall drill. Requires Node >= 20 and a long-lived HMR surface (e.g. `dsh web`); one-shot CLI surfaces boot normally but never start the watcher.

## License

MIT — see [LICENSE](./LICENSE).
