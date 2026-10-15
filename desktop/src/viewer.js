// @ts-check
// The stream's page, for a streaming program's browser source: the game's
// frames, filling the page at their own ratio. It reads the Motion JPEG stream
// beside it itself rather than through an <img>, so that it can tell when the
// stream has ended — the application closed or restarted — and pick it up
// again, keeping the last frame on screen meanwhile.

const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas'))
const draw = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
const BREAK = new Uint8Array([13, 10, 13, 10])

/** @type {Uint8Array | null} the newest frame not yet drawn */
let waiting = null
let drawing = false

/** Draw the newest frame; frames that come while one is decoded are skipped but the last. */
function show(/** @type {Uint8Array} */ jpeg) {
  waiting = jpeg
  if (drawing) return
  drawing = true
  const next = waiting
  waiting = null
  createImageBitmap(new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (next)], { type: 'image/jpeg' }))
    .then(bitmap => {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      draw.drawImage(bitmap, 0, 0)
      bitmap.close()
    })
    .catch(() => { /* a frame that does not decode is skipped */ })
    .finally(() => {
      drawing = false
      if (waiting) show(waiting)
    })
}

/** @param {Uint8Array} bytes @param {Uint8Array} what @returns {number} */
function find(bytes, what) {
  outer: for (let i = 0; i + what.length <= bytes.length; i++) {
    for (let j = 0; j < what.length; j++) if (bytes[i + j] !== what[j]) continue outer
    return i
  }
  return -1
}

/** Read the stream until it ends. Each part is a few header lines and a JPEG of the length they give. */
async function watch() {
  const response = await fetch('stream.mjpg', { cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error(`stream: ${response.status}`)
  const reader = response.body.getReader()
  let buffer = new Uint8Array(0)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    const joined = new Uint8Array(buffer.length + value.length)
    joined.set(buffer)
    joined.set(value, buffer.length)
    buffer = joined
    for (;;) {
      const end = find(buffer, BREAK)
      if (end < 0) break
      const headers = new TextDecoder().decode(buffer.subarray(0, end))
      const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1])
      if (!Number.isFinite(length)) { buffer = buffer.slice(end + BREAK.length); continue }
      if (buffer.length < end + BREAK.length + length) break
      show(buffer.slice(end + BREAK.length, end + BREAK.length + length))
      buffer = buffer.slice(end + BREAK.length + length)
    }
  }
}

async function run() {
  for (;;) {
    try { await watch() } catch { /* not there yet, or gone: try again */ }
    await new Promise(done => setTimeout(done, 1000))
  }
}

void run()
