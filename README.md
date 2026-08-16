# dsh-hot-installer

**Once installed, `dsh plugin add` and `dsh plugin remove` never require a restart again.** Install once, restart once, and this plugin watches your profile's bundle list for you: newly added packages mount immediately, removed ones unload immediately.

## What it is

In DeepSeek Harness everything is a plugin, but after `dsh plugin --profile web add <pkg>` you had to restart `dsh web` for the new bundle to mount — the profile's bundle list (`dsh.profile.bundles` in `package.json`) is only read at startup and nothing in the running process watches it. Removal was worse: `dsh plugin remove <pkg>` deletes the package from disk, but the mounted plugin row stays alive in memory, so the next page reload shows "Failed to load plugins" — the client still asks the deleted package for its code.

This plugin turns that one cold path hot. It lives in the profile and watches the manifest file: when a new bundle appears it reads the package's declared patch (`cordis.patch.yml`) and injects the rows into the live plugin tree, which the loader's diff activates in milliseconds; when a bundle disappears it strips the matching rows (tracked via a package→rows map built at startup) and the loader unloads them on the spot. Nothing is written to your config files or patch layer, and after a restart the tree composes exactly as a normal boot would.

## Install & use

```sh
# one-time install (use your actual profile name), then restart dsh once
dsh plugin --profile web add dsh-hot-installer
```

From then on, your usual commands just work without restarts:

```sh
dsh plugin --profile web add some-plugin      # live, no restart
dsh plugin --profile web remove some-plugin   # live unload, no restart, no page errors
```

Every hot install/remove is logged to `~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log` (e.g. `hot-applied dsh-alive (1 patch entry)`, `hot-removed dsh-alive (1 patch entry)`).

## How it works

On every manifest change (`dsh plugin add` writes twice — pnpm's dependency pass, then the bundle reconciliation — so changes are debounced by 300ms), the plugin diffs its snapshot against the new bundle list to find additions and removals. For an addition it resolves the package under the profile's node_modules, reads the patch file its `dsh.bundle.patch` points to (parsed with the exact YAML dialect boot uses, `!!js` expressions included), appends the parsed entries to the root include entry's `config.patches`, and calls `entry.update` — the same channel boot mounts plugins through, so hot and cold installs compose identically. For a removal it does the reverse: strips that package's recorded entries from `config.patches` (deep-equality match, one removal per entry) and updates the entry, and the loader unloads the rows. The package→rows map is built at startup for every bundle already in the manifest (so boot-mounted packages are removable too) and extended on each hot install; it lives in memory only.

## Known limits

Hot-installed rows live in memory only: if you then **hand-edit** the profile's `cordis.patch.yml`, HMR recomposes the tree from the startup snapshot and the hot-installed rows drop out (a restart brings them back, since the manifest still lists those packages). Likewise the official Settings → plugin list reflects the startup snapshot, so hot-installed packages only appear there after a restart. **Version updates (`dsh plugin add pkg@latest`) do not change the plugin row, so this plugin will not reload it**: after a page refresh the browser runs the new client code while the host half in the process stays on the old module (ESM cache) — in the worst case the new client calls APIs the old host does not have, so a restart after updating is recommended. All of these are by design: this plugin only manages the bundle list, never versions or the patch layer.

## Development

```sh
npm install && node --test test/   # pure-helper unit tests (diff / parse / dedupe / remove)
```

The repo ships a throwaway test bundle (`examples/dsh-hot-test-bundle`, writes an activation log line) for a no-restart install/uninstall drill. Requires Node >= 20 and a long-lived HMR surface (e.g. `dsh web`); one-shot CLI surfaces boot normally but never start the watcher.

## License

MIT — see [LICENSE](./LICENSE).
