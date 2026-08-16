// Smoke tests for the pure helpers of dsh-hot-installer (no dsh runtime needed).
// Run: node --test test/smoke.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBundles, diffBundles, resolveBundleDir, parsePatchList, dedupeInserts } from '../index.mjs'

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
