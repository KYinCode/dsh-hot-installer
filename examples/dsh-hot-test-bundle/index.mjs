// dsh-hot-test-bundle: throwaway bundle used to verify dsh-hot-installer.
// On mount it appends an activation marker to its plugin log — if that line
// appears without a dsh restart, the hot install worked.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-hot-test-bundle'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const LOG_FILE = join(DSH_HOME, 'logs', 'dsh-hot-test-bundle', 'dsh-hot-test-bundle.log')

export function apply(ctx) {
  const line = `[${new Date().toISOString()}] [info] plugin active (hot-installed at runtime)\n`
  mkdir(dirname(LOG_FILE), { recursive: true })
    .then(() => appendFile(LOG_FILE, line))
    .catch(() => {})
  try {
    if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('dsh-hot-test-bundle: plugin active')
  } catch { /* logger absence is not fatal */ }
}
