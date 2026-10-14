import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { Faces } from '@/components/monitor/Tiles'
import { SeatTag } from '@/components/monitor/Table'
import { invoke } from '@/lib/host'
import {
  eventLine, factsOf, handLabel, resultTitle, seatLabel, serverLine, tableOf,
  type Alert, type Health, type HandSummary, type MonitorEvent, type MonitorSnapshot,
} from '@/lib/monitor'
import { localized, tr } from '@/lib/i18n'

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
const ago = (ms: number) => (ms < 60_000 ? tr('{0} 秒前', (ms / 1000).toFixed(ms < 10_000 ? 1 : 0)) : tr('{0} 分钟前', Math.floor(ms / 60_000)))

/** The game's public events as one list, read top to bottom in the order they
 *  happened: a line for every hand, the hand in play open under its line and the
 *  earlier ones folded until asked for. The newest line is kept in view unless
 *  the reader has scrolled back to look at an earlier one. */
export function EventList({ snapshot: s }: { snapshot: MonitorSnapshot }) {
  const table = tableOf(s.game)
  const confirmed = s.decision?.confirmed_seq ?? null
  const current = s.hands.at(-1) ?? null
  const earlier = s.hands.slice(0, -1)
  // An earlier hand's events, once asked for; `null` while they are on their way.
  const [opened, setOpened] = useState<Record<number, MonitorEvent[] | null>>({})
  const shut = (round: number) => setOpened(o => { const rest = { ...o }; delete rest[round]; return rest })
  const toggle = (round: number) => {
    if (round in opened) { shut(round); return }
    setOpened(o => ({ ...o, [round]: null }))
    invoke<MonitorEvent[]>('get_hand_events', { round }).then(
      events => setOpened(o => (round in o ? { ...o, [round]: events } : o)),
      () => shut(round),
    )
  }
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const newest = s.events.at(-1)?.seq
  useLayoutEffect(() => {
    const el = list.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [newest])
  if (s.events.length === 0 && s.hands.length === 0) return <p className="mslot-empty md-wide">{tr('这一桌还没有事件')}</p>
  // Another seat's draw is face down: a line that says nothing, twice a turn.
  const lines = (events: MonitorEvent[], live: boolean) => events
    .filter(e => !(e.event.type === 'tsumo' && e.event.pai === '?'))
    .map(e => {
      const line = eventLine(e.event, table)
      return <li key={e.seq} className="mevent" data-quiet={line.quiet || undefined} data-self={(line.seat != null && line.seat === table.self) || undefined} data-system={line.seat == null || undefined}>
        <time>{clock(e.ts_ms)}</time>
        <span className="mevent-seat">{line.seat != null && <><SeatTag seat={line.seat} table={table} />{seatLabel(line.seat, table)}<small>{s.names[line.seat] ?? ''}</small></>}</span>
        <span className="mevent-text">{line.text}</span>
        <span className="mevent-faces"><Faces faces={line.faces} /></span>
        <span className="mevent-mark">{live && e.seq === confirmed && <span className="mevent-ok"><Check size={11} strokeWidth={3} />{tr('与建议一致')}</span>}</span>
      </li>
    })
  const head = (hand: HandSummary, open: boolean, onToggle?: () => void) => <li className="mhandrow" data-open={open || undefined}>
    <button disabled={!onToggle} aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <strong>{handLabel(hand)}</strong>
      <span>{hand.result ? resultTitle(hand.result) : tr('进行中')}</span>
      <small>{tr('{0} 条', hand.events)}</small>
    </button>
  </li>
  return <ol className="mevents" ref={list} onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12 }}>
    {earlier.map(hand => <Fragment key={hand.round}>
      {head(hand, hand.round in opened, () => toggle(hand.round))}
      {lines(opened[hand.round] ?? [], false)}
    </Fragment>)}
    {current && head(current, true)}
    {lines(s.events, true)}
  </ol>
}

/** Why there is no valid suggestion right now, in the slot where the candidates
 *  would otherwise be. */
export function FaultCard({ alerts, onDetails }: { alerts: Alert[]; onDetails?: () => void }) {
  return <section className="mfault" role="alert" data-count={Math.min(alerts.length, 3)}>
    <ul>
      {alerts.slice(0, 3).map(a => <li key={a.key}>
        <strong><AlertTriangle size={14} />{a.title}</strong>
        <p title={a.message}>{a.message}</p>
      </li>)}
    </ul>
    <footer>
      <small>{alerts.length > 3 ? tr('另有 {0} 项', alerts.length - 3) : alerts[0].hint}</small>
      {onDetails && <button onClick={onDetails}>{tr('连接详情')}<ChevronRight size={12} /></button>}
    </footer>
  </section>
}

function Fact({ name, value, note }: { name: string; value: string; note?: string }) {
  return <div className="mfact" title={note}><dt>{name}</dt><dd>{value}</dd></div>
}

const LINK_NAME: Record<Health['key'], string> = localized({ capture: '采集', bot: 'Bot 进程', service: '模型服务', sync: '牌局同步' })

function Link({ health, about, hint }: { health: Health; about: string; hint?: string }) {
  return <section className="mlink" data-tone={health.tone}>
    <header><i className="mdot" data-tone={health.tone} /><strong>{LINK_NAME[health.key]}</strong></header>
    <b>{health.state}</b>
    {health.detail ? <p className="mlink-error">{health.detail}</p> : <p>{about}</p>}
    {health.detail && hint && <small>{hint}</small>}
  </section>
}

type DiagProps = { snapshot: MonitorSnapshot | null; health: Health[]; now: number }

/** Capture, Bot process, model service and game-state sync are four separate
 *  things and are reported as such: a ready process does not vouch for the
 *  model behind it, and a quiet table is not a broken link. */
export function Diagnostics({ snapshot: s, health, now }: DiagProps) {
  const [capture, bot, service, sync] = health
  const d = s?.decision ?? s?.previous_decision ?? null
  return <div className="mdiag">
    <Link health={capture}
      about={s && s.capture.state !== 'stopped' ? tr('游戏视图{0}', s.capture.descriptor ? ` · ${s.capture.descriptor}` : '') : tr('没有正在运行的采集')} />
    <Link health={bot}
      about={s && 'bot' in s.bot ? `${s.bot.bot}${s.bot.state === 'ready' ? tr(' · 座位 {0}', s.bot.actor_id + 1) : s.bot.state === 'loading' ? ` · ${s.bot.stage === 'syncing_deps' ? tr('同步依赖') : tr('启动进程')}` : ''}` : tr('进程就绪不代表模型已连接')} />
    <Link health={service} about={serverLine(s, now)}
      hint={s?.server.state === 'failed' ? tr('应用会自动重新启动它 · {0}', serverLine(s, now)) : undefined} />
    <Link health={sync} hint={tr('当前建议已作废，下一局开始后恢复')}
      about={s?.game && !s.game_ended ? tr('对局 {0} · 局序 {1} · 事件 {2}', s.context.game, s.context.round, s.context.event_seq) : tr('对局开始后跟踪牌局')} />

    <dl className="mfacts">
      {/* What this window knows on its own keeps the first three lines; what the bot says about itself follows. */}
      <Fact name={tr('决策往返')} value={d?.reaction_ms != null ? `${d.reaction_ms} ms` : '—'} note={tr('完整的 Bot 往返，立直时含后续请求')} />
      <Fact name={tr('最近牌局事件')} value={s?.last_event_ms ? ago(Math.max(0, now - s.last_event_ms)) : tr('尚未收到')} note={tr('没有新事件不等于断线')} />
      <Fact name={tr('规则')} value={s?.game ? tr('{0} 人{1}', s.game.num_players, s.red_fives == null ? '' : s.red_fives ? tr(' · 有赤牌') : tr(' · 无赤牌')) : '—'} />
      {factsOf(s).map(fact => <Fact key={fact.name} name={fact.name} value={fact.value} note={fact.note} />)}
    </dl>
  </div>
}
