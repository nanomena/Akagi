// @ts-check
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { AT_ONCE, Relay, SpoutTaker, pageTaker } from '../src/relay.js'

const SIZE = { width: 2560, height: 1440 }

/** A frame as Electron lends it, counting how often it is given back. */
function texture({ widgetType = 'frame', size = SIZE, handle = 0x1234n } = {}) {
  const ntHandle = Buffer.alloc(8)
  ntHandle.writeBigUInt64LE(handle)
  const t = { released: 0, textureInfo: { widgetType, codedSize: size, handle: { ntHandle } }, release() { t.released++ } }
  return t
}

/** A taker that keeps what it is given until told. */
function holder(name = 'held') {
  /** @type {Array<() => void>} */
  const out = []
  return { name, out, busy: () => out.length >= AT_ONCE, take: (/** @type {any} */ _t, /** @type {() => void} */ done) => { out.push(done) } }
}

test('a frame nobody takes goes straight back', () => {
  const relay = new Relay({ expected: SIZE })
  const t = texture()
  relay.paint(t)
  assert.equal(t.released, 1)
})

test('a frame goes back once every taker is done with it, and only once', () => {
  const relay = new Relay({ expected: SIZE })
  const a = holder('a'), b = holder('b')
  relay.add(a)
  relay.add(b)
  const t = texture()
  relay.paint(t)
  assert.equal(t.released, 0)
  a.out[0]()
  a.out[0]()
  assert.equal(t.released, 0, 'one taker being done twice is still one')
  b.out[0]()
  assert.equal(t.released, 1)
})

test('a taker with two frames out is passed over, and the others still get the frame', () => {
  const relay = new Relay({ expected: SIZE })
  const slow = holder('slow'), quick = { name: 'quick', busy: () => false, take: (/** @type {any} */ _t, /** @type {() => void} */ done) => done() }
  relay.add(slow)
  relay.add(quick)
  const frames = [texture(), texture(), texture()]
  frames.forEach(t => relay.paint(t))
  assert.equal(slow.out.length, AT_ONCE)
  assert.equal(frames[2].released, 1, 'the third went back without the slow taker')
  assert.equal(relay.passed, 1)
})

test('a taker that throws is done with the frame', () => {
  const messages = /** @type {string[]} */ ([])
  const relay = new Relay({ expected: SIZE, log: m => messages.push(m) })
  relay.add({ name: 'broken', busy: () => false, take: () => { throw new Error('no') } })
  const t = texture()
  relay.paint(t)
  assert.equal(t.released, 1)
  assert.match(messages[0], /broken: no/)
})

test('popups are not passed on, and a frame of the wrong size is said once', () => {
  const sizes = /** @type {Array<{ width: number, height: number }>} */ ([])
  const relay = new Relay({ expected: SIZE, onSize: size => sizes.push(size) })
  const popup = texture({ widgetType: 'popup' })
  relay.paint(popup)
  assert.equal(popup.released, 1)
  assert.equal(relay.frames, 0)
  relay.paint(texture({ size: { width: 2562, height: 1444 } }))
  relay.paint(texture({ size: { width: 2562, height: 1444 } }))
  relay.paint(texture())
  relay.paint(texture({ size: { width: 2562, height: 1444 } }))
  assert.deepEqual(sizes, [{ width: 2562, height: 1444 }, { width: 2562, height: 1444 }])
})

test('the monitor gets each frame imported, and lets its reference go once sent', async () => {
  /** @type {any[]} */
  const sent = []
  let releasedImports = 0
  const fake = {
    importSharedTexture: (/** @type {any} */ options) => ({ options, release: () => { releasedImports++ } }),
    sendSharedTexture: async (/** @type {any} */ options) => { sent.push(options) },
  }
  const frame = /** @type {any} */ ({ main: true })
  const taker = pageTaker({ sharedTexture: /** @type {any} */ (fake), frame: () => frame })
  const relay = new Relay({ expected: SIZE })
  relay.add(taker)
  const t = texture()
  relay.paint(t)
  await new Promise(done => setImmediate(done))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].frame, frame)
  assert.equal(releasedImports, 1)
  // The texture goes back when every reference is released, which Electron says by calling back.
  assert.equal(t.released, 0)
  sent[0].importedSharedTexture.options.allReferencesReleased()
  assert.equal(t.released, 1)
})

test('without a page to send to, the monitor takes nothing', () => {
  const taker = pageTaker({ sharedTexture: /** @type {any} */ ({}), frame: () => null })
  assert.equal(taker.busy(), true)
})

/** A sender process that answers as the real one does, or not at all. */
function fakeProcess({ answer = true } = {}) {
  const child = /** @type {any} */ (new EventEmitter())
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  /** @type {string[]} */
  child.lines = []
  child.stdin.on('data', (/** @type {Buffer} */ data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      child.lines.push(line)
      if (answer) child.stdout.write(`${line.split(' ')[0]} ok\n`)
    }
  })
  child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0)))
  return child
}

test('the Spout sender is told each frame by its handle and size, and the frame goes back on its answer', async () => {
  const child = fakeProcess()
  /** @type {any[]} */
  const spawned = []
  const states = /** @type {string[]} */ ([])
  const spout = new SpoutTaker({ exe: 'spout-sender.exe', pid: 42, sender: 'Akagi', spawn: /** @type {any} */ ((/** @type {any[]} */ ...args) => { spawned.push(args); return child }), onState: s => states.push(s) })
  assert.deepEqual(spawned[0].slice(0, 2), ['spout-sender.exe', ['42', '--name', 'Akagi']])
  child.stderr.write('sending as "Akagi"\n')
  await new Promise(done => setImmediate(done))
  assert.deepEqual(states, ['sending'])
  const relay = new Relay({ expected: SIZE })
  relay.add(spout)
  const t = texture({ handle: 0xABCDn })
  relay.paint(t)
  await new Promise(done => setTimeout(done, 20))
  assert.equal(child.lines[0], `1 ${0xABCD} 2560 1440`)
  assert.equal(t.released, 1)
  spout.stop()
  assert.equal(spout.state, 'stopped')
})

test('frames the Spout sender never answers for go back when it stops', async () => {
  const child = fakeProcess({ answer: false })
  const spout = new SpoutTaker({ exe: 'x', pid: 1, sender: 'Akagi', spawn: /** @type {any} */ (() => child) })
  const relay = new Relay({ expected: SIZE })
  relay.add(spout)
  const a = texture(), b = texture(), c = texture()
  relay.paint(a)
  relay.paint(b)
  assert.equal(spout.busy(), true)
  relay.paint(c)
  assert.equal(c.released, 1, 'passed over while two are out')
  spout.stop()
  assert.equal(a.released + b.released, 2)
})

test('a sender that ends is started again, and its frames go back', async () => {
  /** @type {any[]} */
  const children = []
  const spout = new SpoutTaker({ exe: 'x', pid: 1, sender: 'Akagi', spawn: /** @type {any} */ (() => { const c = fakeProcess({ answer: false }); children.push(c); return c }) })
  const relay = new Relay({ expected: SIZE })
  relay.add(spout)
  const t = texture()
  relay.paint(t)
  children[0].emit('exit', 1)
  assert.equal(t.released, 1)
  assert.equal(spout.state, 'failed')
  assert.equal(spout.busy(), true, 'nothing is sent while it is down')
  await new Promise(done => setTimeout(done, 1100))
  assert.equal(children.length, 2)
  spout.stop()
})
