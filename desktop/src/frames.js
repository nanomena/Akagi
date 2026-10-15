// @ts-check
// Frames of a page for the stream, taken over its DevTools session.
//
// A frame is exactly what the view shows: a screenshot of the page as drawn,
// at the view's own size in screen pixels. Nothing about the page is changed
// to take it — not its scale, not its size — so the window, the game and
// every position autoplay clicks at stay as they are; a stream that wants
// more pixels than the view has is scaled up by whoever shows it.
//
// Screenshots are asked for at a steady rate, a few in flight at once, rather
// than taken from the screencast: its frames come with the page's own drawing,
// so its rate follows the game's, and it costs as much.

/**
 * The part of Electron's `Debugger` used here.
 * @typedef {{
 *   attach(version?: string): void,
 *   detach(): void,
 *   isAttached(): boolean,
 *   sendCommand(method: string, params?: object): Promise<any>,
 * }} Tools
 */

/**
 * @typedef {object} FrameOptions
 * @property {(jpeg: Buffer) => void} onFrame
 * @property {number} [fps] frames a second at most
 * @property {number} [depth] screenshots in flight at once
 * @property {number} [quality] JPEG quality, 0–100
 * @property {number} [stallMs] how long every screenshot may be outstanding before the session is begun anew
 * @property {(message: string) => void} [log]
 */

/** How often a loop with every screenshot outstanding looks whether they have stalled. */
const STALL_LOOK_MS = 250

export class FrameSource {
  #tools
  #onFrame
  #interval
  #depth
  #quality
  #stallMs
  #log
  #running = false
  /** Whether this source attached the session, and so is the one to let it go. */
  #attached = false
  #inFlight = 0
  /** When each screenshot still outstanding was asked for, oldest first. */
  /** @type {number[]} */
  #asked = []
  #next = 0
  /** Screenshots are numbered as asked; one that comes back after a later one is dropped. */
  #seq = 0
  #shown = 0
  /** Bumped whenever the session is begun anew; answers from an older one are dropped. */
  #epoch = 0
  /** @type {NodeJS.Timeout | undefined} */
  #timer

  /** @param {Tools} tools @param {FrameOptions} options */
  constructor(tools, { onFrame, fps = 30, depth = 3, quality = 85, stallMs = 10_000, log = () => {} }) {
    this.#tools = tools
    this.#onFrame = onFrame
    this.#interval = 1000 / fps
    this.#depth = depth
    this.#quality = quality
    this.#stallMs = stallMs
    this.#log = log
  }

  get running() { return this.#running }

  start() {
    if (this.#running) return
    this.#running = true
    this.#next = performance.now()
    this.#tick()
  }

  /** Stop taking frames, and let the session go if it is ours. */
  stop() {
    if (!this.#running) return
    this.#running = false
    clearTimeout(this.#timer)
    this.#forget()
  }

  /** Drop what is outstanding, and the session if it is ours. */
  #forget() {
    this.#epoch++
    this.#inFlight = 0
    this.#asked = []
    if (!this.#attached) return
    this.#attached = false
    try {
      if (this.#tools.isAttached()) this.#tools.detach()
    } catch { /* gone with the page */ }
  }

  /** Attach if nobody has. @returns {boolean} whether there is a session to use */
  #ready() {
    if (this.#tools.isAttached()) return true
    try {
      this.#tools.attach('1.3')
    } catch (error) {
      this.#log(`stream: cannot attach: ${error instanceof Error ? error.message : error}`)
      return false
    }
    this.#attached = true
    return true
  }

  #tick() {
    if (!this.#running) return
    const now = performance.now()
    if (this.#inFlight > 0 && this.#inFlight >= this.#depth && now - this.#asked[0] > this.#stallMs) {
      // Nothing has come back for a long while — the page went away, or stopped
      // drawing. Begin again; detaching answers what is outstanding.
      this.#log('stream: screenshots stalled; starting the session again')
      this.#forget()
    }
    if (this.#inFlight < this.#depth && now >= this.#next && this.#ready()) {
      // Keep to the rate without making up for time lost.
      this.#next = Math.max(this.#next + this.#interval, now)
      void this.#shoot()
    }
    // With every slot taken, the next answer wakes the loop; until then it only looks for a stall.
    const wait = this.#inFlight >= this.#depth ? STALL_LOOK_MS : Math.max(1, Math.min(this.#next - performance.now(), this.#interval))
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#tick(), wait)
  }

  async #shoot() {
    const epoch = this.#epoch
    const seq = ++this.#seq
    this.#inFlight++
    this.#asked.push(performance.now())
    try {
      const { data } = await this.#tools.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: this.#quality, optimizeForSpeed: true })
      if (epoch !== this.#epoch || !this.#running || seq < this.#shown) return
      this.#shown = seq
      this.#onFrame(Buffer.from(data, 'base64'))
    } catch (error) {
      if (epoch === this.#epoch && this.#running) this.#log(`stream: screenshot failed: ${error instanceof Error ? error.message : error}`)
    } finally {
      if (epoch === this.#epoch) {
        this.#inFlight--
        this.#asked.shift()
        if (this.#running) this.#tick()
      }
    }
  }
}
