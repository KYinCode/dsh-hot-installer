// Probe: does node:module import() (the same machinery the dsh loader's
// internal.import uses) return a CACHED module when the same URL is imported
// again after the file changed? And does a URL query bump force a reload?
import { writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const modFile = new URL('./_probe-mod.mjs', import.meta.url)
const parent = pathToFileURL(process.cwd() + '/').href

try {
  writeFileSync(modFile, 'export const v = "A"\n')
  const m1 = await import(modFile.href)
  console.log('1st import (file has A):', m1.v)

  writeFileSync(modFile, 'export const v = "B"\n')
  const m2 = await import(modFile.href)
  console.log('2nd import, SAME url (file now has B):', m2.v)

  writeFileSync(modFile, 'export const v = "C"\n')
  const m3 = await import(modFile.href + '?t=3')
  console.log('3rd import, BUMPED url (file now has C):', m3.v)
} finally {
  try { unlinkSync(fileURLToPath(modFile)) } catch {}
}
