import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MonitorSnapshot } from '@/lib/monitor'

const fixture = vi.hoisted(() => ({
  snapshot: null as MonitorSnapshot | null,
  options: { always_on_top: false },
  calls: [] as Array<[string, unknown]>,
}))
vi.mock('@/hooks/useMonitor', () => ({ useMonitor: () => ({ snapshot: fixture.snapshot, error: null }) }))
vi.mock('@/lib/tauri', () => ({
  listen: vi.fn(async () => () => {}),
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    fixture.calls.push([cmd, args])
    if (cmd === 'set_monitor_pinned') fixture.options = { always_on_top: (args as { pinned: boolean }).pinned }
    return cmd === 'get_config' || cmd === 'set_monitor_pinned' ? (cmd === 'get_config' ? { monitor: fixture.options } : fixture.options) : undefined
  }),
}))
// No canvas under jsdom, so mahgen cannot draw. A tile is then an <img> whose
// alt text names it, which is what the assertions read.
vi.mock('@/lib/tileFace', () => ({ faceSeq: (tile: string) => tile, useFace: () => 'data:,' }))
import { Monitor } from './Monitor'

function state(): MonitorSnapshot {
  const context = { game: 1, round: 1, event_seq: 10 }
  return {
    revision: 1, context, names: [], red_fives: true,
    game: null, view: null, round_ended: false, game_ended: false,
    capture: { state: 'running', kind: 'chromium', descriptor: 'test' },
    bot: { state: 'ready', bot: 'demo', actor_id: 0 }, service: 'connected', service_error: null, server: { state: 'none' }, sync_error: null,
    brand: 'Demo', facts: [], autoplay_enabled: true,
    previous_decision: null, result: null, previous_result: null, events: [], last_event_ms: null,
    decision: { id: 1, context, started_ms: Date.now(), completed_ms: Date.now(),
      reaction_ms: 120, bot: 'demo', trigger: { type: 'tsumo', actor: 0, pai: '9m' }, state: 'awaiting', error: null, confirmed_seq: null,
      response: { type: 'dahai', actor: 0, pai: '9m', tsumogiri: true, meta: { show: { items: [
        { label: 'Discard', pais: ['9m'], value: '60.0%' }, { label: 'Discard', pais: ['5pr'], value: '25.0%' },
      ] } } } },
  }
}
const decision = () => screen.getByRole('status').closest('section')!
const candidates = () => screen.queryAllByRole('listitem').filter(li => li.className.includes('mcand'))

describe('monitor user states', () => {
  beforeEach(() => { fixture.snapshot = state(); fixture.options = { always_on_top: false }; fixture.calls = [] })

  it('shows a suggestion the game has not answered yet as pending, never as done', () => {
    render(<Monitor />)
    expect(screen.getByRole('status').textContent).toBe('待确认')
    expect(within(decision()).getByText('打')).toBeTruthy()
    expect(within(decision()).getByText('9万')).toBeTruthy()
    expect(candidates()).toHaveLength(2)
    // Values as reported: two rows of five are not rescaled to 100%.
    expect(candidates().map(li => li.textContent)).toEqual(['1打模型选择60.0%', '2打25.0%'])
    expect(within(candidates()[1]).getByRole('img', { name: '赤5筒' })).toBeTruthy()
  })

  it('does not mistake a ready Bot process for a connected model service', () => {
    fixture.snapshot!.service = 'error'; fixture.snapshot!.service_error = 'Socket closed'
    fixture.snapshot!.decision!.state = 'expired'
    render(<Monitor />)
    const status = screen.getByRole('button', { name: '连接状态' })
    expect(within(status).getByText('断开')).toBeTruthy()
    expect(status.textContent).toContain('Bot')
    expect(screen.getByRole('alert').textContent).toContain('模型服务断开')
    // The action stays as history; its candidates do not stay as current ones.
    expect(screen.getByRole('status').textContent).toBe('已失效')
    expect(within(decision()).getByText('9万')).toBeTruthy()
    expect(candidates()).toHaveLength(0)
  })

  it('keeps the confirmed action as history but drops its candidates at round end', () => {
    fixture.snapshot!.decision!.state = 'confirmed'
    fixture.snapshot!.round_ended = true
    render(<Monitor />)
    expect(screen.getByRole('status').textContent).toBe('已确认')
    expect(screen.getByText('上一决策')).toBeTruthy()
    expect(candidates()).toHaveLength(0)
    expect(screen.getByText('本局已结束，候选不再有效')).toBeTruthy()
  })

  it('names the move the game made instead when it contradicts the suggestion', () => {
    const s = fixture.snapshot!
    s.events = [{ seq: 11, ts_ms: Date.now(), event: { type: 'dahai', actor: 0, pai: '1s', tsumogiri: false } }]
    s.decision = { ...s.decision!, state: 'expired', error: 'The game confirmed a different action.' }
    render(<Monitor />)
    expect(screen.getByRole('status').textContent).toBe('不一致')
    const actual = screen.getByText('雀魂实际').parentElement!
    expect(within(actual).getByText('1索')).toBeTruthy()
    // What the model weighed stays as a record, marked void — not as a live suggestion.
    expect(candidates()).toHaveLength(2)
    expect(candidates()[0].closest('section')!.getAttribute('data-state')).toBe('void')
    expect(screen.getByText(/已失效/)).toBeTruthy()
  })

  it('points at the candidate the game took when it is one of those listed', () => {
    const s = fixture.snapshot!
    s.events = [{ seq: 11, ts_ms: Date.now(), event: { type: 'dahai', actor: 0, pai: '5pr', tsumogiri: false } }]
    s.decision = { ...s.decision!, state: 'expired', error: 'The game confirmed a different action.' }
    render(<Monitor />)
    expect(candidates().map(li => li.textContent)).toEqual(['1打模型选择60.0%', '2打雀魂实际25.0%'])
  })

  it('keeps the decision in place on every tab of the dock', () => {
    render(<Monitor />)
    for (const name of ['牌桌', '结果', '事件', '连接']) {
      fireEvent.click(screen.getByRole('tab', { name }))
      expect(screen.getByRole('status').textContent).toBe('待确认')
      expect(within(decision()).getByText('9万')).toBeTruthy()
    }
    expect(screen.getByText('牌局同步')).toBeTruthy()
  })

  it('shows no action and no candidates while the model is still being asked', () => {
    fixture.snapshot!.decision = { ...fixture.snapshot!.decision!, state: 'thinking', response: null, reaction_ms: null, completed_ms: null }
    render(<Monitor />)
    expect(screen.getByRole('status').textContent).toBe('推理中')
    expect(within(decision()).queryByText('9万')).toBeNull()
    expect(candidates()).toHaveLength(0)
  })

  it('offers autoplay as a switch that says what is allowed, and flips it through the backend', async () => {
    render(<Monitor />)
    const auto = screen.getByRole('switch', { name: /自动操作/ })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    expect(auto.getAttribute('title')).toMatch(/允许自动执行/)
    await waitFor(() => expect((auto as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(auto)
    expect(fixture.calls).toContainEqual(['set_monitor_autoplay', { enabled: false }])
    // The switch shows what the backend reports, not what was just clicked.
    expect(auto.getAttribute('aria-checked')).toBe('true')
  })

  it('opens the game in the window by itself, once, when nothing is being played', async () => {
    const stage = { x: 0, y: 0, width: 960, height: 540 }
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...stage, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => stage } as DOMRect)
    fixture.snapshot = { ...state(), decision: null, game_ended: true, round_ended: true }
    const { rerender } = render(<Monitor />)
    await waitFor(() => expect(fixture.calls.some(([cmd]) => cmd === 'open_monitor_game')).toBe(true))
    rerender(<Monitor />)
    expect(fixture.calls.filter(([cmd]) => cmd === 'open_monitor_game')).toEqual([['open_monitor_game', { bounds: { ...stage, visible: true } }]])
    rect.mockRestore()
  })

  it('does not open a second game while one is being played elsewhere', async () => {
    render(<Monitor />)
    await waitFor(() => expect((screen.getByRole('button', { name: '置顶' }) as HTMLButtonElement).disabled).toBe(false))
    expect(fixture.calls.some(([cmd]) => cmd === 'open_monitor_game')).toBe(false)
  })

  it('shows a partial draw reveal without filling in the seats that stayed hidden', () => {
    fixture.snapshot!.round_ended = true
    fixture.snapshot!.result = { kind: 'exhaustive', scores: null, deltas: null,
      hands: [{ seat: 1, tiles: ['5pr', 'P'], winning_tile: null, target: null, ura_markers: [] }] }
    render(<Monitor />)
    expect(screen.getByText('荒牌流局')).toBeTruthy()
    expect(screen.getByText('座位 2')).toBeTruthy()
    expect(screen.getAllByText('公开手牌')).toHaveLength(1)
    expect(screen.queryByText('座位 3')).toBeNull()
  })

  it('shows a winning tile once, apart from the hand it completed', () => {
    fixture.snapshot!.round_ended = true
    fixture.snapshot!.result = { kind: 'hora', scores: [24000, 26000], deltas: [-1000, 1000],
      hands: [{ seat: 1, tiles: ['1m', '1m'], winning_tile: 'C', target: 1, ura_markers: [] }] }
    render(<Monitor />)
    const reveal = screen.getByText('自摸').closest('.mreveal') as HTMLElement
    expect(within(reveal).getAllByRole('img').map(img => img.getAttribute('alt'))).toEqual(['1万', '1万', '中'])
    expect(screen.getByText('+1,000')).toBeTruthy()
  })

  it('is one window with one control of its own: staying on top', async () => {
    render(<Monitor />)
    const pin = screen.getByRole('button', { name: '置顶' })
    await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(false))
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    await waitFor(() => expect(pin.getAttribute('aria-pressed')).toBe('true'))
    expect(fixture.calls).toContainEqual(['set_monitor_pinned', { pinned: true }])
    // No second shape to fold into, and no other window to go to.
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
    expect(screen.queryByRole('button', { name: '主界面' })).toBeNull()
  })

  it('puts the game exactly where the stage is once it is open in this window', async () => {
    fixture.snapshot!.capture = { state: 'running', kind: 'chromium', descriptor: 'chromium (embedded WebView2)' }
    const stage = { x: 0, y: 0, width: 960, height: 540 }
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.className === 'mon-stage' ? { ...stage, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => stage } : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect
    })
    render(<Monitor />)
    await waitFor(() => expect(fixture.calls.some(([cmd]) => cmd === 'resize_monitor_game')).toBe(true))
    expect(fixture.calls.filter(([cmd]) => cmd === 'resize_monitor_game').at(-1)![1]).toEqual({ bounds: { ...stage, visible: true } })
    rect.mockRestore()
  })
})
