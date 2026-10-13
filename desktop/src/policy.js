// @ts-check
// The content policy the interface is served with. Pure: no Electron here, so it
// is tested with plain Node.

import { createHash } from 'node:crypto'

/**
 * The interface loads nothing from anywhere but its own files, and talks to
 * nothing but the shell.
 *
 * What it is allowed beyond its own files is what drawing a tile takes. The
 * tile library draws each face in a worker, and without any one of these every
 * tile falls back to its name in text — with nothing else looking wrong:
 * - `worker-src blob:` — the worker is started from a `blob:` URL;
 * - `'unsafe-eval'` — the worker's bundled generator runtime installs itself
 *   with `Function(…)`. A worker made from a blob runs under the page's
 *   policy, so the allowance cannot be given to the worker alone;
 * - `img-src data:` — the finished face comes back as a `data:` image.
 *
 * `'unsafe-eval'` lets code that is already running evaluate a string; it does
 * not let anything in. Scripts still come only from the interface's own files:
 * no inline script but the ones named by hash, and no other origin.
 */
const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

/**
 * The policy for one page of the interface: the one above, and the scripts
 * written into that page itself, each allowed by its hash.
 * @param {string} html
 * @returns {string}
 */
export function policyFor(html) {
  const written = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, script]) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`)
  return POLICY.map(part => part.startsWith('script-src ') ? [part, ...written].join(' ') : part).join('; ')
}
