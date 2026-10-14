import { factsOf, serverLine, type MonitorConfig, type MonitorSnapshot } from '@/lib/monitor'

type Props = {
  snapshot: MonitorSnapshot | null
  options: MonitorConfig
  now: number
  /** `null` while the window's own options have not been read, or are being written. */
  onPin: ((pinned: boolean) => void) | null
  onAutoplay: ((enabled: boolean) => void) | null
}

function Row({ name, about, on, onChange }: { name: string; about: string; on: boolean; onChange: ((on: boolean) => void) | null }) {
  return <div className="mset-row">
    <div><strong>{name}</strong><small>{about}</small></div>
    <button className="mswitch" role="switch" aria-label={name} aria-checked={on} disabled={!onChange} onClick={() => onChange?.(!on)}>
      <i aria-hidden /><b>{on ? '开' : '关'}</b>
    </button>
  </div>
}

const Line = ({ name, value, note }: { name: string; value: string; note?: string }) =>
  <div className="mfact" title={note}><dt>{name}</dt><dd>{value}</dd></div>

/** What the window can be told, and what it runs. The switches are the ones the
 *  bar already has, with the words there is no room for up there; the model and
 *  its service are shown as they are, since both are the application's to run. */
export function Settings({ snapshot: s, options, now, onPin, onAutoplay }: Props) {
  const server = s?.server ?? { state: 'none' as const }
  const bot = s && 'bot' in s.bot ? s.bot.bot : null
  return <div className="mstats msets">
    <section className="mstat">
      <header className="msec-head"><h3>窗口与自动操作</h3></header>
      <div className="mset-rows">
        <Row name="窗口置顶" about="让这个窗口保持在其他窗口之上" on={options.always_on_top} onChange={onPin} />
        <Row name="自动操作" about="允许自动执行模型的动作；关掉后只显示建议" on={!!s?.autoplay_enabled} onChange={s ? onAutoplay : null} />
      </div>
    </section>

    <section className="mstat">
      <header className="msec-head"><h3>模型与服务</h3></header>
      <dl className="mstat-scroll">
        <Line name="Bot" value={bot ?? '未启动'} />
        <Line name="模型" value={server.state === 'ready' ? server.label ?? '—' : '—'} />
        <Line name="模型服务" value={serverLine(s, now)} />
        {factsOf(s, 12).map(fact => <Line key={fact.name} name={fact.name} value={fact.value} note={fact.note} />)}
      </dl>
    </section>

    <section className="mstat">
      <header className="msec-head"><h3>应用</h3></header>
      <dl className="mstat-scroll">
        <Line name="版本" value={options.version ?? '—'} />
        <Line name="平台" value="雀魂" />
        <Line name="游戏视图" value={s?.capture.state === 'running' ? s.capture.descriptor : s?.capture.state === 'error' ? '异常' : '未打开'} />
        <Line name="界面语言" value="简体中文" />
      </dl>
    </section>
  </div>
}
