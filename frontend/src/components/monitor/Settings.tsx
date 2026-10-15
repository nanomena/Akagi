import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { serverLine, type MonitorConfig, type MonitorSnapshot } from '@/lib/monitor'
import { LANGS, setLang, tr, useLang, type Lang } from '@/lib/i18n'

type Props = {
  snapshot: MonitorSnapshot | null
  options: MonitorConfig
  now: number
  /** `null` while the window's own options have not been read, or are being written. */
  onPin: ((pinned: boolean) => void) | null
  onAutoplay: ((enabled: boolean) => void) | null
  onTrail: ((enabled: boolean) => void) | null
  onLean: ((enabled: boolean) => void) | null
  onStream: ((enabled: boolean) => void) | null
  /** Put the stream's address on the clipboard. */
  onCopyStream: (() => Promise<void>) | null
}

const Switch = ({ name, on, onChange }: { name: string; on: boolean; onChange: ((on: boolean) => void) | null }) =>
  <button className="mswitch" role="switch" aria-label={name} aria-checked={on} disabled={!onChange} onClick={() => onChange?.(!on)}>
    <i aria-hidden /><b data-other={on ? tr('关') : tr('开')}>{on ? tr('开') : tr('关')}</b>
  </button>

function Row({ name, about, on, onChange }: { name: string; about: string; on: boolean; onChange: ((on: boolean) => void) | null }) {
  return <div className="mset-row">
    <div><strong>{name}</strong><small>{about}</small></div>
    <Switch name={name} on={on} onChange={onChange} />
  </div>
}

/** The game, and only the game, offered to a streaming program on this
 *  computer. Once it is on, the line under the name is the address to give
 *  that program, with a button to copy it in a place that is there either way. */
function StreamRow({ options, onChange, onCopy }: { options: MonitorConfig; onChange: ((on: boolean) => void) | null; onCopy: (() => Promise<void>) | null }) {
  const name = tr('直播输出')
  const url = options.stream_output ? options.stream_url ?? '' : ''
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const done = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(done)
  }, [copied])
  const copy = tr('复制直播地址')
  return <div className="mset-row mset-row--stream">
    <div><strong>{name}</strong><small title={url || undefined}>{url || tr('只把游戏画面交给 OBS')}</small></div>
    <button className="mtool mset-copy" aria-label={copy} title={copied ? tr('已复制') : copy} data-empty={!url || undefined} disabled={!url || !onCopy}
      onClick={() => void onCopy?.().then(() => setCopied(true), () => {})}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
    <Switch name={name} on={!!options.stream_output} onChange={onChange} />
  </div>
}

const Line = ({ name, value, note }: { name: string; value: string; note?: string }) =>
  <div className="mfact" title={note}><dt>{name}</dt><dd>{value}</dd></div>

/** What the window can be told, and what it runs. The switches are the ones the
 *  bar already has, with the words there is no room for up there; the model and
 *  its service are shown as they are, since both are the application's to run. */
export function Settings({ snapshot: s, options, now, onPin, onAutoplay, onTrail, onLean, onStream, onCopyStream }: Props) {
  const server = s?.server ?? { state: 'none' as const }
  const bot = s && 'bot' in s.bot ? s.bot.bot : null
  // The model service runs from the app's start; the bot itself joins each game as it starts.
  const waiting = !bot && server.state !== 'none' ? server.bot : null
  const lang = useLang()
  return <div className="mstats msets">
    <section className="mstat">
      <header className="msec-head"><h3>{tr('窗口与自动操作')}</h3></header>
      <div className="mset-rows">
        <Row name={tr('窗口置顶')} about={tr('让这个窗口保持在其他窗口之上')} on={options.always_on_top} onChange={onPin} />
        <Row name={tr('自动操作')} about={tr('关掉后只显示建议，不替你操作')} on={!!s?.autoplay_enabled} onChange={s ? onAutoplay : null} />
        <Row name={tr('光标轨迹')} about={tr('在游戏画面上画出自动操作的光标和点击')} on={!!options.pointer_trail} onChange={onTrail} />
        <Row name={tr('预推理')} about={tr('别家行动时，光标停在下一手可能要打的牌上')} on={!!options.pointer_lean} onChange={onLean} />
        <StreamRow options={options} onChange={onStream} onCopy={onCopyStream} />
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
        <Line name="Bot" value={bot ?? (waiting ? tr('{0} · 对局开始时连接', waiting) : tr('未启动'))} />
        <Line name={tr('模型')} value={server.state === 'ready' ? server.label ?? '—' : '—'} />
        {/* Longer than its cell once the server is up: the whole of it is there on hover. */}
        {/* The model's name is the line above. */}
        <Line name={tr('模型服务')} value={serverLine(s, now, false)} note={serverLine(s, now, false)} />
        {/* What the service was started with first; what goes with the latest decision after. */}
        {[...(server.state === 'ready' ? server.facts : []), ...(s?.facts ?? [])].slice(0, 12)
          .map(fact => <Line key={fact.name} name={fact.name} value={fact.value} note={fact.note} />)}
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
