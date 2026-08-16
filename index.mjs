// dsh-hot-installer — hot-install profile bundles without restarting dsh.
//
// Problem: `dsh plugin --profile <name> add <pkg>` installs a bundle, but the
// new bundle only mounts after restarting dsh — dsh.profile.bundles is
// composed at boot and nothing watches it (HMR only watches the user patch
// files). Installing packages is the one cold path in an otherwise hot tree.
//
// Fix: this plugin watches the profile manifest (<profile>/package.json)
// through the same HMR config registration app-boot uses for cordis.patch.yml
// (`hmr.registerConfig`). When a NEW bundle name appears in
// dsh.profile.bundles, it resolves the installed package, reads its
// dsh.bundle.patch (cordis.patch.yml), and appends the parsed patch list to
// the root include entry's config.patches — the exact hot-application entry
// watchUserPatches drives. The loader diff then activates the new rows live
// (PoC measured ~8 ms; no restart, no HMR wait).
//
// v1: add-only. Removals (`dsh plugin remove`) keep their rows mounted until
// restart — removal needs a bundle→row mapping and is v2 work.
//
// Mounting: install once as a profile bundle (see package.json
// dsh.bundle.patch and cordis.patch.yml), restart once. From then on, every
// `dsh plugin add <pkg>` is hot.

import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

export const name = 'dsh-hot-installer'
// The HMR service appears only after boot on long-lived surfaces (profile-boot
// creates it post-boot). Waiting on it guarantees the loader is settled and
// the root include entry exists when apply runs.
export const inject = ['hmr']

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
async function hotInstall(ctx, includeEntry, profileDir, packageName) {
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
  const patches = parsePatchList(await readFile(patchPath, 'utf8'), patchPath)
  if (patches.length === 0) return 0
  const fresh = dedupeInserts(patches, existingRowIds(ctx.get('loader'), includeEntry))
  if (fresh.length === 0) return 0
  const { patches: previous, ...includeConfig } = includeEntry.options.config
  await includeEntry.update({
    config: {
      ...includeConfig,
      patches: [...(previous ?? []), ...fresh],
    },
  })
  return fresh.length
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
    if (added.length === 0) {
      snapshot = current
      return
    }
    log(ctx, 'info', `manifest change: new bundle(s) ${added.join(', ')}`)
    for (const packageName of added) {
      // Recorded either way: a successful apply must not re-run, and a failed
      // one is logged as restart-required (retrying every write would only
      // spam the log; boot composes it correctly).
      snapshot = [...snapshot, packageName]
      try {
        const applied = await hotInstall(ctx, includeEntry, profileDir, packageName)
        if (applied > 0) log(ctx, 'info', `hot-applied ${packageName} (${applied} patch entr${applied === 1 ? 'y' : 'ies'})`)
        else log(ctx, 'info', `${packageName}: all rows already present — nothing to apply`)
      } catch (error) {
        log(ctx, 'error', `restart required for ${packageName}: ${String(error)}`)
      }
    }
  }

  try {
    const disposer = await ctx.hmr.registerConfig(manifestPath, () => enqueueRefresh())
    // Close the exact-path watcher when this fiber dies (a stale registration
    // would keep invoking a dead closure after a tree reload).
    ctx.effect(() => () => disposer())
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.startsWith('config path already registered')) {
      log(ctx, 'warn', `${manifestPath} is already watched by a previous instance — hot install unavailable in this session`)
    } else {
      log(ctx, 'error', `failed to watch ${manifestPath}: ${String(error)} — hot install disabled (restart required)`)
    }
    return
  }

  log(ctx, 'info', `active — watching ${manifestPath} for new profile bundles (hot install enabled)`)
}
