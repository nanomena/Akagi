// @ts-check
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { policyFor } from '../src/policy.js'

/** @param {string} policy @param {string} name */
const directive = (policy, name) => policy.split('; ').find(part => part.startsWith(name + ' '))?.split(' ').slice(1) ?? []

test('scripts come from the interface\'s own files and nowhere else', () => {
  const policy = policyFor('<!doctype html><script type="module" src="/assets/index.js"></script>')
  const scripts = directive(policy, 'script-src')
  assert.ok(scripts.includes("'self'"))
  // Nothing written into the page runs unless it is named, and no other origin serves scripts.
  assert.ok(!scripts.includes("'unsafe-inline'"))
  assert.ok(!scripts.some(source => /^(https?:|blob:|data:|\*)/.test(source)))
  assert.deepEqual(directive(policy, 'default-src'), ["'self'"])
  assert.deepEqual(directive(policy, 'connect-src'), ["'none'"])
})

test('a script written into the page is allowed by its hash, and only that script', () => {
  const script = "\n  document.documentElement.classList.add('dark')\n"
  const hash = `'sha256-${createHash('sha256').update(script).digest('base64')}'`
  const policy = policyFor(`<head><script>${script}</script></head><body><script type="module" src="/a.js"></script></body>`)
  assert.ok(directive(policy, 'script-src').includes(hash))
  assert.ok(!directive(policyFor('<script>other()</script>'), 'script-src').includes(hash))
})

// tests/smoke.mjs is what shows tiles being drawn; this only keeps the three
// allowances from being tidied away one at a time.
test('what drawing a tile takes is allowed: a worker from a blob, its runtime, an image from data', () => {
  const policy = policyFor('')
  assert.ok(directive(policy, 'worker-src').includes('blob:'))
  assert.ok(directive(policy, 'script-src').includes("'unsafe-eval'"))
  assert.ok(directive(policy, 'img-src').includes('data:'))
})
