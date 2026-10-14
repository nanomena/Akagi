import { factsOf, serverLine, type MonitorConfig, type MonitorSnapshot } from '@/lib/monitor'
import { LANGS, setLang, tr, useLang, type Lang } from '@/lib/i18n'

type Props = {
  snapshot: MonitorSnapshot | null
  options: MonitorConfig
  now: number
  /** `null` while the window's own options have not been read, or are being written. */
  onPin: ((pinned: boolean) => void) | null
  onAutoplay: ((enabled: boolean) => void) | null
  onTrail: ((enabled: boolean) => void) | null
}

function Row({ name, about, on, onChange }: { name: string; about: string; on: boolean; onChange: ((on: boolean) => void) | null }) {
  return <div className="mset-row">
    <div><strong>{name}</strong><small>{about}</small></div>
    <button className="mswitch" role="switch" aria-label={name} aria-checked={on} disabled={!onChange} onClick={() => onChange?.(!on)}>
      <i aria-hidden /><b data-other={on ? tr('关') : tr('开')}>{on ? tr('开') : tr('关')}</b>
    </button>
  </div>
}

const Line = ({ name, value, note }: { name: string; value: string; note?: string }) =>
  <div className="mfact" title={note}><dt>{name}</dt><dd>{value}</dd></div>

/** What the window can be told, and what it runs. The switches are the ones the
 *  bar already has, with the words there is no room for up there; the model and
 *  its service are shown as they are, since both are the application's to run. */
export function Settings({ snapshot: s, options, now, onPin, onAutoplay, onTrail }: Props) {
  const server = s?.server ?? { state: 'none' as const }
  const bot = s && 'bot' in s.bot ? s.bot.bot : null
  const lang = useLang()
  return <div className="mstats msets">
    <section className="mstat">
      <header className="msec-head"><h3>{tr('窗口与自动操作')}</h3></header>
      <div className="mset-rows">
        <Row name={tr('窗口置顶')} about={tr('让这个窗口保持在其他窗口之上')} on={options.always_on_top} onChange={onPin} />
        <Row name={tr('自动操作')} about={tr('关掉后只显示建议，不替你操作')} on={!!s?.autoplay_enabled} onChange={s ? onAutoplay : null} />
        <Row name={tr('光标轨迹')} about={tr('在游戏画面上画出自动操作的光标和点击')} on={!!options.pointer_trail} onChange={onTrail} />
        <div className="mset-row">
          <div><strong>{tr('界面语言')}</strong><small>{tr('只改变这个窗口里的文字')}</small></div>
          {/* Each language under its own name, whatever language is showing. */}
          <select className="mselect" aria-label={tr('界面语言')} value={lang} onChange={e => setLang(e.target.value as Lang)}>
            {LANGS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
      </div>
    </section>

    <section className="mstat">
      <header className="msec-head"><h3>{tr('模型与服务')}</h3></header>
      <dl className="mstat-scroll">
        <Line name="Bot" value={bot ?? tr('未启动')} />
        <Line name={tr('模型')} value={server.state === 'ready' ? server.label ?? '—' : '—'} />
        {/* Longer than its cell once the server is up: the whole of it is there on hover. */}
        <Line name={tr('模型服务')} value={serverLine(s, now)} note={serverLine(s, now)} />
        {factsOf(s, 12).map(fact => <Line key={fact.name} name={fact.name} value={fact.value} note={fact.note} />)}
      </dl>
    </section>

    <section className="mstat">
      <header className="msec-head"><h3>{tr('应用')}</h3></header>
      <dl className="mstat-scroll">
        <Line name={tr('版本')} value={options.version ?? '—'} />
        <Line name={tr('平台')} value={tr('雀魂')} />
        <Line name={tr('游戏视图')} value={s?.capture.state === 'running' ? s.capture.descriptor : s?.capture.state === 'error' ? tr('异常') : tr('未打开')} />
      </dl>
    </section>
  </div>
}
