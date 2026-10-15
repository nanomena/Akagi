// @ts-check
// A folder of the user's own pages, served beside the stream: overlays and a
// control page for the streaming program, and what they play or show (music,
// pictures, fonts). The folder is the user's; this only hands out its files,
// read-only, and nothing outside it. A name with `..`, a hidden name (one that
// starts with a dot) or anything else a path could escape with is a 404.
// Links inside the folder (a junction to a music library, say) are followed:
// the folder's owner put them there.

import fs from 'node:fs'
import path from 'node:path'

/**
 * What a page from the folder may load: its own files, and a WebSocket to a
 * program on this computer (a streaming program's remote control). Nothing
 * from anywhere else.
 */
export const PAGES_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.m3u8': 'audio/x-mpegurl; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
})

/**
 * Where a request's path leads in the folder, or null if it may not lead anywhere.
 * @param {string} root the folder
 * @param {string[]} segments the path's parts after the folder's own name, still URL-encoded; a last empty part is a trailing slash
 * @returns {{ file: string, folder: boolean } | null} `folder`: the path ended in a slash
 */
export function placeOf(root, segments) {
  const folder = segments.length === 0 || segments.at(-1) === ''
  const parts = folder ? segments.slice(0, -1) : segments
  /** @type {string[]} */
  const names = []
  for (const part of parts) {
    let name
    try { name = decodeURIComponent(part) } catch { return null }
    // Each part is one plain name: no way up, out, across drives or into a stream of a file.
    if (!name || name.startsWith('.') || /[\\/:\0]/.test(name)) return null
    names.push(name)
  }
  const file = path.join(root, ...names)
  const inside = path.relative(root, file)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null
  return { file, folder }
}

/**
 * The byte range a `Range` header asks for, if it asks for one this can give.
 * @param {string | undefined} header @param {number} size
 * @returns {{ start: number, end: number } | 'whole' | 'unsatisfiable'}
 */
export function rangeOf(header, size) {
  if (!header) return 'whole'
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // Several ranges, or another unit: the whole file is a fine answer to either.
  if (!asked || (!asked[1] && !asked[2])) return 'whole'
  let start, end
  if (!asked[1]) {
    // The last so many bytes.
    start = Math.max(0, size - Number(asked[2]))
    end = size - 1
  } else {
    start = Number(asked[1])
    end = asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Answer a request for a file in the folder.
 * @param {string} root the folder
 * @param {string[]} segments as for `placeOf`
 * @param {string} base the address of the folder itself, ending in a slash, for redirects
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export async function servePage(root, segments, base, request, response) {
  const refuse = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...headers }).end()
  }
  const place = placeOf(root, segments)
  if (!place) return refuse(404)
  let file = place.file
  let stat
  try {
    stat = await fs.promises.stat(file)
    if (stat.isDirectory()) {
      // A folder is its index page, read as a folder so that its own files are named relative to it.
      if (!place.folder) return refuse(308, { Location: `${base}${segments.join('/')}/` })
      file = path.join(file, 'index.html')
      stat = await fs.promises.stat(file)
    } else if (place.folder) {
      return refuse(404)
    }
    if (!stat.isFile()) return refuse(404)
  } catch {
    return refuse(404)
  }

  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const range = rangeOf(request.headers.range, stat.size)
  if (range === 'unsatisfiable') return refuse(416, { 'Content-Range': `bytes */${stat.size}` })
  const { start, end } = range === 'whole' ? { start: 0, end: stat.size - 1 } : range
  /** @type {Record<string, string | number>} */
  const headers = {
    'Content-Type': type,
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGES_POLICY
  if (range !== 'whole') headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
  response.writeHead(range === 'whole' ? 200 : 206, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const read = fs.createReadStream(file, { start, end })
  read.on('error', () => response.destroy())
  response.on('close', () => read.destroy())
  read.pipe(response)
}
