// @ts-check
// A small board the pages beside the stream share. A page puts a value under
// a name; every page listening is told. The pages are of one origin, but a
// streaming program may run them in browsers that share no storage (OBS keeps
// its docks apart from its sources), so this is where they meet: a control
// page says what an overlay should show, a music page says what it is playing.
// The board is kept in memory only. A page that owns a value puts it again
// when it connects; nothing here outlives the application.

/** What the board holds at most. */
export const BOARD_LIMITS = { names: 32, bytes: 64 * 1024 }

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Whether `name` may be a name on the board: lower-case letters, digits and dashes, 40 at most. @param {string} name */
export const isBoardName = name => NAME.test(name)

/** @typedef {(name: string, value: unknown) => void} BoardListener */

export class Board {
  /** @type {Map<string, unknown>} */
  #values = new Map()
  /** @type {Set<BoardListener>} */
  #listeners = new Set()

  /** Everything on the board, by name. */
  get all() { return Object.fromEntries(this.#values) }

  /**
   * Put `value` under `name`, and tell every listener.
   * @param {string} name @param {unknown} value
   */
  set(name, value) {
    if (!isBoardName(name)) throw new Error(`not a board name: ${name}`)
    if (!this.#values.has(name) && this.#values.size >= BOARD_LIMITS.names) throw new Error('the board is full')
    this.#values.set(name, value)
    for (const listener of this.#listeners) {
      try { listener(name, value) } catch { /* one listener's trouble is not the board's */ }
    }
  }

  /** Be told of every value put. @param {BoardListener} listener @returns {() => void} to stop */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}
