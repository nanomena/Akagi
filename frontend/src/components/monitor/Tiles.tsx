import type { CSSProperties } from 'react'
import { faceSeq, useFace } from '@/lib/tileFace'
import { meldView, tileLabel, type Face, type Table } from '@/lib/monitor'
import type { DiscardEntry, MeldSnapshot } from '@/types'

// Every tile in the monitor is one of these. Size comes from the `--th` (tile
// height) custom property of whatever row it sits in, so a row scales as a
// unit and nothing here measures the DOM.

/** Width of a row of faces in upright-tile widths; a face lying down is 92/70 of one. */
const faceUnits = (faces: Face[]) => faces.reduce((sum, f) => sum + (f.side ? 92 / 70 : 1), 0)

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
  /** Upper bound for the tile height, in px. The row shrinks below it to fit. */
  max?: number
}

/** A hand that always fits its container: the tile height is solved from the
 *  container width and the number of tile-widths the row holds. */
export function Hand({ tiles, drawn, marks, melds = [], max = 46 }: HandProps) {
  // Gaps are fractions of a tile so the whole row keeps scaling together.
  const units = tiles.length + (drawn ? 1.3 : 0) + melds.reduce((sum, m) => sum + faceUnits(m) + 0.3, 0) - (tiles.length || drawn ? 0 : 0.3)
  const style = { '--units': Math.max(units, 1), '--th-max': `${max}px` } as CSSProperties
  return <div className="mhand-box"><div className="mhand" style={style}>
    {tiles.map((tile, i) => <Tile key={i} face={{ tile }} pick={marks?.tiles.has(i)} />)}
    {drawn && <span className="mhand-drawn"><Tile face={{ tile: drawn }} pick={marks?.drawn} /></span>}
    {melds.map((faces, i) => <span key={i} className="mhand-meld"><Faces faces={faces} /></span>)}
  </div></div>
}

/** Discards six to a row, as on the table. A sideways tile declared riichi; a
 *  dimmed one was discarded straight from the draw. Claimed discards have left
 *  the pond and are not drawn. The pond has room for three rows; a longer one
 *  shrinks its tiles rather than spill over its neighbours (`--rows`). */
export function River({ river }: { river: DiscardEntry[] }) {
  const faces: Face[] = river.filter(d => !d.called).map(d => ({ tile: d.tile, side: d.is_riichi, dim: !d.tedashi }))
  const rows: Face[][] = []
  for (let i = 0; i < faces.length; i += 6) rows.push(faces.slice(i, i + 6))
  return <div className="mriver" style={{ '--rows': Math.max(3, rows.length) } as CSSProperties} aria-label={`牌河 ${faces.length} 张`}>
    {rows.map((row, i) => <Faces key={i} faces={row} />)}
  </div>
}

/** Open melds in rows, each row fitted to the width it has: a cell of the
 *  table is a fixed size, and two kans side by side must still fit it. */
export function Melds({ melds, seat, table, max, perRow = 2 }: { melds: MeldSnapshot[]; seat: number; table: Table; max: number; perRow?: number }) {
  if (melds.length === 0) return null
  const rows: Face[][][] = []
  for (let i = 0; i < melds.length; i += perRow) rows.push(melds.slice(i, i + perRow).map(m => meldView(m, seat, table)))
  return <div className="mmelds">{rows.map((row, i) => <Hand key={i} tiles={[]} drawn={null} melds={row} max={max} />)}</div>
}
