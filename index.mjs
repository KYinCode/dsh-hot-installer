// dsh-hot-installer — hot-install, hot-remove, hot-reload and hot-replay
// profile bundles without restarting dsh.
//
// Problem: `dsh plugin --profile <name> add <pkg>` installs a bundle, but the
// bundle only mounts after restarting dsh — dsh.profile.bundles is composed
// at boot and nothing watches it (HMR only watches the user patch files).
// Installing, removing and updating packages are the cold paths in an
// otherwise hot tree, and a removed bundle whose row stays mounted breaks
// the next page load (the client bundle 404s).
//
// Fix: this plugin watches the profile manifest (<profile>/package.json)
// through the same HMR config registration app-boot uses for cordis.patch.yml
// (`hmr.registerConfig`). When a NEW bundle name appears in
// dsh.profile.bundles, it resolves the installed package, reads its
// dsh.bundle.patch (cordis.patch.yml), and appends the parsed patch list to
// the root include entry's config.patches — the loader diff activates the
// rows live (PoC measured ~8 ms). When a bundle name DISAPPEARS, the
// recorded patch entries are stripped out of the same config.patches and the
// loader diff unloads the rows. When a bundle's DEPENDENCY SPEC changes
// (`dsh plugin add pkg@latest`), the row is removed and re-added in one
// step (after evicting the bundle's modules from Node's ESM/CJS caches, which
// the loader otherwise serves by URL forever), forcing a fresh import that
// picks up the new code.
//
// Two protections cover the interaction with the user patch layer:
// 1. REPLAY: boot's watchUserPatches recomposes the include from a static
//    startup snapshot whenever cordis.patch.yml changes by hand — that
//    rebuild silently drops hot-installed rows. A periodic reconciliation
//    re-appends any recorded row the live config lost (skipping rows the
//    patch file explicitly disables, so `dsh plugin toggle` style disabling
//    is respected).
// 2. The bundle→rows mapping is built at startup for every bundle already in
//    the manifest (boot-time rows are removable too) and extended on every
//    hot install. It lives in memory only: a restart rebuilds it from the
//    manifest, and a restart was always the fallback for anything this
//    plugin cannot reconcile.
//
// Mounting: install once as a profile bundle (see package.json
// dsh.bundle.patch and cordis.patch.yml), restart once. From then on, every
// `dsh plugin add` / `dsh plugin remove` / `dsh plugin update` is hot.

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

// Own package version for the startup log line — disk and running process can
// drift (an update installs files but the old module keeps running until the
// row is reloaded), so the log must say which version actually loaded.
const OWN_VERSION = await readFile(new URL('./package.json', import.meta.url), 'utf8')
  .then((content) => {
    try {
      return JSON.parse(content).version ?? ''
    } catch {
      return ''
    }
  })
  .catch(() => '')

export const name = 'dsh-hot-installer'
// Deliberately NO plugin-level inject: the entry must activate at boot even
// though the HMR service is only created after boot on long-lived surfaces —
// a pending entry fails boot loud (assertEntriesActivated). The watcher setup
// instead waits for HMR in a child fiber (see ctx.inject in apply).
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
// Plugin-scoped log: logs/ root holds directories per plugin, not loose files.
const LOG_FILE = join(DSH_HOME, 'logs', 'dsh-hot-installer', 'dsh-hot-installer.log')
// `dsh plugin add` writes the profile manifest twice (pnpm's dependency pass,
// then the bundle reconciliation pass); the settle window coalesces both.
const SETTLE_MS = 300
// A torn manifest read (mid-write) retries once after this delay.
const RETRY_MS = 500
// Periodic reconciliation interval: replays hot-installed rows the user
// patch layer's HMR rebuild dropped (see the REPLAY note in the header).
const REPLAY_INTERVAL_MS = 5000

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

let logFileReady = null
function fileLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
  if (logFileReady === null) {
    logFileReady = mkdir(dirname(LOG_FILE), { recursive: true })
      .then(() => appendFile(LOG_FILE, line))
      .catch(() => {})
  } else {
    logFileReady = logFileReady.then(() => appendFile(LOG_FILE, line)).catch(() => {})
  }
}

function log(ctx, level, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](`dsh-hot-installer: ${message}`)
  } catch { /* logger absence is not fatal */ }
  fileLog(level, message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// entry-list YAML dialect (mirrors @deepseek-ai/cordis-plugin-include):
// !!js scalars round-trip as expression nodes the Loader evaluates at entry
// activation. Patch rows must parse with the same schema the boot include
// uses, or `dsh --dump-config` and the live tree would disagree.
// ---------------------------------------------------------------------------

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (data) => typeof data === 'object' && data !== null && typeof data.__jsExpr === 'string',
  represent: (data) => data.__jsExpr,
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

// ---------------------------------------------------------------------------
// pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** The profile's bundle layer list, or [] when absent. */
export function readBundles(manifest) {
  const list = manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
  return Array.isArray(list) ? [...list] : []
}

/** Bundle names present in `current` but not in `snapshot`, in list order. */
export function diffBundles(snapshot, current) {
  return current.filter((bundle) => !snapshot.includes(bundle))
}

/** The profile's dependency map (name → version spec), or {} when absent. */
export function readDependencySpecs(manifest) {
  const deps = manifest && manifest.dependencies
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return {}
  return { ...deps }
}

/**
 * Bundles whose dependency spec changed between two snapshots.
 * @param known - Map<name, spec> from the previous read.
 * @param current - Map<name, spec> from the latest read.
 * @returns [{ name, from, to }] for names present in both with different specs.
 */
export function diffSpecs(known, current) {
  const updates = []
  for (const [name, spec] of current) {
    if (!known.has(name)) continue
    const previous = known.get(name)
    if (previous !== spec) updates.push({ name, from: previous, to: spec })
  }
  return updates
}

/**
 * Which recorded bundle rows are missing from the live include config.
 * @param bundlePatches - Map<name, patch entries the bundle contributed>.
 * @param currentPatches - the include entry's current config.patches (or undefined).
 * @returns Map<name, entries> for bundles whose entries are not all present.
 */
export function missingPatches(bundlePatches, currentPatches) {
  const present = currentPatches ?? []
  const missing = new Map()
  for (const [name, entries] of bundlePatches) {
    if (entries.length === 0) continue
    const absent = entries.filter((entry) => !present.some((candidate) => deepEqual(candidate, entry)))
    if (absent.length > 0) missing.set(name, absent)
  }
  return missing
}

/**
 * Ids the profile patch file explicitly disables (`- id: X` + `disabled: true`).
 * Used to respect intentional disabling during replay: a row the user (or a
 * toggle tool) disabled in the patch layer must NOT be re-added.
 */
export function disabledIds(patches) {
  const ids = new Set()
  for (const patch of patches) {
    if (patch && typeof patch.id === 'string' && patch.disabled === true) ids.add(patch.id)
  }
  return ids
}

/**
 * Decide which missing rows to replay, honoring disabled markers:
 * an insert row whose id is disabled in the patch file is skipped; a patch
 * entry that only carries such rows is skipped entirely.
 */
export function replayablePatches(missing, disabled) {
  const result = new Map()
  for (const [name, entries] of missing) {
    const kept = dedupeInsertRowsByDisabled(entries, disabled)
    if (kept.length > 0) result.set(name, kept)
  }
  return result
}

function dedupeInsertRowsByDisabled(entries, disabled) {
  const kept = []
  for (const patch of entries) {
    if (!Array.isArray(patch.insert)) {
      // id-targeted entries (config overrides) carry no row of their own:
      // replay them unless they target a disabled id.
      if (!(patch && typeof patch.id === 'string' && disabled.has(patch.id))) kept.push(patch)
      continue
    }
    const rows = patch.insert.filter((row) => !(row && typeof row.id === 'string' && disabled.has(row.id)))
    if (rows.length === 0) continue
    kept.push(rows.length === patch.insert.length ? patch : { ...patch, insert: rows })
  }
  return kept
}

/**
 * Resolve a bundle package's root directory from the profile: Node's own
 * node_modules lookup order anchored at the profile manifest, so the result
 * matches what the Loader imports and follows pnpm's symlinked layout.
 * @returns the package's absolute directory, or undefined when not installed.
 */
export function resolveBundleDir(profileDir, packageName) {
  const requireFromProfile = createRequire(join(profileDir, 'package.json'))
  for (const searchPath of requireFromProfile.resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Parse a bundle's patch file: a top-level YAML array of loader patch entries. */
export function parsePatchList(text, file) {
  let parsed
  try {
    parsed = yaml.load(text, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`failed to parse ${file}: ${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`patch entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return parsed
}

/**
 * Drop insert rows whose id already exists in the live tree (a row from an
 * earlier bundle or the user patch layer): a duplicate id in one entry list
 * confuses the loader diff, and the row is already mounted — nothing to add.
 * id-targeted (non-insert) patches are kept verbatim: they configure existing
 * rows, which is exactly the merge case. A patch whose inserts all collide is
 * removed entirely.
 */
export function dedupeInserts(patches, existingIds) {
  const result = []
  for (const patch of patches) {
    if (!Array.isArray(patch.insert)) {
      result.push(patch)
      continue
    }
    const kept = patch.insert.filter((row) => !(row && typeof row.id === 'string' && existingIds.has(row.id)))
    if (kept.length === 0) continue
    if (kept.length === patch.insert.length) {
      result.push(patch)
    } else {
      result.push({ ...patch, insert: kept })
    }
  }
  return result
}

/**
 * Deep equality for JSON-safe loader values (plain objects/arrays/scalars and
 * the `{ __jsExpr }` wrapper the entry-list YAML dialect produces).
 */
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * Remove one bundle's contributed patch entries from the include's patch
 * list: each recorded entry is matched by deep equality and removed once
 * (later entries are matched against the shrinking list, so a duplicate of
 * an earlier entry is never double-removed). Entries not found are left for
 * the caller to diagnose.
 */
export function removePatches(patches, bundlePatches) {
  const result = [...patches]
  for (const target of bundlePatches) {
    const index = result.findIndex((entry) => deepEqual(entry, target))
    if (index !== -1) result.splice(index, 1)
  }
  return result
}

/**
 * Evict a bundle's modules from Node's ESM and CJS caches so a re-added row
 * re-imports the NEW files. The loader's `import()` caches by resolved URL:
 * removing and re-adding a row with the same name serves the OLD module
 * forever (verified live: a self-update kept running the previous version's
 * code, and the startup log still lacked the new version). Mirror the HMR
 * service's cache handling: use Map.prototype methods on loadCache, because
 * Node 24's LoadCache.delete() only nulls the type slot instead of removing
 * the entry.
 * @param internal - `loader.internal` (Node's ModuleLoader), may be absent.
 * @param packageDir - the bundle's package directory; cache keys under it are evicted.
 * @param requireCache - the CJS module cache (best-effort, may be absent).
 * @returns the number of ESM cache entries evicted.
 */
export function evictBundleModules(internal, packageDir, requireCache) {
  let evicted = 0
  if (!packageDir) return 0
  // Match against both the resolved node_modules path AND its realpath: on
  // Windows, pnpm links cache under the node_modules path (preserved), while
  // a `link:` junction to an external dir caches under the junction target's
  // realpath (resolution follows the junction). Evicting only one form leaves
  // the other version's module cached forever.
  const prefixes = new Set([packageDir.toLowerCase()])
  try {
    prefixes.add(realpathSync(packageDir).toLowerCase())
  } catch { /* dangling or broken link: the plain path prefix still applies */ }
  const matches = (path) => {
    const lower = path.toLowerCase()
    for (const prefix of prefixes) if (lower.startsWith(prefix)) return true
    return false
  }
  if (internal && internal.loadCache && typeof internal.loadCache.keys === 'function') {
    // Use Map.prototype methods on loadCache: Node 24's LoadCache.delete()
    // only nulls the type slot instead of removing the entry.
    for (const url of [...internal.loadCache.keys()]) {
      let path = ''
      try {
        path = fileURLToPath(url)
      } catch {
        continue
      }
      if (matches(path)) {
        Map.prototype.delete.call(internal.loadCache, url)
        evicted += 1
      }
    }
  }
  if (requireCache) {
    for (const key of Object.keys(requireCache)) {
      if (matches(key)) delete requireCache[key]
    }
  }
  return evicted
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

/** The root include entry (`id="include"`, `name="cordis:include"`). */
function findIncludeEntry(loader) {
  if (!loader || typeof loader.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    if (entry && entry.options && entry.options.name === 'cordis:include' && entry.options.id === 'include') return entry
  }
  return undefined
}

/** Ids of rows currently mounted in the include tree (the include subtree when identifiable, else every entry). */
function existingRowIds(loader, includeEntry) {
  const subtree = includeEntry && includeEntry.subtree
  const ids = new Set()
  for (const entry of loader.entries()) {
    if (subtree && entry.parent && entry.parent.tree !== subtree) continue
    if (entry.options && typeof entry.options.id === 'string') ids.add(entry.options.id)
  }
  return ids
}

/**
 * Hot-install one newly added bundle: resolve its package dir, read its
 * dsh.bundle.patch, dedupe its insert rows against the live tree, and append
 * the patch list to the root include entry's config.patches. The include's
 * own patch application re-composes the tree and the loader diff activates
 * the new rows — the same path boot uses, so a restart composes identically.
 * @returns the number of patch entries applied (0 when all rows were already present).
 */
/**
 * Read and parse one installed bundle's patch list (dsh.bundle.patch).
 * @returns the parsed patch list (may be empty).
 */
async function readBundlePatch(profileDir, packageName) {
  const packageDir = resolveBundleDir(profileDir, packageName)
  if (packageDir === undefined) {
    throw new Error(`cannot resolve ${packageName} from ${profileDir} — run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`)
  }
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const declared = manifest && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
  if (declared === undefined) {
    throw new Error(`${packageName} declares no dsh.bundle in its package.json`)
  }
  const patchPath = join(packageDir, declared)
  return parsePatchList(await readFile(patchPath, 'utf8'), patchPath)
}

/**
 * Hot-install one newly added bundle: resolve its package dir, read its
 * dsh.bundle.patch, dedupe its insert rows against the live tree, and append
 * the patch list to the root include entry's config.patches. The include's
 * own patch application re-composes the tree and the loader diff activates
 * the new rows — the same path boot uses, so a restart composes identically.
 * @returns the patch entries actually appended (empty when all rows were
 * already present); these are the exact values hotRemove must remove again.
 */
async function hotInstall(ctx, includeEntry, profileDir, packageName, preParsedPatches) {
  const patches = preParsedPatches ?? (await readBundlePatch(profileDir, packageName))
  if (patches.length === 0) return []
  const fresh = dedupeInserts(patches, existingRowIds(ctx.get('loader'), includeEntry))
  if (fresh.length === 0) return []
  const { patches: previous, ...includeConfig } = includeEntry.options.config
  await includeEntry.update({
    config: {
      ...includeConfig,
      patches: [...(previous ?? []), ...fresh],
    },
  })
  return fresh
}

/**
 * Hot-remove one bundle: strip its recorded patch entries (the exact values
 * hotInstall appended, or the boot-time parse for bundles mounted at boot)
 * out of the root include entry's config.patches. The include re-composes
 * and the loader diff unloads the rows — the mirror image of hotInstall.
 */
async function hotRemove(ctx, includeEntry, packageName, bundlePatches) {
  const { patches: previous, ...includeConfig } = includeEntry.options.config
  const current = previous ?? []
  const next = removePatches(current, bundlePatches)
  if (next.length === current.length) {
    // No recorded rows in the live include config: they are already gone — a
    // patch-layer refresh dropped them, a hand-edit removed them, or a
    // replay/remove race ran this removal after the recompose that unloaded
    // them. Nothing is left to unload, so this is success, not a
    // restart-worthy failure (the previous throw made `dsh plugin remove`
    // report "restart required" for a row that was already unmounted).
    log(ctx, 'info', `${packageName}: rows already gone from the live include config — nothing to unload`)
    return false
  }
  await includeEntry.update({ config: { ...includeConfig, patches: next } })
  return true
}

export async function apply(ctx) {
  const loader = ctx.get('loader')
  const includeEntry = findIncludeEntry(loader)
  if (!includeEntry) {
    log(ctx, 'error', 'root include entry (cordis:include) not found — hot install disabled')
    return
  }
  let profileDir
  try {
    profileDir = dirname(fileURLToPath(includeEntry.options.config.path))
  } catch (error) {
    log(ctx, 'error', `cannot derive the profile directory from the include config: ${String(error)} — hot install disabled`)
    return
  }
  const manifestPath = join(profileDir, 'package.json')

  // Snapshot of the bundle layer at mount time: bundle name -> dependency
  // spec. Only NEW names apply; changed specs reload; vanished names remove.
  let known = new Map()
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const bundle of readBundles(manifest)) {
      known.set(bundle, readDependencySpecs(manifest)[bundle] ?? '')
    }
  } catch (error) {
    log(ctx, 'warn', `cannot read ${manifestPath} at startup (${String(error)}) — starting with an empty bundle snapshot`)
  }

  // bundle name -> the patch entries it contributed to the include config.
  // Built for every bundle present at startup (boot-time rows must be
  // removable too) and extended on every hot install. This mapping is the
  // only durable knowledge that lets a removal know WHICH rows to strip.
  const bundlePatches = new Map()
  for (const packageName of known.keys()) {
    try {
      const patches = await readBundlePatch(profileDir, packageName)
      if (patches.length > 0) bundlePatches.set(packageName, patches)
    } catch (error) {
      log(ctx, 'warn', `cannot index ${packageName} for hot removal (${String(error)})`)
    }
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')

  // Serialize every refresh (HMR invokes the callback serially, and retries
  // join the same chain) so reads and entry updates never interleave.
  let chain = Promise.resolve()
  let retryArmed = false
  const scheduleRetry = () => {
    if (retryArmed) return
    retryArmed = true
    setTimeout(() => {
      retryArmed = false
      enqueueRefresh()
    }, RETRY_MS)
  }
  const enqueueRefresh = () => {
    chain = chain
      .then(() => sleep(SETTLE_MS))
      .then(handleChange)
      .catch((error) => log(ctx, 'error', `unexpected failure: ${String(error)}`))
    return chain
  }
  const enqueueReconcile = () => {
    chain = chain
      .then(reconcileReplay)
      .catch((error) => log(ctx, 'error', `unexpected replay failure: ${String(error)}`))
    return chain
  }

  /** Re-add hot-installed rows the user patch layer's HMR rebuild dropped. */
  async function reconcileReplay() {
    if (bundlePatches.size === 0) return
    const current = (includeEntry.options.config && includeEntry.options.config.patches) ?? []
    const missing = missingPatches(bundlePatches, current)
    if (missing.size === 0) return
    // Respect intentional disabling: rows the patch file disables stay down.
    let disabled = new Set()
    try {
      disabled = disabledIds(parsePatchList(await readFile(patchPath, 'utf8'), patchPath))
    } catch { /* unreadable patch file: replay everything we have */ }
    const toReplay = replayablePatches(missing, disabled)
    if (toReplay.size === 0) return
    const { patches: previous, ...includeConfig } = includeEntry.options.config
    const next = [...(previous ?? [])]
    // Count what is ACTUALLY appended, not what was flagged: rows recorded
    // with `!!js` expressions do not deep-equal their evaluated live form, so
    // they are flagged missing while still mounted — dedupeInserts skips them
    // and the log must not count them as replayed (it previously printed the
    // flag count, e.g. "replayed 3" for one real re-add).
    let appended = 0
    const names = []
    for (const [bundle, entries] of toReplay) {
      const fresh = dedupeInserts(entries, existingRowIds(ctx.get('loader'), includeEntry))
      appended += fresh.length
      if (fresh.length > 0) names.push(bundle)
      next.push(...fresh)
    }
    if (appended === 0) return
    await includeEntry.update({ config: { ...includeConfig, patches: next } })
    log(ctx, 'info', `replayed ${appended} patch entr${appended === 1 ? 'y' : 'ies'} for ${names.join(', ')} lost to a patch-layer refresh`)
  }

  /**
   * Reinstall a bundle at its previous spec via pnpm. Used to roll back an
   * update whose new code failed to load: the old files are gone from
   * node_modules (pnpm replaced them), so only a real reinstall restores
   * them. The manifest write this produces re-triggers the normal update
   * path (to -> from), which reloads the row from the restored files.
   * @returns true when pnpm exited 0.
   */
  function rollbackDependency(packageName, spec) {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const result = spawnSync(pnpm, ['add', `${packageName}@${spec}`], {
      cwd: profileDir,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      timeout: 120000,
    })
    return result.status === 0
  }

  /**
   * Last-resort protection when an update fails AND the rollback fails: the
   * manifest still points at the broken version, so the next boot would fail
   * loud loading it. Removing the bundle from the profile's bundle list keeps
   * dsh bootable (the package stays in dependencies); the plugin is simply
   * not mounted until the user re-adds it at a working spec. The manifest
   * write re-enters the normal change path, which unloads the row if it is
   * still mounted.
   */
  async function emergencyUnmount(packageName, from) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      log(ctx, 'error', `restart required for ${packageName}: cannot read ${manifestPath} to unload it (${String(error)})`)
      return
    }
    const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
      log(ctx, 'error', `restart required for ${packageName}: rollback to ${from} failed and it is not in the bundle list`)
      return
    }
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== packageName)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    log(ctx, 'error', `rollback to ${from} failed — removed ${packageName} from the profile bundle list so dsh stays bootable; re-add it with 'dsh plugin --profile ${basename(profileDir)} add ${packageName}@${from}' after fixing the registry issue`)
  }

  /** Version-spec change: drop the row and re-add it with the bundle's modules evicted from the ESM/CJS caches, so the loader re-imports the NEW code. */
  async function hotReload(packageName, from, to) {
    // Pre-flight: parse the NEW package's patch list BEFORE touching the live
    // row. If the new patch cannot be resolved or parsed, the old row stays
    // mounted untouched and the caller logs restart-required — the failure
    // must never cost the user a working plugin.
    const nextPatches = await readBundlePatch(profileDir, packageName)
    // Evict the bundle's modules BEFORE re-adding the row: the loader imports
    // by URL, so without eviction the re-added row would keep running the OLD
    // module forever (verified live — pre-0.4.6 "hot-reloaded" logs lied
    // about the code actually changing).
    const packageDir = resolveBundleDir(profileDir, packageName)
    if (packageDir) {
      const evicted = evictBundleModules(loader && loader.internal, packageDir, createRequire(join(profileDir, 'package.json')).cache)
      if (evicted > 0) log(ctx, 'info', `evicted ${evicted} cached module${evicted === 1 ? '' : 's'} for ${packageName} (${from} -> ${to})`)
    }
    const patches = bundlePatches.get(packageName)
    if (patches !== undefined && patches.length > 0) {
      await hotRemove(ctx, includeEntry, packageName, patches)
      bundlePatches.delete(packageName)
    }
    const applied = await hotInstall(ctx, includeEntry, profileDir, packageName, nextPatches)
    if (applied.length > 0) {
      bundlePatches.set(packageName, applied)
      log(ctx, 'info', `hot-reloaded ${packageName} (${from} -> ${to}, ${applied.length} patch entr${applied.length === 1 ? 'y' : 'ies'})`)
    } else {
      log(ctx, 'info', `${packageName}: update applied, all rows already present`)
    }
  }

  async function handleChange() {
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      log(ctx, 'warn', `${manifestPath}: unreadable or torn JSON (${String(error)}) — retrying in ${RETRY_MS}ms`)
      scheduleRetry()
      return
    }
    const specs = readDependencySpecs(manifest)
    const current = new Map()
    for (const bundle of readBundles(manifest)) current.set(bundle, specs[bundle] ?? '')
    const added = diffBundles([...known.keys()], [...current.keys()])
    const removed = diffBundles([...current.keys()], [...known.keys()])
    const updated = diffSpecs(known, current)
    if (added.length === 0 && removed.length === 0 && updated.length === 0) {
      known = current
      return
    }
    if (removed.length > 0) {
      log(ctx, 'info', `manifest change: removed bundle(s) ${removed.join(', ')}`)
      for (const packageName of removed) {
        known.delete(packageName)
        const patches = bundlePatches.get(packageName)
        if (patches === undefined || patches.length === 0) {
          bundlePatches.delete(packageName)
          log(ctx, 'warn', `${packageName}: no recorded rows to remove — already clean`)
          continue
        }
        try {
          const unloaded = await hotRemove(ctx, includeEntry, packageName, patches)
          bundlePatches.delete(packageName)
          if (unloaded) {
            log(ctx, 'info', `hot-removed ${packageName} (${patches.length} patch entr${patches.length === 1 ? 'y' : 'ies'})`)
          }
        } catch (error) {
          // Keep the mapping: a later manifest write retries the removal.
          log(ctx, 'error', `restart required for ${packageName}: ${String(error)}`)
        }
      }
    }
    for (const update of updated) {
      // A failed reload rolls the dependency back to its previous spec so the
      // plugin keeps working on the old code: the new files are already on
      // disk (pnpm replaced them), so only a real reinstall restores the old
      // ones. The rollback's own manifest write re-enters the update path
      // (to -> from), which reloads the row from the restored files.
      try {
        await hotReload(update.name, update.from, update.to)
      } catch (error) {
        log(ctx, 'error', `update failed for ${update.name} (${update.from} -> ${update.to}): ${String(error)} — rolling back to ${update.from}`)
        try {
          const ok = rollbackDependency(update.name, update.from)
          if (!ok) {
            await emergencyUnmount(update.name, update.from)
          } else {
            // pnpm can exit 0 without restoring a usable package (e.g. a
            // dangling link: spec). Verify before declaring victory — an
            // unverified "success" would re-trigger the update and loop
            // forever between the two specs.
            try {
              await readBundlePatch(profileDir, update.name)
              log(ctx, 'info', `rolled back ${update.name} to ${update.from} — reloading from the manifest`)
            } catch (verifyError) {
              log(ctx, 'error', `rollback of ${update.name} to ${update.from} did not restore a usable package (${String(verifyError)})`)
              await emergencyUnmount(update.name, update.from)
            }
          }
        } catch (rollbackError) {
          log(ctx, 'error', `restart required for ${update.name}: rollback failed (${String(rollbackError)})`)
          await emergencyUnmount(update.name, update.from)
        }
      }
    }
    for (const packageName of added) {
      // Recorded either way: a successful apply must not re-run, and a failed
      // one is logged as restart-required (retrying every write would only
      // spam the log; boot composes it correctly).
      known.set(packageName, current.get(packageName) ?? '')
      try {
        const applied = await hotInstall(ctx, includeEntry, profileDir, packageName)
        if (applied.length > 0) {
          bundlePatches.set(packageName, applied)
          log(ctx, 'info', `hot-applied ${packageName} (${applied.length} patch entr${applied.length === 1 ? 'y' : 'ies'})`)
        } else {
          log(ctx, 'info', `${packageName}: all rows already present — nothing to apply`)
        }
      } catch (error) {
        log(ctx, 'error', `restart required for ${packageName}: ${String(error)}`)
      }
    }
    known = current
  }

  // The HMR service is created after boot (profile-boot mounts it post-boot
  // on long-lived surfaces). Wait for it in a child fiber instead of a
  // plugin-level inject: this entry must activate immediately or boot fails
  // loud, and a surface without HMR simply never starts the watcher.
  ctx.inject(['hmr'], async function startHotInstall(hmrCtx) {
    try {
      // The callback must NOT return the refresh chain: the HMR service awaits
      // the callback and keeps its refresh task "running" while it is pending.
      // If the chain ever waits on an include update that unloads this very
      // entry (a self-update via `dsh plugin add dsh-hot-installer@latest`),
      // entry disposal runs our disposer, which calls the HMR disposer, which
      // awaits the still-running refresh task — a circular wait that leaves
      // the watcher permanently deaf and the row half-unloaded. Returning
      // immediately (void) keeps the HMR task short; the chain still
      // serializes every refresh by itself.
      const disposer = await hmrCtx.hmr.registerConfig(manifestPath, () => void enqueueRefresh())
      // Close the exact-path watcher when this fiber dies (a stale registration
      // would keep invoking a dead closure after a tree reload).
      hmrCtx.effect(() => () => disposer())
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.startsWith('config path already registered')) {
        log(ctx, 'warn', `${manifestPath} is already watched by a previous instance — hot install unavailable in this session`)
      } else {
        log(ctx, 'error', `failed to watch ${manifestPath}: ${String(error)} — hot install disabled (restart required)`)
      }
      return
    }
    // Periodic reconciliation: the user patch layer's HMR rebuild can drop
    // hot-installed rows; bring them back unless intentionally disabled.
    const replayTimer = setInterval(() => void enqueueReconcile(), REPLAY_INTERVAL_MS)
    ctx.effect(() => () => clearInterval(replayTimer))
    log(ctx, 'info', `active — watching ${manifestPath} for new/removed/updated profile bundles (hot install/remove/reload enabled${OWN_VERSION ? `, v${OWN_VERSION}` : ''})`)
  })
}
