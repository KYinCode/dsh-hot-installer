// dsh-hot-installer — hot-install and hot-remove profile bundles without
// restarting dsh.
//
// Problem: `dsh plugin --profile <name> add <pkg>` installs a bundle, but the
// bundle only mounts after restarting dsh — dsh.profile.bundles is composed
// at boot and nothing watches it (HMR only watches the user patch files).
// Installing and removing packages are the cold paths in an otherwise hot
// tree, and a removed bundle whose row stays mounted breaks the next page
// load (the client bundle 404s).
//
// Fix: this plugin watches the profile manifest (<profile>/package.json)
// through the same HMR config registration app-boot uses for cordis.patch.yml
// (`hmr.registerConfig`). When a NEW bundle name appears in
// dsh.profile.bundles, it resolves the installed package, reads its
// dsh.bundle.patch (cordis.patch.yml), and appends the parsed patch list to
// the root include entry's config.patches — the loader diff activates the
// rows live (PoC measured ~8 ms). When a bundle name DISAPPEARS, the
// recorded patch entries are stripped out of the same config.patches and the
// loader diff unloads the rows — so `dsh plugin remove` takes effect live
// too, and the page never 404s on a vanished client bundle.
//
// The bundle→rows mapping is built at startup for every bundle already in
// the manifest (boot-time rows are removable too) and extended on every hot
// install. It lives in memory only: a restart rebuilds it from the manifest,
// and a restart was always the fallback for anything this plugin cannot
// reconcile.
//
// Mounting: install once as a profile bundle (see package.json
// dsh.bundle.patch and cordis.patch.yml), restart once. From then on, every
// `dsh plugin add` / `dsh plugin remove` is hot.

import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

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
async function hotInstall(ctx, includeEntry, profileDir, packageName) {
  const patches = await readBundlePatch(profileDir, packageName)
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
    throw new Error('no matching rows found in the live include config')
  }
  await includeEntry.update({ config: { ...includeConfig, patches: next } })
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

  // Snapshot of the bundle layer at mount time; only NEW bundle names apply.
  let snapshot = []
  try {
    snapshot = readBundles(JSON.parse(await readFile(manifestPath, 'utf8')))
  } catch (error) {
    log(ctx, 'warn', `cannot read ${manifestPath} at startup (${String(error)}) — starting with an empty bundle snapshot`)
  }

  // bundle name -> the patch entries it contributed to the include config.
  // Built for every bundle present at startup (boot-time rows must be
  // removable too) and extended on every hot install. This mapping is the
  // only durable knowledge that lets a removal know WHICH rows to strip.
  const bundlePatches = new Map()
  for (const packageName of snapshot) {
    try {
      const patches = await readBundlePatch(profileDir, packageName)
      if (patches.length > 0) bundlePatches.set(packageName, patches)
    } catch (error) {
      log(ctx, 'warn', `cannot index ${packageName} for hot removal (${String(error)})`)
    }
  }

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

  async function handleChange() {
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      log(ctx, 'warn', `${manifestPath}: unreadable or torn JSON (${String(error)}) — retrying in ${RETRY_MS}ms`)
      scheduleRetry()
      return
    }
    const current = readBundles(manifest)
    const added = diffBundles(snapshot, current)
    const removed = diffBundles(current, snapshot)
    if (added.length === 0 && removed.length === 0) {
      snapshot = current
      return
    }
    if (removed.length > 0) {
      log(ctx, 'info', `manifest change: removed bundle(s) ${removed.join(', ')}`)
      for (const packageName of removed) {
        snapshot = snapshot.filter((name) => name !== packageName)
        const patches = bundlePatches.get(packageName)
        if (patches === undefined || patches.length === 0) {
          bundlePatches.delete(packageName)
          log(ctx, 'warn', `${packageName}: no recorded rows to remove — already clean`)
          continue
        }
        try {
          await hotRemove(ctx, includeEntry, packageName, patches)
          bundlePatches.delete(packageName)
          log(ctx, 'info', `hot-removed ${packageName} (${patches.length} patch entr${patches.length === 1 ? 'y' : 'ies'})`)
        } catch (error) {
          // Keep the mapping: a later manifest write retries the removal.
          log(ctx, 'error', `restart required for ${packageName}: ${String(error)}`)
        }
      }
    }
    for (const packageName of added) {
      // Recorded either way: a successful apply must not re-run, and a failed
      // one is logged as restart-required (retrying every write would only
      // spam the log; boot composes it correctly).
      snapshot = [...snapshot, packageName]
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
  }

  // The HMR service is created after boot (profile-boot mounts it post-boot
  // on long-lived surfaces). Wait for it in a child fiber instead of a
  // plugin-level inject: this entry must activate immediately or boot fails
  // loud, and a surface without HMR simply never starts the watcher.
  ctx.inject(['hmr'], async function startHotInstall(hmrCtx) {
    try {
      const disposer = await hmrCtx.hmr.registerConfig(manifestPath, () => enqueueRefresh())
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
    log(ctx, 'info', `active — watching ${manifestPath} for new/removed profile bundles (hot install/remove enabled)`)
  })
}
