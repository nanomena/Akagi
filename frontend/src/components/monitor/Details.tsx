import { useLayoutEffect, useRef } from 'react'
import { AlertTriangle, Check, ChevronRight } from 'lucide-react'
import { Faces } from '@/components/monitor/Tiles'
import { SeatTag } from '@/components/monitor/Table'
import { eventLine, factsOf, seatLabel, serverLine, tableOf, type Alert, type Health, type MonitorSnapshot } from '@/lib/monitor'

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
const ago = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒前` : `${Math.floor(ms / 60_000)} 分钟前`)

/** This round's public events as one list, read top to bottom in the order
 *  they happened. The newest line is kept in view unless the reader has
 *  scrolled back to look at an earlier one. */
export function EventList({ snapshot: s }: { snapshot: MonitorSnapshot }) {
  const table = tableOf(s.game)
  const confirmed = s.decision?.confirmed_seq ?? null
  // Another seat's draw is face down: a line that says nothing, twice a turn.
  const events = s.events.filter(e => !(e.event.type === 'tsumo' && e.event.pai === '?'))
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const newest = events.at(-1)?.seq
  useLayoutEffect(() => {
    const el = list.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [newest])
  if (events.length === 0) return <p className="mslot-empty md-wide">本局还没有事件</p>
  return <ol className="mevents" ref={list} onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12 }}>
    {events.map(e => {
      const line = eventLine(e.event, table)
      return <li key={e.seq} className="mevent" data-quiet={line.quiet || undefined} data-self={(line.seat != null && line.seat === table.self) || undefined} data-system={line.seat == null || undefined}>
        <time>{clock(e.ts_ms)}</time>
        <span className="mevent-seat">{line.seat != null && <><SeatTag seat={line.seat} table={table} />{seatLabel(line.seat, table)}<small>{s.names[line.seat] ?? ''}</small></>}</span>
        <span className="mevent-text">{line.text}</span>
        <Faces faces={line.faces} />
        {e.seq === confirmed && <span className="mevent-ok"><Check size={11} strokeWidth={3} />与建议一致</span>}
      </li>
    })}
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
      <small>{alerts.length > 3 ? `另有 ${alerts.length - 3} 项` : alerts[0].hint}</small>
      {onDetails && <button onClick={onDetails}>连接详情<ChevronRight size={12} /></button>}
    </footer>
  </section>
}

function Fact({ name, value, note }: { name: string; value: string; note?: string }) {
  return <div className="mfact" title={note}><dt>{name}</dt><dd>{value}</dd></div>
}

const LINK_NAME: Record<Health['key'], string> = { capture: '采集', bot: 'Bot 进程', service: '模型服务', sync: '牌局同步' }

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
      about={s && 'kind' in s.capture ? `${s.capture.kind === 'chromium' ? 'Chromium' : 'MITM'}${s.capture.descriptor ? ` · ${s.capture.descriptor}` : ''}` : '没有正在运行的采集'} />
    <Link health={bot}
      about={s && 'bot' in s.bot ? `${s.bot.bot}${s.bot.state === 'ready' ? ` · 座位 ${s.bot.actor_id + 1}` : s.bot.state === 'loading' ? ` · ${s.bot.stage === 'syncing_deps' ? '同步依赖' : '启动进程'}` : ''}` : '进程就绪不代表模型已连接'} />
    <Link health={service} about={serverLine(s, now)}
      hint={s?.server.state === 'failed' ? `应用会自动重新启动它 · ${serverLine(s, now)}` : undefined} />
    <Link health={sync} hint="当前建议已作废，下一局开始后恢复"
      about={s?.game && !s.game_ended ? `对局 ${s.context.game} · 局序 ${s.context.round} · 事件 ${s.context.event_seq}` : '对局开始后跟踪牌局'} />

    <dl className="mfacts">
      {/* What the bot says about itself, as it says it; then what this window knows on its own. */}
      {factsOf(s).map(fact => <Fact key={fact.name} name={fact.name} value={fact.value} note={fact.note} />)}
      <Fact name="决策往返" value={d?.reaction_ms != null ? `${d.reaction_ms} ms` : '—'} note="完整的 Bot 往返，立直时含后续请求" />
      <Fact name="最近牌局事件" value={s?.last_event_ms ? ago(Math.max(0, now - s.last_event_ms)) : '尚未收到'} note="没有新事件不等于断线" />
      <Fact name="规则" value={s?.game ? `${s.game.num_players} 人${s.red_fives == null ? '' : s.red_fives ? ' · 有赤牌' : ' · 无赤牌'}` : '—'} />
    </dl>
  </div>
}
