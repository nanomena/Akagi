//! Where the pointer is between presses.
//!
//! A press needs the pointer on its target and nothing more, and for a long
//! time that was all the pointer did: it appeared on a tile, pressed, and
//! stayed there until the next press. On the table that reads as a tile
//! which lifts with nothing reaching for it, and one which stays lifted for
//! the rest of the round because the pointer never left.
//!
//! This module plans the rest of the pointer's life, all of it visible
//! through what the client draws under a pointer:
//!
//! - the **approach** — it travels to the press instead of appearing there,
//!   and may first rest on the runner-up when the bot was torn between two
//!   discards;
//! - the **rest** — once the press has registered it leaves the hand.
//!
//! Everything here is arithmetic on points and milliseconds; sending the
//! moves is [`crate::autoplay::cdp_input::travel`]. The approach is made
//! *inside* the thinking time the delay model chose, never after it: the
//! press lands at the instant it would have without any of this, so no
//! budget, floor or cap is affected.

use crate::autoplay::delay::probs::Candidate;
use rand::Rng;

/// A point in CSS pixels.
pub type Point = (f64, f64);

/// The shortest look at the runner-up that still reads as one.
const MIN_DWELL_MS: u32 = 260;
/// The longest; beyond it the pointer just looks parked on the wrong tile.
const MAX_DWELL_MS: u32 = 1_300;

/// One stretch of an approach: travel to `to`, then stay for `dwell_ms`.
#[derive(Debug, Clone, PartialEq)]
pub struct Leg {
    pub to: Point,
    pub travel_ms: u32,
    pub dwell_ms: u32,
    /// How far the path leans off the straight line, as a fraction of its
    /// length. Signed: which side it leans to.
    pub bend: f64,
}

/// The pointer's way to a press: wait `pause_ms`, then walk `legs`. The last
/// leg ends on the press point with no dwell — the press's own hover follows.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Approach {
    pub pause_ms: u32,
    pub legs: Vec<Leg>,
}

impl Approach {
    /// Everything the approach takes, pause included.
    pub fn total_ms(&self) -> u32 {
        self.pause_ms
            + self
                .legs
                .iter()
                .map(|l| l.travel_ms + l.dwell_ms)
                .sum::<u32>()
    }
}

/// How long a hand takes to move the pointer `distance` pixels, on a canvas
/// whose 16:9 unit is `unit` pixels. Grows with the square root of the
/// distance: a neighbouring tile is not ten times quicker than the far end
/// of the hand.
pub fn travel_ms(distance: f64, unit: f64) -> u32 {
    if !(distance.is_finite() && unit.is_finite()) || unit <= 0.0 || distance < 1.0 {
        return 0;
    }
    (80.0 + 105.0 * (distance / unit).sqrt()).min(440.0) as u32
}

fn distance(a: Point, b: Point) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// The point `t` of the way (`0..=1` in time) along a leg from `from` to
/// `to`: a shallow arc, started and ended gently.
pub fn along(from: Point, to: Point, bend: f64, t: f64) -> Point {
    let t = t.clamp(0.0, 1.0);
    // Minimum-jerk easing: no speed and no acceleration at either end.
    let s = t * t * t * (10.0 - 15.0 * t + 6.0 * t * t);
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    // The arc's control point: the midpoint, pushed sideways.
    let control = (
        (from.0 + to.0) / 2.0 - dy * bend,
        (from.1 + to.1) / 2.0 + dx * bend,
    );
    let a = (1.0 - s) * (1.0 - s);
    let b = 2.0 * (1.0 - s) * s;
    let c = s * s;
    (
        a * from.0 + b * control.0 + c * to.0,
        a * from.1 + b * control.1 + c * to.1,
    )
}

fn bend<R: Rng + ?Sized>(rng: &mut R) -> f64 {
    rng.random_range(-0.12..0.12)
}

/// The pointer leaving a press for `to`: a short wait first — a hand does
/// not spring off the tile it has just let go — given as the leg's dwell,
/// which here comes *before* the travel.
pub fn leave<R: Rng + ?Sized>(from: Point, to: Point, unit: f64, rng: &mut R) -> Leg {
    Leg {
        to,
        travel_ms: travel_ms(distance(from, to), unit),
        dwell_ms: rng.random_range(90..320),
        bend: bend(rng),
    }
}

/// Plan the pointer's way from `from` to a press at `press`, to take exactly
/// `think_ms`.
///
/// With a `glance` — the runner-up's place — the pointer rests there first,
/// or goes to the press, over to the runner-up and back. Whatever does not
/// fit in `think_ms` is dropped, the look before the travel: a short think
/// gets a plain approach, and a shorter one gets a quicker hand.
pub fn approach<R: Rng + ?Sized>(
    think_ms: u32,
    from: Point,
    press: Point,
    glance: Option<Point>,
    unit: f64,
    rng: &mut R,
) -> Approach {
    if let Some(look) = glance {
        // Reach for the choice, doubt it, come back — or reach for the
        // runner-up and think better of it.
        let stops: Vec<Point> = if rng.random_bool(0.4) {
            vec![press, look]
        } else {
            vec![look]
        };
        if let Some(found) = with_stops(think_ms, from, press, &stops, unit, rng) {
            return found;
        }
        if stops.len() > 1 {
            if let Some(found) = with_stops(think_ms, from, press, &[look], unit, rng) {
                return found;
            }
        }
    }
    let travel = travel_ms(distance(from, press), unit).min(think_ms);
    Approach {
        pause_ms: think_ms - travel,
        legs: vec![Leg {
            to: press,
            travel_ms: travel,
            dwell_ms: 0,
            bend: bend(rng),
        }],
    }
}

/// An approach that rests on each of `stops` on its way to `press`, or
/// `None` when `think_ms` cannot hold it.
fn with_stops<R: Rng + ?Sized>(
    think_ms: u32,
    from: Point,
    press: Point,
    stops: &[Point],
    unit: f64,
    rng: &mut R,
) -> Option<Approach> {
    let mut legs = Vec::with_capacity(stops.len() + 1);
    let mut at = from;
    for &stop in stops.iter().chain(std::iter::once(&press)) {
        legs.push(Leg {
            to: stop,
            travel_ms: travel_ms(distance(at, stop), unit),
            dwell_ms: 0,
            bend: bend(rng),
        });
        at = stop;
    }
    let travel: u32 = legs.iter().map(|l| l.travel_ms).sum();
    let looks = stops.len() as u32;
    let spare = think_ms.checked_sub(travel)?;
    if spare < looks * MIN_DWELL_MS {
        return None;
    }
    // Each look takes a share of the think, within what a look can be, and
    // together no more than what is left once the travel is paid for.
    let mut left = spare;
    for (i, leg) in legs.iter_mut().take(stops.len()).enumerate() {
        let after = (looks - 1 - i as u32) * MIN_DWELL_MS;
        let wish = (f64::from(think_ms) * rng.random_range(0.14..0.32)) as u32;
        leg.dwell_ms = wish.clamp(MIN_DWELL_MS, MAX_DWELL_MS).min(left - after);
        left -= leg.dwell_ms;
    }
    Some(Approach {
        pause_ms: left,
        legs,
    })
}

/// The tile to glance at before discarding `chosen`: the other of the bot's
/// two likeliest candidates, when both are discards and of different tiles.
///
/// Anything else is not a hesitation the pointer can show. A call or a
/// declaration is a button, not a place in the hand; and the same tile from
/// the hand or from the draw is one tile, however the bot counts it.
pub fn runner_up<'a>(candidates: &'a [Candidate], chosen: &str) -> Option<&'a str> {
    let [first, second, ..] = candidates else {
        return None;
    };
    let tile = |c: &'a Candidate| match (c.kind.as_deref(), c.pais.as_slice()) {
        (Some("dahai"), [pai]) => Some(pai.as_str()),
        _ => None,
    };
    let (a, b) = (tile(first)?, tile(second)?);
    match (a == chosen, b == chosen) {
        (true, false) => Some(b),
        (false, true) => Some(a),
        _ => None,
    }
}

/// Where the pointer rests after a press at the normalised 16:9 point
/// `pressed`: a little way off to either side, above the hand and below the
/// table, where the client draws nothing under it.
pub fn rest_point<R: Rng + ?Sized>(pressed: (f64, f64), rng: &mut R) -> (f64, f64) {
    let x = (pressed.0 + rng.random_range(-1.6..1.6)).clamp(2.2, 12.8);
    (x, rng.random_range(6.6..7.5))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    const UNIT: f64 = 100.0;

    fn discard(pai: &str, prob: f64) -> Candidate {
        Candidate {
            kind: Some("dahai".into()),
            pais: vec![pai.into()],
            prob,
        }
    }

    #[test]
    fn a_leg_starts_and_ends_on_its_points_whatever_its_bend() {
        let (from, to) = ((120.0, 840.0), (910.0, 655.0));
        for bend in [-0.12, 0.0, 0.12] {
            assert_eq!(along(from, to, bend, 0.0), from);
            let end = along(from, to, bend, 1.0);
            assert!((end.0 - to.0).abs() < 1e-9 && (end.1 - to.1).abs() < 1e-9);
        }
    }

    #[test]
    fn a_leg_never_strays_further_than_its_bend() {
        let (from, to) = ((100.0, 800.0), (900.0, 800.0));
        for i in 0..=100 {
            let (x, y) = along(from, to, 0.12, f64::from(i) / 100.0);
            assert!((100.0..=900.0).contains(&x), "x left the span: {x}");
            // A quadratic arc peaks at half its control point's offset.
            assert!(
                (y - 800.0).abs() <= 800.0 * 0.12 / 2.0 + 1e-9,
                "y strayed: {y}"
            );
        }
    }

    #[test]
    fn a_leg_only_moves_forward() {
        let (from, to) = ((100.0, 800.0), (900.0, 700.0));
        let mut last = from.0;
        for i in 1..=200 {
            let (x, _) = along(from, to, 0.0, f64::from(i) / 200.0);
            assert!(x >= last, "went back at step {i}");
            last = x;
        }
    }

    #[test]
    fn travel_time_grows_with_distance_and_is_bounded() {
        assert_eq!(travel_ms(0.0, UNIT), 0);
        let near = travel_ms(79.0, UNIT);
        let far = travel_ms(900.0, UNIT);
        assert!(near > 100 && near < far, "{near} {far}");
        assert!(travel_ms(100_000.0, UNIT) <= 440);
        assert_eq!(travel_ms(500.0, 0.0), 0);
    }

    /// The press lands when it would have anyway: whatever is planned, the
    /// approach takes exactly the think it was given.
    #[test]
    fn an_approach_takes_exactly_the_think_it_is_given() {
        let mut rng = StdRng::seed_from_u64(7);
        for think in [0, 40, 250, 700, 1_000, 1_800, 3_500, 9_000, 60_000] {
            for glance in [None, Some((300.0, 836.0))] {
                for _ in 0..200 {
                    let from = (
                        rng.random_range(200.0..1300.0),
                        rng.random_range(660.0..750.0),
                    );
                    let plan = approach(think, from, (1170.0, 836.0), glance, UNIT, &mut rng);
                    assert_eq!(plan.total_ms(), think, "{plan:?}");
                    let last = plan.legs.last().unwrap();
                    assert_eq!(last.to, (1170.0, 836.0));
                    assert_eq!(last.dwell_ms, 0);
                }
            }
        }
    }

    #[test]
    fn a_glance_rests_on_the_runner_up_before_the_press() {
        let mut rng = StdRng::seed_from_u64(11);
        let (press, look) = ((1170.0, 836.0), (300.0, 836.0));
        let mut shapes = std::collections::BTreeSet::new();
        for _ in 0..200 {
            let plan = approach(4_000, (700.0, 700.0), press, Some(look), UNIT, &mut rng);
            let stops: Vec<Point> = plan.legs.iter().map(|l| l.to).collect();
            assert!(stops == vec![look, press] || stops == vec![press, look, press]);
            for leg in &plan.legs[..plan.legs.len() - 1] {
                assert!(
                    (MIN_DWELL_MS..=MAX_DWELL_MS).contains(&leg.dwell_ms),
                    "{leg:?}"
                );
            }
            shapes.insert(stops.len());
        }
        assert_eq!(shapes.len(), 2, "both shapes should occur");
    }

    #[test]
    fn a_think_too_short_for_a_look_gets_a_plain_approach() {
        let mut rng = StdRng::seed_from_u64(3);
        for _ in 0..100 {
            let plan = approach(
                500,
                (700.0, 700.0),
                (1170.0, 836.0),
                Some((300.0, 836.0)),
                UNIT,
                &mut rng,
            );
            assert_eq!(plan.legs.len(), 1);
            assert_eq!(plan.total_ms(), 500);
        }
        // And one too short even to travel gets a quicker hand, not a later press.
        let plan = approach(60, (200.0, 700.0), (1170.0, 836.0), None, UNIT, &mut rng);
        assert_eq!((plan.pause_ms, plan.legs[0].travel_ms), (0, 60));
    }

    #[test]
    fn the_runner_up_is_the_other_of_two_different_discards() {
        let two = [discard("5p", 0.48), discard("1m", 0.41), discard("E", 0.05)];
        assert_eq!(runner_up(&two, "5p"), Some("1m"));
        assert_eq!(runner_up(&two, "1m"), Some("5p"));
        // The choice is neither of the two likeliest: nothing to show.
        assert_eq!(runner_up(&two, "E"), None);
        // A red five and a plain one sit in different places.
        assert_eq!(
            runner_up(&[discard("5pr", 0.5), discard("5p", 0.4)], "5p"),
            Some("5pr")
        );
    }

    #[test]
    fn nothing_to_glance_at_between_one_tile_or_a_button() {
        // The same tile, from the hand and from the draw.
        assert_eq!(
            runner_up(&[discard("5p", 0.5), discard("5p", 0.4)], "5p"),
            None
        );
        // A declaration is a button.
        let reach = Candidate {
            kind: Some("reach".into()),
            pais: vec![],
            prob: 0.4,
        };
        assert_eq!(runner_up(&[discard("5p", 0.5), reach], "5p"), None);
        // A bot that does not say what its candidates are.
        let unnamed = Candidate {
            kind: None,
            pais: vec!["1m".into()],
            prob: 0.4,
        };
        assert_eq!(runner_up(&[discard("5p", 0.5), unnamed], "5p"), None);
        assert_eq!(runner_up(&[discard("5p", 1.0)], "5p"), None);
    }

    #[test]
    fn the_pointer_rests_above_the_hand() {
        let mut rng = StdRng::seed_from_u64(5);
        for x in [2.2, 6.9, 12.7] {
            for _ in 0..200 {
                let (rx, ry) = rest_point((x, 8.3625), &mut rng);
                assert!((2.2..=12.8).contains(&rx));
                // Clear of a lifted tile below and of the table above.
                assert!((6.6..7.5).contains(&ry));
            }
        }
    }
}
