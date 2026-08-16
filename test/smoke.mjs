// Smoke tests for the pure helpers of dsh-hot-installer (no dsh runtime needed).
// Run: node --test test/smoke.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBundles, diffBundles, resolveBundleDir, parsePatchList, dedupeInserts, deepEqual, removePatches, readDependencySpecs, diffSpecs, missingPatches, disabledIds, replayablePatches } from '../index.mjs'

test('readBundles: reads the bundle layer, tolerates missing shapes', () => {
  assert.deepEqual(readBundles({ dsh: { profile: { bundles: ['a', 'b'] } } }), ['a', 'b'])
  assert.deepEqual(readBundles({}), [])
  assert.deepEqual(readBundles({ dsh: {} }), [])
  assert.deepEqual(readBundles({ dsh: { profile: {} } }), [])
  assert.deepEqual(readBundles(undefined), [])
  // the returned array is detached
  const out = readBundles({ dsh: { profile: { bundles: ['a'] } } })
  out.push('x')
  assert.deepEqual(readBundles({ dsh: { profile: { bundles: ['a'] } } }), ['a'])
})

test('diffBundles: reports only newly added names, in order', () => {
  assert.deepEqual(diffBundles(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd'])
  assert.deepEqual(diffBundles(['a'], ['a']), [])
  assert.deepEqual(diffBundles([], ['x']), ['x'])
  // removals and reorderings are not "adds" in v1
  assert.deepEqual(diffBundles(['a', 'b'], ['b']), [])
})

test('resolveBundleDir: finds a package through the profile node_modules lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hot-installer-'))
  try {
    const pkgDir = join(root, 'node_modules', 'fake-bundle')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), '{"name":"fake-bundle"}')
    await writeFile(join(root, 'package.json'), '{"name":"profile"}')
    assert.equal(resolveBundleDir(root, 'fake-bundle'), pkgDir)
    assert.equal(resolveBundleDir(root, 'missing-bundle'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePatchList: accepts the entry-list dialect, rejects invalid files', () => {
  const good = [
    '- insert:',
    '    - id: demo',
    "      name: 'demo-pkg'",
    '- id: existing-row',
    '  disabled: !!js "process.env.NODE_ENV === \'test\'"',
  ].join('\n')
  const patches = parsePatchList(good, 'cordis.patch.yml')
  assert.equal(patches.length, 2)
  assert.deepEqual(patches[0].insert[0], { id: 'demo', name: 'demo-pkg' })
  assert.equal(patches[1].disabled.__jsExpr, "process.env.NODE_ENV === 'test'")

  assert.throws(() => parsePatchList('not: [an, array]', 'x.yml'), /top-level YAML array/)
  assert.throws(() => parsePatchList('- "just a string"', 'x.yml'), /must be a mapping/)
  assert.throws(() => parsePatchList('{ broken', 'x.yml'), /failed to parse/)
})

test('dedupeInserts: skips colliding row ids, keeps the rest verbatim', () => {
  const existing = new Set(['taken'])
  const patches = [
    { insert: [{ id: 'taken', name: 'a' }, { id: 'fresh', name: 'b' }] },
    { insert: [{ id: 'taken', name: 'c' }] },
    { id: 'taken', config: { x: 1 } }, // id-targeted: merge case, kept
  ]
  const out = dedupeInserts(patches, existing)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { insert: [{ id: 'fresh', name: 'b' }] })
  assert.deepEqual(out[1], { id: 'taken', config: { x: 1 } })
  // rows without an id are never deduped
  const noId = dedupeInserts([{ insert: [{ name: 'x' }] }], existing)
  assert.deepEqual(noId, [{ insert: [{ name: 'x' }] }])
})

test('deepEqual: structural equality for loader patch values', () => {
  assert.equal(deepEqual({ id: 'a', name: 'b' }, { id: 'a', name: 'b' }), true)
  assert.equal(deepEqual({ id: 'a' }, { id: 'a', name: 'b' }), false)
  assert.equal(deepEqual({ insert: [{ id: 'x' }] }, { insert: [{ id: 'x' }] }), true)
  assert.equal(deepEqual({ disabled: { __jsExpr: 'a' } }, { disabled: { __jsExpr: 'a' } }), true)
  assert.equal(deepEqual({ disabled: { __jsExpr: 'a' } }, { disabled: { __jsExpr: 'b' } }), false)
  assert.equal(deepEqual([1, 2], [1, 2]), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
  assert.equal(deepEqual(null, null), true)
  assert.equal(deepEqual(undefined, undefined), true)
  assert.equal(deepEqual({ a: undefined }, { b: undefined }), false)
})

test('removePatches: strips a bundle\'s rows once each, leaves the rest', () => {
  const include = [
    { insert: [{ id: 'a', name: 'pkg-a' }] },
    { insert: [{ id: 'b', name: 'pkg-b' }] },
    { id: 'shared', config: { x: 1 } },
    { insert: [{ id: 'c', name: 'pkg-c' }] },
  ]
  // removing bundle B strips exactly its entry
  const out = removePatches(include, [{ insert: [{ id: 'b', name: 'pkg-b' }] }])
  assert.deepEqual(out, [
    { insert: [{ id: 'a', name: 'pkg-a' }] },
    { id: 'shared', config: { x: 1 } },
    { insert: [{ id: 'c', name: 'pkg-c' }] },
  ])
  // entries not present are ignored (no throw, no removal)
  assert.deepEqual(removePatches(include, [{ insert: [{ id: 'nope' }] }]), include)
  // duplicates: each recorded entry removes at most one occurrence
  const dup = removePatches(
    [{ insert: [{ id: 'x' }] }, { insert: [{ id: 'x' }] }],
    [{ insert: [{ id: 'x' }] }, { insert: [{ id: 'x' }] }],
  )
  assert.deepEqual(dup, [])
  // the input list is never mutated
  assert.equal(include.length, 4)
})

test('readDependencySpecs: reads the dependency map, tolerates missing shapes', () => {
  assert.deepEqual(readDependencySpecs({ dependencies: { a: '^1.0.0', b: '0.2.0' } }), { a: '^1.0.0', b: '0.2.0' })
  assert.deepEqual(readDependencySpecs({}), {})
  assert.deepEqual(readDependencySpecs(undefined), {})
})

test('diffSpecs: reports only spec changes among shared names', () => {
  const known = new Map([['a', '^1.0.0'], ['b', '0.2.0']])
  const current = new Map([['a', '^1.0.0'], ['b', '0.3.0'], ['c', '^0.1.0']])
  assert.deepEqual(diffSpecs(known, current), [{ name: 'b', from: '0.2.0', to: '0.3.0' }])
  assert.deepEqual(diffSpecs(known, known), [])
})

test('missingPatches: finds recorded rows the live config lost', () => {
  const mapping = new Map([
    ['pkg-a', [{ insert: [{ id: 'a', name: 'pkg-a' }] }]],
    ['pkg-b', [{ insert: [{ id: 'b', name: 'pkg-b' }] }]],
  ])
  // everything present -> nothing missing
  assert.equal(missingPatches(mapping, [{ insert: [{ id: 'a', name: 'pkg-a' }] }, { insert: [{ id: 'b', name: 'pkg-b' }] }]).size, 0)
  // config dropped pkg-a's row (a patch-layer rebuild) -> missing
  const missing = missingPatches(mapping, [{ insert: [{ id: 'b', name: 'pkg-b' }] }])
  assert.deepEqual([...missing.keys()], ['pkg-a'])
  // empty config -> everything missing
  assert.equal(missingPatches(mapping, []).size, 2)
  assert.equal(missingPatches(mapping, undefined).size, 2)
})

test('replayablePatches: skips rows the patch file disables', () => {
  const missing = new Map([
    ['pkg-a', [{ insert: [{ id: 'a', name: 'pkg-a' }] }]],
    ['pkg-b', [{ insert: [{ id: 'b1', name: 'pkg-b' }, { id: 'b2', name: 'pkg-b' }] }]],
  ])
  const disabled = new Set(['b2'])
  const replay = replayablePatches(missing, disabled)
  // pkg-a fully replayable; pkg-b only the non-disabled row
  assert.deepEqual([...replay.keys()].sort(), ['pkg-a', 'pkg-b'])
  assert.deepEqual(replay.get('pkg-b'), [{ insert: [{ id: 'b1', name: 'pkg-b' }] }])
  // all rows disabled -> nothing replayable
  assert.equal(replayablePatches(missing, new Set(['a', 'b1', 'b2'])).size, 0)
  // id-targeted entries survive unless their target is disabled
  const withConfig = new Map([['pkg-c', [{ id: 'c', config: { x: 1 } }]]])
  assert.equal(replayablePatches(withConfig, new Set(['other'])).get('pkg-c').length, 1)
  assert.equal(replayablePatches(withConfig, new Set(['c'])).size, 0)
})

test('disabledIds: reads explicit disabled markers from a parsed patch list', () => {
  const patches = parsePatchList([
    '- id: a',
    '  disabled: true',
    '- id: b',
    '  disabled: !!js "process.env.X"',
    '- id: c',
  ].join('\n'), 'cordis.patch.yml')
  const ids = disabledIds(patches)
  assert.deepEqual([...ids], ['a'])
})
