// @ts-check
// Autoplay's pointer, drawn over the game: where it is, the path it took over
// the last moment, and where it pressed. A page sent input over DevTools shows
// no cursor of its own. The marks are in the game page's CSS pixels, which are
// this page's too: its window lies exactly over the game's view.
//
// Olive is what is live, the pointer and its way; navy is what was done, the
// press (the colours of the dock).

/** How long a stretch of the path stays, fading. */
const FADE_MS = 650
/** How long a press's ring grows and fades. */
const PRESS_MS = 520
const LIVE = [128, 156, 28] // hsl(73 70% 36%)
const DONE = [29, 50, 135] // hsl(228 65% 32%)

const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas'))
const pen = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))

/** @typedef {{ x: number, y: number, t: number, fresh?: boolean }} Spot */
/** @type {Spot[]} */
let path = []
/** @type {Spot[]} */
let presses = []
/** @type {Spot | null} */
let here = null
let pressed = false
let frame = 0

function fit() {
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * scale)
  canvas.height = Math.round(window.innerHeight * scale)
  pen.setTransform(scale, 0, 0, scale, 0, 0)
  draw(performance.now())
}

/** @param {number[]} rgb @param {number} alpha */
const colour = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`

/** An arrow cursor with its tip at (x, y): white, outlined, as a system pointer looks. */
function cursor(/** @type {number} */ x, /** @type {number} */ y) {
  pen.save()
  pen.translate(x, y)
  pen.beginPath()
  pen.moveTo(0, 0)
  pen.lineTo(0, 17)
  pen.lineTo(4.2, 13.2)
  pen.lineTo(7, 19.6)
  pen.lineTo(9.8, 18.4)
  pen.lineTo(7.1, 12.1)
  pen.lineTo(12.4, 12.1)
  pen.closePath()
  pen.shadowColor = 'rgba(0, 0, 0, 0.35)'
  pen.shadowBlur = 3
  pen.shadowOffsetY = 1
  pen.fillStyle = '#ffffff'
  pen.fill()
  pen.shadowColor = 'transparent'
  pen.lineWidth = 1.2
  pen.strokeStyle = colour(LIVE, pressed ? 1 : 0.9)
  pen.stroke()
  pen.restore()
}

/** @param {number} now */
function draw(now) {
  frame = 0
  path = path.filter(spot => now - spot.t < FADE_MS)
  presses = presses.filter(spot => now - spot.t < PRESS_MS)
  pen.clearRect(0, 0, window.innerWidth, window.innerHeight)

  pen.lineCap = 'round'
  pen.lineJoin = 'round'
  for (let i = 1; i < path.length; i++) {
    // Where the user's own mouse moved the pointer, the path did not go.
    if (path[i].fresh) continue
    const fresh = 1 - (now - path[i].t) / FADE_MS
    pen.strokeStyle = colour(LIVE, 0.8 * fresh)
    pen.lineWidth = 1 + 3 * fresh
    pen.beginPath()
    pen.moveTo(path[i - 1].x, path[i - 1].y)
    pen.lineTo(path[i].x, path[i].y)
    pen.stroke()
  }
  for (const spot of presses) {
    const age = (now - spot.t) / PRESS_MS
    pen.strokeStyle = colour(DONE, 0.9 * (1 - age))
    pen.lineWidth = 2.5
    pen.beginPath()
    pen.arc(spot.x, spot.y, 5 + 17 * Math.sqrt(age), 0, Math.PI * 2)
    pen.stroke()
  }
  if (here) cursor(here.x, here.y)

  // Drawn again only while something is still fading; at rest the pointer stays as it is.
  if (path.length > 1 || presses.length > 0) frame = requestAnimationFrame(draw)
}

/** What trail-preload.cjs exposes. */
const marks = /** @type {{ onMark: (listener: (mark: { x: number, y: number, down: boolean, fresh?: boolean }) => void) => void }} */ (
  /** @type {any} */ (window).trail)
marks.onMark(mark => {
  const spot = { x: mark.x, y: mark.y, t: performance.now(), fresh: Boolean(mark.fresh) }
  path.push(spot)
  if (mark.down && !pressed) presses.push(spot)
  pressed = mark.down
  here = spot
  if (!frame) frame = requestAnimationFrame(draw)
})

window.addEventListener('resize', fit)
fit()
