import { Faces, Hand, Melds, River } from '@/components/monitor/Tiles'
import { fmtScore } from '@/lib/format'
import {
  REL_SHORT, HAND_ROOM, handMarks, handOutcome, meldView, ownHand, relOf, resultTitle, seatLabel, seatWind, signed, tableOf,
  type MonitorSnapshot, type RoundResult, type Table,
} from '@/lib/monitor'
import type { GameStateSnapshot, MjaiEvent } from '@/types'

export function SeatTag({ seat, table }: { seat: number | null; table: Table }) {
  if (seat == null) return <span className="mseat-tag" data-rel="none" aria-hidden>·</span>
  const rel = relOf(seat, table)
  return <span className="mseat-tag" data-rel={rel ?? 'none'} title={seatLabel(seat, table)}>{rel ? REL_SHORT[rel] : seat + 1}</span>
}

function Delta({ value }: { value: number }) {
  return <span className="mdelta" data-sign={value > 0 ? 'up' : value < 0 ? 'down' : 'flat'}>{signed(value)}</span>
}

/** Seats in turn order starting with our own. */
function seatsFromSelf(game: GameStateSnapshot): number[] {
  const own = game.our_seat ?? 0
  return game.players.map(p => p.seat).sort((a, b) => ((a - own + game.num_players) % game.num_players) - ((b - own + game.num_players) % game.num_players))
}

type StripProps = {
  game: GameStateSnapshot
  /** The live suggestion, if there is one: its tiles are lifted out of the hand. */
  suggestion: MjaiEvent | null
}

/** The tracker's view of our own hand — what the model was actually shown. */
export function HandStrip({ game, suggestion }: StripProps) {
  const seat = game.our_seat
  if (seat == null) return null
  const me = game.players[seat]
  const table = tableOf(game)
  const hand = ownHand(game)
  return <section className="mhandsec">
    <header className="msec-head"><h3>手牌{me.riichi_declared && <span className="mtag" data-tone="riichi">立直</span>}</h3></header>
    <div className="mhandsec-row">
      <Hand tiles={hand.tiles} drawn={hand.drawn} marks={handMarks(hand, suggestion)} melds={me.melds.map(m => meldView(m, seat, table))} room={HAND_ROOM} max={44} />
    </div>
  </section>
}

/** Four scores on one line, ours first, then in turn order. */
export function ScoreStrip({ game }: { game: GameStateSnapshot }) {
  const table = tableOf(game)
  return <dl className="mscorestrip">
    {seatsFromSelf(game).map(seat => {
      const p = game.players[seat]
      return <div key={seat} data-self={seat === game.our_seat || undefined} data-riichi={p.riichi_declared || undefined}>
        <dt><SeatTag seat={seat} table={table} /><span>{seatWind(seat, game)}</span>{seat === game.oya && <i>庄</i>}{p.riichi_declared && <em>立直</em>}</dt>
        <dd>{fmtScore(p.score)}</dd>
      </div>
    })}
  </dl>
}

type ResultProps = {
  result: RoundResult
  snapshot: MonitorSnapshot
  /** A result kept from the round before: the table it refers to is gone. */
  previous?: boolean
}

/** What the round's end made public — and nothing inferred beyond that. The
 *  revealed hands stand one to a line; the settled scores beside them. */
export function ResultCard({ result, snapshot: s, previous = false }: ResultProps) {
  const game = s.game
  const table = tableOf(game)
  return <section className="mresult" data-kind={result.kind === 'hora' ? 'hora' : 'draw'}>
    <header className="msec-head">
      <h3>{previous ? '上一局结果' : '本局结果'}<span className="mtag" data-tone={result.kind === 'hora' ? 'win' : 'idle'}>{resultTitle(result)}</span></h3>
    </header>
    <div className="mresult-hands">
      {result.hands.length === 0 && <p className="mslot-empty">这一局没有公开的手牌</p>}
      {result.hands.slice(0, 4).map(h => {
        // Open melds are only known while this round is still on the table.
        const melds = previous ? [] : game?.players[h.seat]?.melds.map(m => meldView(m, h.seat, table)) ?? []
        return <div key={h.seat} className="mreveal">
          <div className="mreveal-who"><SeatTag seat={h.seat} table={table} /><b>{seatLabel(h.seat, table)}</b><span>{handOutcome(h, table)}</span></div>
          <Hand tiles={h.tiles} drawn={h.winning_tile} melds={melds} room={HAND_ROOM} max={28} />
          <span className="mreveal-ura">{h.ura_markers.length > 0 && <>里宝牌指示<Faces faces={h.ura_markers.map(tile => ({ tile }))} /></>}</span>
        </div>
      })}
    </div>
    <ResultScores result={result} snapshot={s} />
  </section>
}

/** The settled scores of a result, one line a seat. */
export function ResultScores({ result, snapshot: s }: { result: RoundResult; snapshot: MonitorSnapshot }) {
  const table = tableOf(s.game)
  if (!result.scores) return <p className="mslot-empty">没有收到结算点数</p>
  return <dl className="mscores">
    {result.scores.map((score, seat) => <div key={seat} data-self={seat === table.self || undefined}>
      <dt><SeatTag seat={seat} table={table} />{seatLabel(seat, table)}</dt>
      <dd>{fmtScore(score)}</dd>
      <dd>{result.deltas?.[seat] != null && <Delta value={result.deltas[seat]} />}</dd>
    </div>)}
  </dl>
}

/** The public table as the tracker holds it, one column a seat: left to right
 *  the seats to our left, across and to our right, then our own. Other seats'
 *  concealed tiles are never part of it. */
export function SeatColumns({ snapshot: s }: { snapshot: MonitorSnapshot }) {
  const game = s.game!
  const table = tableOf(game)
  const own = game.our_seat ?? 0
  const n = game.num_players
  // Turn order runs right to left across the table as we look at it.
  const order = [...Array(n - 1).keys()].map(i => game.players[(own + n - 1 - i) % n]).concat(game.players[own])
  return <div className="mseats">
    {order.map(p => {
      const self = p.seat === game.our_seat
      return <section key={p.seat} className="mseat" data-self={self || undefined}>
        {/* Five places, each its own: a seat that declares riichi moves nothing. East is the dealer. */}
        <header>
          <SeatTag seat={p.seat} table={table} />
          <span className="mseat-wind" title={p.seat === game.oya ? '庄家' : undefined}>{seatWind(p.seat, game)}</span>
          <span className="mseat-riichi" title={p.riichi_declared ? '已立直' : undefined}>{p.riichi_declared && '立'}</span>
          <span className="mseat-name">{s.names[p.seat] ?? ''}</span>
          <b>{fmtScore(p.score)}</b>
        </header>
        <div className="mseat-pond" title="横置：立直宣言牌　变暗：摸切　被鸣走的牌不在牌河"><River river={p.river} room={4} /></div>
        <div className="mseat-foot">
          <Melds melds={p.melds} seat={p.seat} table={table} max={20} perRow={4} />
          {p.melds.length === 0 && <small>{self ? `手牌 ${p.tehai.length} 张` : `暗手 ${p.tehai.length} 张，未公开`}</small>}
        </div>
      </section>
    })}
  </div>
}
