// The words on screen, in the language chosen.
//
// The page is written in Simplified Chinese, and that text is the key: `tr('对局开始')`
// reads as what it says, returns itself in Chinese, and is looked up in the chosen
// language's table otherwise. A text with no entry stays as written rather than
// going blank. Values go in by position — `tr('另有 {0} 项', n)` — so a translation
// can put them where its grammar wants them.
//
// A table of words defined once, outside any function, would be read in whatever
// language was set when the module loaded; `localized` makes such a table answer
// in the language of the moment instead.

import { useSyncExternalStore } from 'react'
import { en } from '@/lib/i18n/en'
import { ja } from '@/lib/i18n/ja'
import { zhTW } from '@/lib/i18n/zh-TW'

export type Lang = 'zh-CN' | 'zh-TW' | 'en' | 'ja'
/** The languages, each under its own name. */
export const LANGS: Array<[Lang, string]> = [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語']]

const TABLES: Record<Lang, Record<string, string> | null> = { 'zh-CN': null, 'zh-TW': zhTW, en, ja }
const KEY = 'akagi.language'

/** The language a browser asks for, as one of ours. */
function preferred(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && saved in TABLES) return saved as Lang
  } catch { /* no storage: the browser's own preference decides */ }
  const asked = typeof navigator === 'undefined' ? '' : navigator.language.toLowerCase()
  if (asked.startsWith('ja')) return 'ja'
  if (asked.startsWith('en')) return 'en'
  if (/^zh-(tw|hk|mo|hant)/.test(asked)) return 'zh-TW'
  return 'zh-CN'
}

let current: Lang = preferred()
const listeners = new Set<() => void>()

export const getLang = (): Lang => current
/** Change the language of everything drawn from here on, and remember it. */
export function setLang(lang: Lang): void {
  if (lang === current) return
  current = lang
  try { localStorage.setItem(KEY, lang) } catch { /* not remembered, still changed */ }
  listeners.forEach(tell => tell())
}
/** The language, for a component that has to be drawn again when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(tell => { listeners.add(tell); return () => { listeners.delete(tell) } }, getLang)
}

/** `text` in the chosen language, with `values` put in at `{0}`, `{1}`, … */
export function tr(text: string, ...values: Array<string | number>): string {
  const found = TABLES[current]?.[text] ?? text
  return values.length === 0 ? found : found.replace(/\{(\d+)\}/g, (whole, i) => (Number(i) < values.length ? String(values[Number(i)]) : whole))
}

/** A table of words that answers in the language of the moment: every string
 *  read out of it, at any depth, is put through `tr`. */
export function localized<T extends object>(table: T): T {
  return new Proxy(table, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value === 'string') return tr(value)
      return value !== null && typeof value === 'object' ? localized(value) : value
    },
  })
}
