import { useSyncExternalStore } from 'react'
import { Mahgen } from 'mahgen'

// Single tile faces, drawn by mahgen and laid out by plain CSS.
//
// `<mah-gen>` renders a whole sequence into one bitmap, which is right for a
// dashboard tile but leaves nothing to style: a hand cannot lift the tile the
// model wants to discard, and a river cannot dim or wrap its own entries. The
// monitor instead asks mahgen for each face once, caches it, and places the
// images itself. A face is 70×100; laid sideways mahgen redraws it with the
// tile's edge on top, 92×77, so a called tile is its own bitmap, not a rotation.

const Z = 'ESWNPFC'

/** mjai tile → mahgen sequence for one face. `?` is a tile back. */
export function faceSeq(tile: string, side = false, back = false): string {
  const at = Z.indexOf(tile)
  const code = back || !tile || tile === '?' ? '0z'
    : at >= 0 && tile.length === 1 ? `${at + 1}z`
    : `${tile.endsWith('r') ? 0 : tile[0]}${tile[1]}`
  return side ? `_${code}` : code
}

const faces = new Map<string, string>()
const waiting = new Set<string>()
const listeners = new Set<() => void>()

function load(seq: string): void {
  if (faces.has(seq) || waiting.has(seq)) return
  waiting.add(seq)
  // No canvas (tests, a failed decode) leaves the labelled placeholder in place.
  void Mahgen.render(seq, false).then(url => { faces.set(seq, url) }, () => {}).finally(() => {
    listeners.forEach(notify => notify())
  })
}
function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

/** Data URL for one face, or undefined until mahgen has drawn it. */
export function useFace(seq: string): string | undefined {
  load(seq)
  return useSyncExternalStore(subscribe, () => faces.get(seq), () => undefined)
}
