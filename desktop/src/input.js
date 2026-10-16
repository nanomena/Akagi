// @ts-check
// The user's own hand on the game, when the game is rendered offscreen and the
// monitor shows a picture of it: the monitor's page sends what the mouse and
// keyboard do over that picture, already in the game page's CSS pixels, and
// this turns it into input for the page. Nothing the page sends is trusted
// further than this. Plain Node, so it is tested without Electron.

/**
 * What the monitor's page sends.
 * @typedef {{ type: 'move' | 'down' | 'up' | 'leave', x: number, y: number, button?: number, buttons?: number, count?: number, mods?: Mods }} PointerInput
 * @typedef {{ type: 'wheel', x: number, y: number, dx: number, dy: number, mods?: Mods }} WheelInput
 * @typedef {{ type: 'keydown' | 'keyup', key: string, mods?: Mods }} KeyInput
 * @typedef {{ type: 'text', text: string }} TextInput
 * @typedef {{ type: 'paste' }} PasteInput
 * @typedef {PointerInput | WheelInput | KeyInput | TextInput | PasteInput} GameInput
 * @typedef {{ shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean }} Mods
 *
 * What is done with it: an event for `webContents.sendInputEvent`, text for
 * `webContents.insertText`, or the clipboard's text to insert.
 * @typedef {{ event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent } | { text: string } | { paste: true }} Action
 */

/** The longest text taken at once: a pasted address or a sentence, not a file. */
export const TEXT_MAX = 2000

const BUTTONS = /** @type {const} */ (['left', 'middle', 'right'])
const HELD = /** @type {const} */ (['leftbuttondown', 'rightbuttondown', 'middlebuttondown'])
/** DOM key names that are not what Electron calls them. */
const KEYS = /** @type {Record<string, string>} */ ({
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Esc: 'Escape',
})
/** Keys that do something besides typing, passed on as keys. */
const NAMED = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Left', 'Right', 'Up', 'Down', 'Space',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'])

/** @param {unknown} v @param {number} most */
const within = (v, most) => typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), most) : null

/** @param {Mods | undefined} mods @param {number} [buttons] */
function modifiers(mods, buttons = 0) {
  /** @type {Array<Electron.InputEvent['modifiers'] extends (infer M)[] | undefined ? M : never>} */
  const out = []
  if (mods?.shift) out.push('shift')
  if (mods?.ctrl) out.push('control')
  if (mods?.alt) out.push('alt')
  if (mods?.meta) out.push('meta')
  // A move with a button held is a drag; the page has to be told the button is down.
  HELD.forEach((held, i) => { if (buttons & (1 << i)) out.push(held) })
  return out
}

/**
 * The key Electron is to press for a DOM `key`, or `null` for one that is not
 * passed on as a key: printable text goes as text, unless a modifier other
 * than shift makes it a shortcut.
 * @param {string} key
 * @param {Mods | undefined} mods
 * @returns {string | null}
 */
export function keyCode(key, mods) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 12) return null
  const named = KEYS[key] ?? key
  if (NAMED.has(named)) return named
  const shortcut = mods?.ctrl || mods?.alt || mods?.meta
  if (shortcut && /^[a-z0-9]$/i.test(key)) return key.toUpperCase()
  return null
}

/**
 * What to do for one input from the monitor's page, or `null` for nothing.
 * @param {unknown} input
 * @param {{ width: number, height: number }} page the game page's CSS size
 * @returns {Action | null}
 */
export function toGame(input, page) {
  if (!input || typeof input !== 'object') return null
  const any = /** @type {Record<string, any>} */ (input)
  switch (any.type) {
    case 'move': case 'down': case 'up': case 'leave': {
      const x = within(any.x, page.width), y = within(any.y, page.height)
      if (x === null || y === null) return null
      const type = any.type === 'move' ? 'mouseMove' : any.type === 'down' ? 'mouseDown' : any.type === 'up' ? 'mouseUp' : 'mouseLeave'
      /** @type {Electron.MouseInputEvent} */
      const event = { type, x: Math.round(x), y: Math.round(y), modifiers: modifiers(any.mods, any.type === 'move' ? Number(any.buttons) || 0 : 0) }
      if (type === 'mouseDown' || type === 'mouseUp') {
        event.button = BUTTONS[Number(any.button)] ?? 'left'
        event.clickCount = Math.min(Math.max(Math.round(Number(any.count) || 1), 1), 3)
      }
      return { event }
    }
    case 'wheel': {
      const x = within(any.x, page.width), y = within(any.y, page.height)
      const dx = Number(any.dx) || 0, dy = Number(any.dy) || 0
      if (x === null || y === null || !Number.isFinite(dx) || !Number.isFinite(dy)) return null
      // A DOM wheel event's delta is down-positive, Electron's up-positive.
      return { event: { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: -dx, deltaY: -dy, canScroll: true, modifiers: modifiers(any.mods) } }
    }
    case 'keydown': case 'keyup': {
      const code = keyCode(any.key, any.mods)
      if (!code) return null
      return { event: { type: any.type === 'keydown' ? 'keyDown' : 'keyUp', keyCode: code, modifiers: modifiers(any.mods) } }
    }
    case 'text': {
      if (typeof any.text !== 'string' || any.text.length === 0) return null
      return { text: any.text.slice(0, TEXT_MAX) }
    }
    case 'paste':
      return { paste: true }
    default:
      return null
  }
}
