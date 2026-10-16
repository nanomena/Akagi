// The user's hand on the game's picture, when the game is drawn offscreen and
// this page shows its frames: what the mouse and keyboard do over the picture,
// put in the game page's own CSS pixels for the shell to pass on
// (`desktop/src/input.js` says what it takes).

/** The game page's size in CSS pixels when it is drawn offscreen. */
export const GAME = { width: 1280, height: 720 } as const

export type Mods = { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }
export type GameInput =
  | { type: 'move' | 'down' | 'up' | 'leave'; x: number; y: number; button?: number; buttons?: number; count?: number; mods?: Mods }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; mods?: Mods }
  | { type: 'keydown' | 'keyup'; key: string; mods?: Mods }
  | { type: 'text'; text: string }
  | { type: 'paste' }

type Box = { left: number; top: number; width: number; height: number }

/** A point on the picture, in the game page's pixels. */
export function toGame(clientX: number, clientY: number, box: Box): { x: number; y: number } {
  return {
    x: (clientX - box.left) * GAME.width / Math.max(box.width, 1),
    y: (clientY - box.top) * GAME.height / Math.max(box.height, 1),
  }
}

export function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Mods | undefined {
  if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return undefined
  return { shift: e.shiftKey || undefined, ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined, meta: e.metaKey || undefined }
}

/** A wheel turn in pixels, whatever unit the browser gave it in. */
export function wheelPixels(delta: number, mode: number): number {
  return mode === 1 ? delta * 40 : mode === 2 ? delta * 720 : delta
}

/** Keys that do something besides typing; the rest arrive as text. */
const NAMED = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'])

/**
 * What a key press over the picture is: a key to press on the game, a paste,
 * or nothing — the typed character then comes as text from the field that
 * has the focus (which is also where an input method composes it).
 */
export function keyAction(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }): 'key' | 'paste' | null {
  if (e.isComposing || e.key === 'Process') return null
  const shortcut = e.ctrlKey || e.metaKey
  if (shortcut && !e.altKey && e.key.toLowerCase() === 'v') return 'paste'
  if (NAMED.has(e.key)) return 'key'
  if ((shortcut || e.altKey) && /^[a-z0-9]$/i.test(e.key)) return 'key'
  return null
}

/** The game's cursor, as Electron names it, in CSS. */
export function cssCursor(type: unknown): string {
  switch (type) {
    case 'hand': return 'pointer'
    case 'text': return 'text'
    case 'crosshair': return 'crosshair'
    case 'move': return 'move'
    case 'wait': return 'wait'
    case 'progress': return 'progress'
    case 'help': return 'help'
    case 'not-allowed': case 'notAllowed': return 'not-allowed'
    case 'grab': return 'grab'
    case 'grabbing': return 'grabbing'
    case 'none': return 'none'
    case 'e-resize': case 'w-resize': case 'ew-resize': case 'col-resize': return 'ew-resize'
    case 'n-resize': case 's-resize': case 'ns-resize': case 'row-resize': return 'ns-resize'
    default: return 'default'
  }
}
