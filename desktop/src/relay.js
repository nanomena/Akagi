// @ts-check
// The game's frames, handed on as they are drawn. With the game rendered
// offscreen, Chromium gives the shell each frame as a texture on the GPU; the
// relay lends it to whoever takes frames — the monitor's page, a Spout sender
// for a streaming program — and gives it back to Chromium once every one of
// them is done with it. No frame passes through the CPU.
//
// Chromium has only a few such textures. A taker that still has two frames
// out is passed over for the next, and one that never says it is done is
// taken to be done after a while, so that the game never runs out of them.
// Plain Node, so it is tested without Electron: what Electron provides
// (`sharedTexture`, a process to spawn) is handed in.

import { createInterface } from 'node:readline'

/**
 * A frame as Electron hands it over: `textureInfo` says what it is, `release`
 * gives it back. (`Electron.OffscreenSharedTexture`.)
 * @typedef {{ textureInfo: TextureInfo, release(): void }} Texture
 * @typedef {{ widgetType: string, codedSize: { width: number, height: number }, handle: { ntHandle?: Buffer } }} TextureInfo
 *
 * Someone who takes frames. `take` must call `done` once, when it no longer
 * needs the texture.
 * @typedef {{ name: string, busy(): boolean, take(texture: Texture, done: () => void): void }} Taker
 */

/** How many frames a taker may have out before it is passed over. */
export const AT_ONCE = 2

export class Relay {
  /** @type {Set<Taker>} */
  #takers = new Set()
  #expected
  #onSize
  #log
  /** The size of the last frame that was not the one expected, so that it is said once. */
  #wrong = ''
  frames = 0
  passed = 0

  /**
   * @param {{ expected: { width: number, height: number }, onSize?: (size: { width: number, height: number }) => void, log?: (message: string) => void }} options
   */
  constructor({ expected, onSize = () => {}, log = () => {} }) {
    this.#expected = expected
    this.#onSize = onSize
    this.#log = log
  }

  /** @param {Taker} taker */
  add(taker) { this.#takers.add(taker) }
  /** @param {Taker} taker */
  delete(taker) { this.#takers.delete(taker) }
  get takers() { return [...this.#takers] }

  /** A frame from the page: lent to every taker free to take it. @param {Texture} texture */
  paint(texture) {
    const info = texture.textureInfo
    // Popups (a <select>'s list) are drawn apart from the page; the game has none worth showing.
    if (info.widgetType !== 'frame') return texture.release()
    this.frames++
    const { width, height } = info.codedSize
    if (width !== this.#expected.width || height !== this.#expected.height) {
      const size = `${width}x${height}`
      if (size !== this.#wrong) {
        this.#wrong = size
        this.#log(`relay: frames are ${size}, not ${this.#expected.width}x${this.#expected.height}`)
        this.#onSize({ width, height })
      }
    } else {
      this.#wrong = ''
    }
    const takers = [...this.#takers].filter(taker => !taker.busy())
    this.passed += this.#takers.size - takers.length
    if (takers.length === 0) return texture.release()
    let left = takers.length
    for (const taker of takers) {
      let given = false
      const done = () => {
        if (given) return
        given = true
        if (--left === 0) texture.release()
      }
      try {
        taker.take(texture, done)
      } catch (error) {
        this.#log(`relay: ${taker.name}: ${error instanceof Error ? error.message : error}`)
        done()
      }
    }
  }
}

/**
 * The monitor's page as a taker: each frame is imported and sent to the page's
 * main frame, where its preload shows it (`preload.cjs`). The page lets go of
 * its reference once it has drawn the frame; the texture goes back once
 * neither side holds it.
 * @param {{
 *   sharedTexture: Pick<typeof import('electron').sharedTexture, 'importSharedTexture' | 'sendSharedTexture'>,
 *   frame: () => Electron.WebFrameMain | null,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Taker}
 */
export function pageTaker({ sharedTexture, frame, log = () => {} }) {
  let out = 0
  let failing = false
  return {
    name: 'monitor',
    busy: () => out >= AT_ONCE || !frame(),
    take(texture, done) {
      const target = frame()
      if (!target) return done()
      const imported = sharedTexture.importSharedTexture({ textureInfo: /** @type {any} */ (texture.textureInfo), allReferencesReleased: done })
      out++
      sharedTexture.sendSharedTexture({ frame: target, importedSharedTexture: imported })
        .then(() => {
          if (failing) log('relay: the monitor takes frames again')
          failing = false
        }, error => {
          // A page that is loading has no receiver yet; said once until it takes frames again.
          if (!failing) log(`relay: the monitor did not take a frame: ${error instanceof Error ? error.message : error}`)
          failing = true
        })
        .finally(() => {
          out--
          imported.release()
        })
    },
  }
}

/** How long the sender may take over a frame before it is given back anyway. */
const SENDER_PATIENCE_MS = 1000
/** How long after the sender stops it is started again, doubling to the last. */
const RESTART_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * A Spout sender as a taker: a process of its own (`native/spout`) that opens
 * each texture by its handle, copies it into the texture it shares under
 * `name`, and answers with the frame's number once the copy has run.
 * Windows only; anywhere else, or without the program, there is no sender.
 */
export class SpoutTaker {
  name = 'spout'
  #exe
  #pid
  #sender
  #spawn
  #log
  #onState
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  #child = null
  /** @type {Map<number, { done: () => void, timer: NodeJS.Timeout }>} */
  #out = new Map()
  #seq = 0
  #stopped = false
  #restarts = 0
  /** @type {NodeJS.Timeout | undefined} */
  #again
  /** @type {'starting' | 'sending' | 'stopped' | 'failed'} */
  state = 'starting'
  detail = ''

  /**
   * @param {{
   *   exe: string, pid: number, sender: string,
   *   spawn: typeof import('node:child_process').spawn,
   *   log?: (message: string) => void,
   *   onState?: (state: SpoutTaker['state'], detail: string) => void,
   * }} options
   */
  constructor({ exe, pid, sender, spawn, log = () => {}, onState = () => {} }) {
    this.#exe = exe
    this.#pid = pid
    this.#sender = sender
    this.#spawn = spawn
    this.#log = log
    this.#onState = onState
    this.#start()
  }

  busy() { return !this.#child || this.#out.size >= AT_ONCE }

  /** @param {Texture} texture @param {() => void} done */
  take(texture, done) {
    const child = this.#child
    const handle = texture.textureInfo.handle.ntHandle
    if (!child || !child.stdin.writable || !handle) return done()
    const id = ++this.#seq
    const timer = setTimeout(() => {
      // The copy may still run; the frame it lands in is then torn, which is
      // better than a game that has no textures left to draw into.
      if (this.#out.delete(id)) done()
    }, SENDER_PATIENCE_MS)
    this.#out.set(id, { done, timer })
    const { width, height } = texture.textureInfo.codedSize
    child.stdin.write(`${id} ${handle.readBigUInt64LE(0)} ${width} ${height}\n`)
  }

  stop() {
    this.#stopped = true
    clearTimeout(this.#again)
    this.#child?.stdin.end()
    this.#giveBack()
    this.#set('stopped', '')
  }

  #start() {
    if (this.#stopped) return
    let child
    try {
      child = this.#spawn(this.#exe, [String(this.#pid), '--name', this.#sender], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.#child = null
      this.#ended(null, `cannot start: ${error instanceof Error ? error.message : error}`)
      return
    }
    this.#child = child
    child.stdin.on('error', () => {})
    // A program that cannot be started says so as an error and never exits; one that ran, by exiting.
    child.on('error', error => this.#ended(child, error.message))
    child.on('exit', code => this.#ended(child, `stopped (${code})`))
    createInterface({ input: child.stderr }).on('line', line => {
      this.#log(`spout: ${line}`)
      if (line.startsWith('sending as')) {
        this.#restarts = 0
        this.#set('sending', this.#sender)
      }
    })
    createInterface({ input: child.stdout }).on('line', line => {
      const [id, outcome, ...why] = line.split(' ')
      const out = this.#out.get(Number(id))
      if (!out) return
      this.#out.delete(Number(id))
      clearTimeout(out.timer)
      if (outcome !== 'ok') this.#log(`spout: frame ${id}: ${why.join(' ')}`)
      out.done()
    })
  }

  /** @param {import('node:child_process').ChildProcess | null} child @param {string} why */
  #ended(child, why) {
    if (child !== this.#child) return
    this.#child = null
    this.#giveBack()
    if (this.#stopped) return
    const wait = RESTART_MS[Math.min(this.#restarts, RESTART_MS.length - 1)]
    this.#restarts++
    this.#log(`spout: sender ${why}; starting it again in ${wait / 1000} s`)
    this.#set('failed', why)
    clearTimeout(this.#again)
    this.#again = setTimeout(() => this.#start(), wait)
  }

  /** Every frame still out goes back: nobody is going to answer for it. */
  #giveBack() {
    for (const { done, timer } of this.#out.values()) {
      clearTimeout(timer)
      done()
    }
    this.#out.clear()
  }

  /** @param {SpoutTaker['state']} state @param {string} detail */
  #set(state, detail) {
    if (state === this.state && detail === this.detail) return
    this.state = state
    this.detail = detail
    this.#onState(state, detail)
  }
}
