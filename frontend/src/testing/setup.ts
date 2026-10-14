import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Vitest runs with `globals: false`, so Testing Library's auto-cleanup (which
// hooks a global `afterEach`) never registers. Do it explicitly.
afterEach(cleanup)

// The page's texts are asserted as they are written, in Chinese — whatever
// language jsdom says its browser prefers. Set before any module of the page
// has been loaded and has looked.
localStorage.setItem('akagi.language', 'zh-CN')

// jsdom ships no ResizeObserver, which the monitor page uses to follow its stage.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
