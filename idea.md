# Idea: dsh-hot-installer (bundle hot-install plugin)

> Status: **feasibility VERIFIED by PoC** — recorded 2026-08-14; full
> implementation not yet built.
> Owner: KYinCode. Origin: discussion in the dsh-project-mcp-bridge session.

## PoC result (2026-08-14) — all three assumptions confirmed ✅

A temporary host plugin (mounted via the user patch layer) proved:

1. **A host plugin CAN find the root include entry**: `ctx.get('loader')`
   works; `loader.entries()` is a **Generator** (not a Map!) iterating the
   whole tree; the root include entry is `id="include"`,
   `name="cordis:include"`, with `options.config = { path, patches }`.
2. **`entry.update(options)` is callable** from a host plugin (type
   `function`; signature `update(options, create?, force?)` from
   `cordis-plugin-loader` types).
3. **Hot application WORKS**: calling
   `entry.update({ config: { ...config, patches: [...patches, { insert: [row] }] } })`
   activated the injected plugin row **within ~8 ms** (the injected
   plugin's `apply` wrote a marker file) — no restart, no HMR wait, the
   loader diff applied the new row live.

Additional facts learned:
- The include entry's `write()` is a no-op in this deployment — injected
  patches live in memory only and vanish on restart; the patch file is not
  rewritten (verified: cordis.patch.yml unchanged after injection).
- `loader.store` keys included the include entry plus a few other roots
  (dynamic packages?); iterating `entries()` is the reliable discovery path.
- ESM module cache: overwriting a plugin file does NOT reload it — the row
  must be removed/re-added (or URL bumped) to pick up file changes.

## Problem

`dsh plugin --profile web add <pkg>` installs a bundle but the new bundle
only mounts after restarting `dsh web`: `dsh.profile.bundles` (package.json)
is composed at startup and has no watcher (HMR only watches the user patch
files). This is a real inconsistency with the "everything is a plugin, hot
swappable" ethos — installing new packages is the one path that is cold.

## Idea

A meta-plugin installed once (one restart to mount it). After that, every
`dsh plugin add <pkg>` takes effect **without restarting**:

```
hot-installer (bundle layer, mounted once)
  ├─ hmm.registerConfig(<profile>/package.json, cb)   // watch bundles list
  ├─ on change (debounced):
  │    1. diff dsh.profile.bundles snapshot -> newly added bundle names
  │    2. resolve the new package dir from node_modules
  │    3. read its dsh.bundle.patch (cordis.patch.yml) -> insert rows
  │    4. append those rows to the root include entry's config.patches
  │    5. entry.update({config}) -> loader diff -> new rows activate live
  └─ on failure: keep old config, log "restart required for <pkg>"

Removal (dsh plugin remove) is deferred to v2 (needs bundle->row mapping
and removal diff; more complex).
```

## Feasibility (verified mechanisms, from the dsh-project-mcp-bridge session)

- `hmr.registerConfig(filename, cb)` — the exact API `watchUserPatches`
  uses to hot-apply the user patch layer; a plugin can register ANY file.
- root include `entry.update({config})` — the single hot-application entry
  (app-boot's `watchUserPatches` calls it; loader diffs and activates rows).
- loader patch diff — added rows activate, removed rows unload.

## Open questions / risks

1. **Reachability**: app-boot's `bootstrapIncludes` map is private; a host
   plugin must find the root include entry itself (walk `ctx.loader.entries()`
   or use the Include service). Needs PoC: host plugin can reach the entry
   and call update.
2. **Double write**: `dsh plugin add` writes dependencies then bundles
   (two pnpm/reconcile passes) -> watcher fires twice; debounce must cover.
3. **Duplicate id**: if the new bundle's patch inserts a row with the same
   id as one already in the tree (e.g. a bundle whose patch targets an
   existing row), the diff must merge, not duplicate.
4. **Remove**: v1 = add-only; v2 = removal via bundle->row mapping.
5. **Upstream**: if deepseek-harness later watches `dsh.profile.bundles`
   itself (issue-worthy), this plugin becomes obsolete — good outcome.

## Next steps

1. PoC: host plugin reaches the root include entry and can entry.update
   a test patch (verify mechanism before writing the full plugin).
2. Full implementation (~200 lines): watch, debounce, diff, apply, fail
   back to old config with a clear log.
3. Publish as its own npm bundle (`dsh-hot-installer`), bilingual README.
4. If PoC fails (entry unreachable), document the blocker and post the
   mechanism gap as an upstream issue instead.
