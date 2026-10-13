import type { CSSProperties } from 'react'
import { faceSeq, useFace } from '@/lib/tileFace'
import { meldsRoom, meldView, SIDE, tileLabel, type Face, type Table } from '@/lib/monitor'
import type { DiscardEntry, MeldSnapshot } from '@/types'

// Every tile in the monitor is one of these. Size comes from the `--th` (tile
// height) custom property of whatever row it sits in, so a row scales as a
// unit and nothing here measures the DOM.

/** Width of a row of faces in upright-tile widths. */
const faceUnits = (faces: Face[]) => faces.reduce((sum, f) => sum + (f.side ? SIDE : 1), 0)

export function Tile({ face, pick = false }: { face: Face; pick?: boolean }) {
  const src = useFace(faceSeq(face.tile, face.side, face.back))
  const name = face.back ? '牌背' : tileLabel(face.tile)
  const cls = `mt${face.side ? ' mt--side' : ''}${face.dim ? ' mt--dim' : ''}${pick ? ' mt--pick' : ''}`
  return <span className={cls} title={name}>
    {src ? <img src={src} alt={name} draggable={false} /> : <span className="mt-ghost" role="img" aria-label={name}>{face.back ? '' : name}</span>}
  </span>
}

export function Faces({ faces, className = '' }: { faces: Face[]; className?: string }) {
  if (faces.length === 0) return null
  return <span className={`mfaces ${className}`}>{faces.map((face, i) => <Tile key={i} face={face} />)}</span>
}

type HandProps = {
  tiles: string[]; drawn: string | null
  /** Tiles a live suggestion takes out of the hand — lifted out of the row. */
  marks?: { tiles: Set<number>; drawn: boolean }
  melds?: Face[][]
  /** Tile-widths the row has room for: the most a row of its kind holds in
   *  play, not what it holds now. The tile size follows from this, so a tile
   *  is one size and stays where it is while the hand changes. */
  room: number
  /** Upper bound for the tile height, in px. */
  max?: number
}

/** A hand in a row of fixed room. Standing tiles run from the left edge, each
 *  at the place its position in the hand gives it; calls are laid from the
 *  right edge inwards, the first outermost, as on the table — once down, a
 *  meld does not move. Only a hand wider than any that comes up in play (three
 *  kans, say) makes its tiles smaller, rather than run out of its row. */
export function Hand({ tiles, drawn, marks, melds = [], room, max = 46 }: HandProps) {
  const standing = tiles.length > 0 || !!drawn
  const units = tiles.length + (drawn ? 1.3 : 0) + melds.reduce((sum, m) => sum + faceUnits(m) + 0.3, 0) - (standing ? 0 : 0.3)
  const style = { '--room': Math.max(room, units), '--th-max': `${max}px` } as CSSProperties
  const laid = melds.map((faces, i) => ({ faces, i }))
  if (standing) laid.reverse()
  return <div className="mhand-box"><div className="mhand" style={style}>
    {tiles.map((tile, i) => <Tile key={i} face={{ tile }} pick={marks?.tiles.has(i)} />)}
    {drawn && <span className="mhand-drawn"><Tile face={{ tile: drawn }} pick={marks?.drawn} /></span>}
    {laid.map(({ faces, i }) => <span key={i} className="mhand-meld"><Faces faces={faces} /></span>)}
  </div></div>
}

/** Discards six to a row, as on the table. A sideways tile declared riichi; a
 *  dimmed one was discarded straight from the draw. Claimed discards have left
 *  the pond and are not drawn.
 *
 *  `room` is the number of rows the pond is sized for. Its tiles are one size
 *  up to that many rows; only a longer pond shrinks them, rather than spill
 *  over its neighbours. The dock's ponds have room for four rows — twenty-four
 *  discards, more than a seat makes in play — so theirs never change size. */
export function River({ river, room = 3 }: { river: DiscardEntry[]; room?: number }) {
  const faces: Face[] = river.filter(d => !d.called).map(d => ({ tile: d.tile, side: d.is_riichi, dim: !d.tedashi }))
  const rows: Face[][] = []
  for (let i = 0; i < faces.length; i += 6) rows.push(faces.slice(i, i + 6))
  return <div className="mriver" style={{ '--rows': Math.max(room, rows.length) } as CSSProperties} aria-label={`牌河 ${faces.length} 张`}>
    {rows.map((row, i) => <Faces key={i} faces={row} />)}
  </div>
}

/** Open melds in rows of `perRow`, at one tile size: each row has the room
 *  `perRow` melds need in play, whatever melds it holds. */
export function Melds({ melds, seat, table, max, perRow = 2 }: { melds: MeldSnapshot[]; seat: number; table: Table; max: number; perRow?: number }) {
  if (melds.length === 0) return null
  const rows: Face[][][] = []
  for (let i = 0; i < melds.length; i += perRow) rows.push(melds.slice(i, i + perRow).map(m => meldView(m, seat, table)))
  return <div className="mmelds">{rows.map((row, i) => <Hand key={i} tiles={[]} drawn={null} melds={row} room={meldsRoom(perRow)} max={max} />)}</div>
}
