// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEXT_MAX, keyCode, toGame } from '../src/input.js'
import { onGame, onView } from '../src/layout.js'

const PAGE = { width: 1280, height: 720 }

test('a press is a press of the button named, at the point given, on the page', () => {
  assert.deepEqual(toGame({ type: 'down', x: 301.4, y: 350.6, button: 2, count: 1 }, PAGE),
    { event: { type: 'mouseDown', x: 301, y: 351, button: 'right', clickCount: 1, modifiers: [] } })
  assert.deepEqual(toGame({ type: 'up', x: 10, y: 10, button: 0, count: 2, mods: { shift: true } }, PAGE),
    { event: { type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 2, modifiers: ['shift'] } })
})

test('a move with buttons held says so, as a drag needs', () => {
  assert.deepEqual(/** @type {any} */ (toGame({ type: 'move', x: 5, y: 6, buttons: 1 | 4 }, PAGE)).event.modifiers, ['leftbuttondown', 'middlebuttondown'])
  assert.deepEqual(/** @type {any} */ (toGame({ type: 'move', x: 5, y: 6, buttons: 0 }, PAGE)).event.modifiers, [])
})

test('points are kept on the page, and nonsense is dropped', () => {
  assert.deepEqual(toGame({ type: 'move', x: -20, y: 9999 }, PAGE), { event: { type: 'mouseMove', x: 0, y: 720, modifiers: [] } })
  assert.equal(toGame({ type: 'move', x: 'a', y: 1 }, PAGE), null)
  assert.equal(toGame({ type: 'move', x: NaN, y: 1 }, PAGE), null)
  assert.equal(toGame({ type: 'drop', x: 1, y: 1 }, PAGE), null)
  assert.equal(toGame(null, PAGE), null)
  assert.equal(toGame('down', PAGE), null)
})

test('the wheel turns the way it turned: a DOM delta is down-positive, Electron\'s up-positive', () => {
  assert.deepEqual(toGame({ type: 'wheel', x: 640, y: 360, dx: 0, dy: 120 }, PAGE),
    { event: { type: 'mouseWheel', x: 640, y: 360, deltaX: -0, deltaY: -120, canScroll: true, modifiers: [] } })
})

test('keys that do something are passed on as keys; text is not', () => {
  assert.equal(keyCode('Enter', {}), 'Enter')
  assert.equal(keyCode('ArrowLeft', {}), 'Left')
  assert.equal(keyCode(' ', {}), 'Space')
  assert.equal(keyCode('a', {}), null)
  assert.equal(keyCode('a', { shift: true }), null)
  assert.equal(keyCode('a', { ctrl: true }), 'A')
  assert.equal(keyCode('1', { meta: true }), '1')
  assert.equal(keyCode('雀', { ctrl: true }), null)
  assert.equal(keyCode('', {}), null)
  assert.deepEqual(toGame({ type: 'keydown', key: 'Backspace' }, PAGE), { event: { type: 'keyDown', keyCode: 'Backspace', modifiers: [] } })
  assert.deepEqual(toGame({ type: 'keyup', key: 'c', mods: { ctrl: true } }, PAGE), { event: { type: 'keyUp', keyCode: 'C', modifiers: ['control'] } })
  assert.equal(toGame({ type: 'keydown', key: 'x' }, PAGE), null)
})

test('text is inserted as it was typed or composed, up to a limit', () => {
  assert.deepEqual(toGame({ type: 'text', text: '雀魂 b@c.d' }, PAGE), { text: '雀魂 b@c.d' })
  assert.equal(toGame({ type: 'text', text: '' }, PAGE), null)
  assert.equal(toGame({ type: 'text', text: 42 }, PAGE), null)
  assert.equal(/** @type {any} */ (toGame({ type: 'text', text: 'x'.repeat(TEXT_MAX + 5) }, PAGE)).text.length, TEXT_MAX)
  assert.deepEqual(toGame({ type: 'paste' }, PAGE), { paste: true })
})

test('the system cursor over the monitor\'s picture is a point on the offscreen page', () => {
  const area = { x: 100, y: 50, width: 640, height: 360 }
  assert.deepEqual(onGame({ x: 420, y: 230 }, area, PAGE), { x: 640, y: 360 })
  assert.deepEqual(onGame({ x: 420, y: 230 }, area), { x: 320, y: 180 }, 'the view is the page itself without a page size')
  assert.equal(onGame({ x: 99, y: 230 }, area, PAGE), null)
})

test('a point on the page is drawn where the picture shows it', () => {
  assert.deepEqual(onView({ x: 640, y: 360, down: true }, { width: 640, height: 360 }, PAGE), { x: 320, y: 180, down: true })
  const mark = { x: 1, y: 2 }
  assert.equal(onView(mark, { width: 640, height: 360 }, null), mark)
})
