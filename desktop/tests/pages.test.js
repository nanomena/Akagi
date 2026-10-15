// @ts-check
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { placeOf, rangeOf } from '../src/pages.js'

const root = path.resolve('stream-pages')

test('a path leads to a file in the folder, or nowhere', () => {
  assert.deepEqual(placeOf(root, ['overlay', 'index.html']), { file: path.join(root, 'overlay', 'index.html'), folder: false })
  assert.deepEqual(placeOf(root, ['overlay', '']), { file: path.join(root, 'overlay'), folder: true })
  assert.deepEqual(placeOf(root, ['']), { file: root, folder: true })
  assert.deepEqual(placeOf(root, ['music', 'Song%20one.mp3']), { file: path.join(root, 'music', 'Song one.mp3'), folder: false })
  for (const escape of [['..', 'secret'], ['%2e%2e', 'secret'], ['a', '..', '..', 'x'], ['.hidden'], ['a%2Fb'], ['a%5Cb'], ['C:'], ['a%00b'], ['a', '', 'b'], ['%E0%A4%A']]) {
    assert.equal(placeOf(root, escape), null, escape.join('/'))
  }
})

test('a range is given as asked, the whole file when it is not one to give, and refused past the end', () => {
  assert.equal(rangeOf(undefined, 100), 'whole')
  assert.deepEqual(rangeOf('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(rangeOf('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(rangeOf('bytes=90-500', 100), { start: 90, end: 99 })
  assert.deepEqual(rangeOf('bytes=-10', 100), { start: 90, end: 99 })
  assert.equal(rangeOf('bytes=0-1,5-6', 100), 'whole')
  assert.equal(rangeOf('items=0-1', 100), 'whole')
  assert.equal(rangeOf('bytes=100-', 100), 'unsatisfiable')
  assert.equal(rangeOf('bytes=9-3', 100), 'unsatisfiable')
})
