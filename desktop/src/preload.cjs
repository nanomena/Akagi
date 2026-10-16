// The whole of what the interface can reach of the shell: commands by name,
// events by name, and — with the game drawn offscreen — the game's frames,
// which come here and go to the video on the page's stage, and the user's
// hand on that video, which goes back. Sandboxed preload scripts are CommonJS
// and see only `electron`.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron')

/** @type {Map<string, Set<(payload: unknown) => void>>} */
const listeners = new Map()
ipcRenderer.on('akagi:event', (_event, name, payload) => {
  for (const listener of listeners.get(name) ?? []) listener(payload)
})

/** The element the page shows the game's frames in. */
const VIDEO_ID = 'akagi-game-view'
/** @type {HTMLVideoElement | null} */
let video = null
/** @type {WritableStreamDefaultWriter<VideoFrame> | null} */
let writer = null
/** Frames received, and dropped because the video was behind. */
const counts = { received: 0, dropped: 0 }

/**
 * Where frames go: a track made of them, playing in the page's video. Made
 * again whenever the page has drawn a new video element; nowhere while it has
 * none. (`MediaStreamTrackGenerator` is Chromium's, and not in the DOM types.)
 * @returns {WritableStreamDefaultWriter<VideoFrame> | null}
 */
function sink() {
  const element = document.getElementById(VIDEO_ID)
  if (!(element instanceof HTMLVideoElement)) return null
  if (element !== video || !writer) {
    void writer?.close().catch(() => {})
    const generator = new (/** @type {any} */ (globalThis).MediaStreamTrackGenerator)({ kind: 'video' })
    writer = generator.writable.getWriter()
    element.srcObject = new MediaStream([generator])
    void element.play().catch(() => {})
    video = element
  }
  return writer
}

// A frame is lent: it goes back to the game once the video has drawn it, and
// is dropped rather than queued when the video is behind.
sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture: imported }) => {
  try {
    const out = sink()
    const frame = imported.getVideoFrame()
    counts.received++
    if (out && (out.desiredSize ?? 0) > 0) void out.write(frame).catch(() => frame.close())
    else {
      counts.dropped++
      frame.close()
    }
  } finally {
    imported.release()
  }
})

contextBridge.exposeInMainWorld('akagi', {
  /**
   * Rejects with the message itself, the way the interface shows it.
   * @param {string} command
   * @param {Record<string, unknown>} [args]
   */
  async invoke(command, args) {
    const reply = await ipcRenderer.invoke('akagi:invoke', command, args ?? {})
    if (reply.ok) return reply.value
    throw reply.error
  },
  /**
   * @param {string} name
   * @param {(payload: unknown) => void} listener
   * @returns {() => void} stop listening
   */
  listen(name, listener) {
    const named = listeners.get(name) ?? new Set()
    listeners.set(name, named.add(listener))
    return () => { named.delete(listener) }
  },
  /**
   * What the user's mouse or keyboard did on the game's picture, in the game
   * page's CSS pixels (`src/input.js` says what may be sent).
   * @param {Record<string, unknown>} input
   */
  gameInput(input) {
    ipcRenderer.send('akagi:game-input', input)
  },
  /** How many of the game's frames have come, and how many were dropped. */
  frameCounts() {
    return { ...counts }
  },
})
