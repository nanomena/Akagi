// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN, RATIO, SIZE, conform, framedRatio, gameBounds, openingSize, restoredBounds, settle, trailBounds } from '../src/layout.js'

test('a fresh window opens at its own size, or as much of it as the display has room for', () => {
  assert.deepEqual(openingSize({ width: 2560, height: 1400 }), SIZE)
  const small = openingSize({ width: 1280, height: 720 })
  assert.equal(small.width / small.height, RATIO)
  assert.ok(small.height <= 720 * 0.84 || small.height === MIN.height)
  assert.deepEqual(openingSize({ width: 640, height: 480 }), MIN)
})

test('a size is brought to the ratio by its width, and never under the floor', () => {
  assert.deepEqual(conform({ width: 1000, height: 10 }), { width: 1000, height: 750 })
  assert.deepEqual(conform({ width: 100, height: 100 }), MIN)
})

test('a resize settles on the ratio along the dimension that was dragged', () => {
  const before = { width: 1200, height: 900 }
  assert.deepEqual(settle(before, { width: 1400, height: 900 }), { width: 1400, height: 1050 })
  assert.deepEqual(settle(before, { width: 1200, height: 1050 }), { width: 1400, height: 1050 })
  assert.deepEqual(settle(before, { width: 1000, height: 800 }), { width: 1000, height: 750 })
  assert.deepEqual(settle(before, before), before)
})

test('the ratio asked of a framed window puts its content on the canvas ratio', () => {
  const border = { width: 16, height: 39 }
  for (const width of [880, 1200, 1777]) {
    const ratio = framedRatio(width, border)
    const outerHeight = (width + border.width) / ratio
    assert.ok(Math.abs((outerHeight - border.height) - width / RATIO) < 1e-9)
  }
  assert.equal(framedRatio(1200, { width: 0, height: 0 }), RATIO)
})

test('the window returns to where it was left only if all of it can still be seen', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 2560, height: 1400 }]
  assert.deepEqual(restoredBounds({ x: 100, y: 50, width: 1200, height: 900 }, displays), { x: 100, y: 50, width: 1200, height: 900 })
  assert.deepEqual(restoredBounds({ x: 2000, y: 10, width: 1600, height: 999 }, displays), { x: 2000, y: 10, width: 1600, height: 1200 })
  assert.equal(restoredBounds({ x: 1500, y: 50, width: 1200, height: 900 }, displays), null, 'across two displays')
  assert.equal(restoredBounds({ x: 5000, y: 50, width: 1200, height: 900 }, displays), null, 'on a display that is gone')
  assert.equal(restoredBounds({ x: 'left', y: 0, width: 1200, height: 900 }, displays), null)
  assert.equal(restoredBounds(null, displays), null)
})

test('the game view goes only where a sound rectangle says', () => {
  assert.deepEqual(gameBounds({ x: 0.4, y: 0, width: 1199.6, height: 675.2 }), { x: 0, y: 0, width: 1200, height: 675, visible: true })
  assert.equal(gameBounds({ x: 0, y: 0, width: 160, height: 160, visible: false }).visible, false)
  for (const bad of [null, {}, { x: -1, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 99, height: 200 }, { x: 0, y: 0, width: 200, height: 20000 }, { x: 0, y: 0, width: Infinity, height: 200 }, { x: '0', y: 0, width: 200, height: 200 }]) {
    assert.throws(() => gameBounds(bad), /Invalid game view bounds/)
  }
})

test('the pointer trail lies exactly over the game view, wherever the window is', () => {
  const game = { x: 0, y: 0, width: 1200, height: 675 }
  assert.deepEqual(trailBounds({ x: 100, y: 50, width: 1200, height: 900 }, game), { x: 100, y: 50, width: 1200, height: 675 })
  assert.deepEqual(trailBounds({ x: -1800, y: 20, width: 1200, height: 900 }, { ...game, x: 8 }), { x: -1792, y: 20, width: 1200, height: 675 })
})
