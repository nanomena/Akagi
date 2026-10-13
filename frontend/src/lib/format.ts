export function fmtScore(n: number | null | undefined): string {
  return new Intl.NumberFormat('en-US').format(n ?? 0)
}

export type RelativeKind = 'self' | 'shimocha' | 'toimen' | 'kamicha'

/** Compute the relative seat position of `seat` from `ourSeat`'s perspective.
 * `numPlayers` defaults to 4 (yonma); pass 3 for sanma. In 3p there's no
 * `toimen` (no opposite seat in a triangle) — only `self / shimocha / kamicha`. */
export function relativeKind(
  seat: number,
  ourSeat: number | null,
  numPlayers: number = 4,
): RelativeKind {
  if (ourSeat == null) return 'self'
  const n = Math.max(1, numPlayers)
  const d = (seat - ourSeat + n) % n
  if (n === 3) {
    return d === 0 ? 'self' : d === 1 ? 'shimocha' : 'kamicha'
  }
  return d === 0 ? 'self' : d === 1 ? 'shimocha' : d === 2 ? 'toimen' : 'kamicha'
}
