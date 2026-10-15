// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameSource } from '../src/frames.js'

const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms))
/** @param {() => boolean} ready */
async function until(ready, ms = 1000) {
  for (const end = Date.now() + ms; Date.now() < end && !ready();) await sleep(2)
  assert.ok(ready(), 'waited too long')
}

/**
 * A stand-in for Electron's debugger: screenshots wait until the test answers them.
 * @param {{ attached?: boolean }} [given]
 */
function tools({ attached = false } = {}) {
  /** @type {Array<[string, any]>} */
  const sent = []
  /** @type {Array<{ done: (value: { data: string }) => void, fail: (error: Error) => void }>} */
  const shots = []
  let on = attached
  let attaches = 0
  let detaches = 0
  return {
    sent, shots,
    get attaches() { return attaches },
    get detaches() { return detaches },
    attach() { if (on) throw new Error('Debugger is already attached.'); on = true; attaches++ },
    detach() { on = false; detaches++; for (const shot of shots.splice(0)) shot.fail(new Error('detached')) },
    isAttached: () => on,
    /** @param {string} method @param {any} [params] @returns {Promise<any>} */
    sendCommand(method, params) {
      sent.push([method, params])
      if (method !== 'Page.captureScreenshot') return Promise.resolve({})
      return new Promise((done, fail) => shots.push({ done, fail }))
    },
    /** Answer the oldest screenshot still waiting. @param {string} text */
    answer(text, index = 0) { shots.splice(index, 1)[0].done({ data: Buffer.from(text).toString('base64') }) },
    asked: () => sent.filter(([method]) => method === 'Page.captureScreenshot').length,
  }
}

test('frames are screenshots of the page as it is, and nothing else is asked of it', async () => {
  const debug = tools()
  /** @type {string[]} */
  const frames = []
  const source = new FrameSource(debug, { onFrame: jpeg => frames.push(String(jpeg)), fps: 500 })
  source.start()
  await until(() => debug.shots.length > 0)
  assert.equal(debug.attaches, 1)
  debug.answer('one')
  await until(() => frames.length === 1)
  assert.deepEqual(frames, ['one'])
  source.stop()
  // No scale, size or any other state is set on the page: the window stays exactly as it is.
  assert.ok(debug.sent.length > 0)
  for (const [method, params] of debug.sent) {
    assert.equal(method, 'Page.captureScreenshot')
    assert.equal(params.format, 'jpeg')
    assert.equal(params.clip, undefined)
  }
})

test('no more screenshots are in flight than the depth allows, and none faster than the rate', async () => {
  const debug = tools()
  const source = new FrameSource(debug, { onFrame: () => {}, fps: 1000, depth: 3 })
  source.start()
  await sleep(60)
  assert.equal(debug.shots.length, 3)
  debug.answer('a')
  await until(() => debug.shots.length === 3)
  source.stop()

  const slow = tools()
  const paced = new FrameSource(slow, { onFrame: () => {}, fps: 20, depth: 3 })
  paced.start()
  for (let i = 0; i < 12; i++) {
    await sleep(25)
    while (slow.shots.length) slow.answer('x')
  }
  paced.stop()
  // 300 ms at 20 a second: six or seven, never the dozen there was room for.
  assert.ok(slow.asked() >= 5 && slow.asked() <= 8, `${slow.asked()} screenshots`)
})

test('a screenshot that comes back after a later one is dropped', async () => {
  const debug = tools()
  /** @type {string[]} */
  const frames = []
  const source = new FrameSource(debug, { onFrame: jpeg => frames.push(String(jpeg)), fps: 1000, depth: 2 })
  source.start()
  await until(() => debug.shots.length === 2)
  debug.answer('later', 1)
  debug.answer('earlier', 0)
  await sleep(10)
  assert.deepEqual(frames, ['later'])
  source.stop()
})

test('stopping lets the session go, and nothing outstanding is delivered after', async () => {
  const debug = tools()
  /** @type {string[]} */
  const frames = []
  const source = new FrameSource(debug, { onFrame: jpeg => frames.push(String(jpeg)), fps: 1000 })
  source.start()
  await until(() => debug.shots.length > 0)
  const waiting = debug.shots[0]
  source.stop()
  assert.equal(debug.detaches, 1)
  assert.equal(debug.isAttached(), false)
  waiting.done({ data: Buffer.from('late').toString('base64') })
  await sleep(10)
  assert.deepEqual(frames, [])
  assert.equal(source.running, false)

  // Started again, it begins a session of its own.
  source.start()
  await until(() => debug.attaches === 2 && debug.shots.length > 0)
  source.stop()
})

test('a session someone else holds is used, and left to them', async () => {
  const debug = tools({ attached: true })
  const source = new FrameSource(debug, { onFrame: () => {}, fps: 1000 })
  source.start()
  await until(() => debug.shots.length > 0)
  assert.equal(debug.attaches, 0)
  source.stop()
  assert.equal(debug.detaches, 0)
  assert.equal(debug.isAttached(), true)
})

test('when screenshots stop coming back, the session is begun anew', async () => {
  const debug = tools()
  /** @type {string[]} */
  const said = []
  const source = new FrameSource(debug, { onFrame: () => {}, fps: 1000, depth: 2, stallMs: 40, log: message => said.push(message) })
  source.start()
  await until(() => debug.attaches === 2, 2000)
  assert.equal(debug.detaches, 1)
  assert.ok(said.some(message => /stalled/.test(message)))
  source.stop()
})
