//! Where the pointer goes, other than to a plan's presses.
//!
//! The press points of a plan are [`super::aim`]'s, and the way to them
//! [`super::approach`]'s. Every other point a move ends on is worked out
//! here and nowhere else: the rest by the buttons, the lift off the hand, a
//! look at a tile, a press made again on the same spot, and where the next
//! draw lands (for [`super::rules`]). Each is drawn through
//! [`crate::autoplay::humanize`], which holds every number they draw by.

use super::aim::Reach;
use super::Point;
use crate::autoplay::context::CanvasRect;
use crate::autoplay::humanize::{self, Spread};
use crate::autoplay::majsoul::coords::TILES;
use rand::Rng;

/// The top of the hand's tiles, as a normalised height: their middle less
/// half the face (some 1.13 high).
const TILES_TOP: f64 = TILES[0].1 - 0.57;

/// Where the hand waits between presses, by the buttons (see
/// [`humanize::rest_spot`]), in CSS pixels.
pub fn rest<R: Rng + ?Sized>(rect: CanvasRect, rng: &mut R) -> Point {
    let (x, y) = humanize::rest_spot(rng);
    rect.pixel(x, y)
}

/// Straight up off a hand tile pressed at `from`: above the top of the
/// tiles by [`humanize::LIFT_UP`], drifting [`humanize::LIFT_SIDE`] to
/// either side, in CSS pixels. Clear of the tiles, and so of where the next
/// draw lands.
pub fn lift<R: Rng + ?Sized>(from: Point, rect: CanvasRect, rng: &mut R) -> Point {
    let unit = rect.width / 16.0;
    let (_, top) = rect.pixel(0.0, TILES_TOP);
    let up = humanize::LIFT_UP.draw(rng);
    let side = humanize::LIFT_SIDE.draw(rng);
    (from.0 + side * unit, top - up * unit)
}

/// On the tile whose middle is `middle` (normalised), as a hand rests on a
/// tile it looks at: off the middle across, high on it rather than low.
pub fn on_tile<R: Rng + ?Sized>(middle: (f64, f64), rect: CanvasRect, rng: &mut R) -> Point {
    rect.pixel(
        middle.0 + humanize::LOOK_OFF_X.draw(rng),
        middle.1 + humanize::on_tile_y(rng),
    )
}

/// Where the next draw lands on a hand at rest of `count` tiles, in CSS
/// pixels, and the canvas's 16:9 unit in pixels: what [`super::rules`]
/// keeps the pointer off until the tile is there.
pub fn draw_slot(count: usize, rect: CanvasRect) -> (Point, f64) {
    let (x, y) = crate::autoplay::majsoul::draw_point(count);
    (rect.pixel(x, y), rect.width / 16.0)
}

/// A press on the same spot again, moved a little as a hand pressing in
/// place moves the mouse: by `x` across and `y` up and down (16:9 units),
/// never off the target whose middle is `middle` and reach `reach`.
pub fn nudge<R: Rng + ?Sized>(
    at: (f64, f64),
    middle: (f64, f64),
    reach: Reach,
    x: Spread,
    y: Spread,
    rng: &mut R,
) -> (f64, f64) {
    (
        (at.0 + x.draw(rng)).clamp(middle.0 - reach.half_x, middle.0 + reach.half_x),
        (at.1 + y.draw(rng)).clamp(middle.1 - reach.half_y, middle.1 + reach.half_y),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autoplay::pointer::rules::{refusal, Bound, Sight};
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    const RECT: CanvasRect = CanvasRect {
        x: 0.0,
        y: 0.0,
        width: 1280.0,
        height: 720.0,
    };

    /// A lift off the tile just thrown — where the next draw lands — always
    /// ends clear of that spot, above the tiles, and nearly straight up.
    #[test]
    fn a_lift_clears_where_the_next_draw_lands() {
        let mut rng = StdRng::seed_from_u64(43);
        let (slot, unit) = draw_slot(13, RECT);
        let sight = Sight {
            draw_slot: Some((slot, unit)),
        };
        let (_, top) = RECT.pixel(0.0, TILES_TOP);
        for _ in 0..2000 {
            let pressed = (slot.0, slot.1 + humanize::on_tile_y(&mut rng) * unit);
            let to = lift(pressed, RECT, &mut rng);
            assert_eq!(refusal(to, Bound::Errand, &sight), None, "{to:?}");
            assert!(to.1 < top, "above the tiles: {to:?}");
            assert!((to.0 - pressed.0).abs() <= humanize::LIFT_SIDE.most * unit + 1e-9);
        }
    }

    /// A look rests on its tile: across within it, high on it.
    #[test]
    fn a_look_rests_on_its_tile() {
        let mut rng = StdRng::seed_from_u64(47);
        let middle = TILES[4];
        let unit = RECT.width / 16.0;
        let (mx, my) = RECT.pixel(middle.0, middle.1);
        for _ in 0..2000 {
            let (x, y) = on_tile(middle, RECT, &mut rng);
            assert!((x - mx).abs() <= humanize::LOOK_OFF_X.most * unit + 1e-9);
            assert!(y >= my + humanize::TILE_TOP * unit - 1e-9);
            assert!(y <= my + (humanize::TILE_TOP + humanize::TILE_DROP.most) * unit + 1e-9);
        }
    }

    /// A press made again on the same spot stays on its target.
    #[test]
    fn a_nudge_stays_on_its_target() {
        let mut rng = StdRng::seed_from_u64(53);
        let middle = (14.59, 8.37);
        let reach = Reach {
            half_x: 0.45,
            half_y: 0.16,
            from_top: false,
        };
        let wide = Spread { sd: 1.0, most: 3.0 };
        for _ in 0..500 {
            let (x, y) = nudge(middle, middle, reach, wide, wide, &mut rng);
            assert!((x - middle.0).abs() <= reach.half_x + 1e-9);
            assert!((y - middle.1).abs() <= reach.half_y + 1e-9);
        }
    }
}
