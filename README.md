# dsh-hot-installer

**Hot-install profile bundles for DeepSeek Harness — install once, restart once, then never again.**

`dsh plugin add <pkg>` installs a bundle, but the new bundle only mounts after
restarting `dsh`. The bundle list (`dsh.profile.bundles`) is composed at boot,
and HMR only watches the user patch files — installing packages is the one
cold path in an otherwise hot tree.

This plugin closes it. It watches the profile manifest through the same HMR
mechanism app-boot uses for `cordis.patch.yml`, and when a new bundle appears
it reads the package's `cordis.patch.yml`, appends it to the root include
entry's patch list, and lets the loader diff activate the new rows live
(measured ~8 ms in the PoC).

## Install

```bash
# one-time install (into the profile you run, e.g. web):
dsh plugin --profile web add dsh-hot-installer

# restart dsh once so the plugin mounts
```

That's it. From now on:

```bash
# new bundle — takes effect immediately, no restart:
dsh plugin --profile web add some-other-bundle
```

## How it works

```
dsh-hot-installer (mounted as a profile bundle)
  ├─ hmr.registerConfig(<profile>/package.json, refresh)   // same API as watchUserPatches
  ├─ on change (debounced):
  │    1. diff dsh.profile.bundles snapshot -> newly added bundle names
  │    2. resolve the installed package (node_modules lookup from the profile)
  │    3. read its dsh.bundle.patch (cordis.patch.yml) -> patch list
  │    4. dedupe insert rows against the live tree, append the rest
  │       to the root include entry's config.patches
  │    5. entry.update({ config }) -> loader diff activates the rows live
  └─ on failure: keep the old config, log "restart required for <pkg>"
```

Design notes:

- **The injected rows compose identically to boot.** The patch list lands in
  the same `config.patches` slot boot fills, through the same include entry,
  so a later restart produces exactly the same tree. Nothing is written back
  to disk — injections live in memory only (the include's `write()` is a
  no-op in this deployment).
- **Duplicate ids are skipped, not duplicated.** If an inserted row's id
  already exists in the live tree (an earlier bundle, or your own
  `cordis.patch.yml`), that row is left out; id-targeted patches pass through
  untouched.
- **v1 is add-only.** `dsh plugin remove` keeps the rows mounted until the
  next restart — removal needs a bundle→row mapping and is v2 work.
- **Failures are per-bundle and non-destructive.** A bundle that cannot be
  resolved or parsed is logged as `restart required for <pkg>`; already
  applied bundles and the existing tree are untouched.
- **The profile is derived from the include entry**, so one install serves
  any profile — each profile's process watches its own manifest.

## Logs

```
~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log
```

Each hot install is recorded (`hot-applied <pkg> (N patch entries)`); a
bundle that needs a restart is recorded with the reason.

## Requirements

- DeepSeek Harness profile surface with the HMR service (long-lived surfaces
  such as `dsh web`; the plugin waits for HMR, so one-shot surfaces simply
  never run it).
- Node >= 20.

## Verify

The repository ships a throwaway test bundle:

```bash
dsh plugin --profile web add file:./examples/dsh-hot-test-bundle
# no restart! the test bundle mounts immediately and logs
# ~/.dsh/logs/dsh-hot-test-bundle/dsh-hot-test-bundle.log
dsh plugin --profile web remove dsh-hot-test-bundle
```

## Development

```bash
npm install          # js-yaml (for patch parsing)
node --test test/    # unit tests for the pure helpers
```

## License

MIT — see [LICENSE](./LICENSE).
