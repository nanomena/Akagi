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
//!   mostly settles on its target for a while before pressing it, and may
//!   first rest on the runner-up when the bot was torn between two discards;
//! - the **rest** — once the press has registered it leaves the hand.
//!
//! Everything here is arithmetic on points and milliseconds; sending the
//! moves is [`crate::autoplay::cdp_input::travel`]. The approach is made
//! *inside* the thinking time the delay model chose, never after it: the
//! press lands at the instant it would have without any of this, so no
//! budget, floor or cap is affected.

use crate::autoplay::delay::probs::Candidate;
use rand::Rng;
use rand_distr::{Distribution, LogNormal};

/// A point in CSS pixels.
pub type Point = (f64, f64);

/// How long the pointer rests on a tile it looks at, unless the delay script
/// says otherwise (`look_ms` in its answer). A settle on the press before it
/// is made is measured against it too.
pub const LOOK_MS: u32 = 800;

/// How far apart, in 16:9 units, two tiles may sit for the pointer to go from
/// one to the other: three tiles, and the gap before the drawn one. Any
/// further and the look is a sweep across the rack, and nobody weighs two
/// tiles by waving between the ends of their hand.
pub const LOOK_REACH: f64 = 2.7;

/// How often a press with no runner-up to look at is settled on before it is
/// made. The rest of the time the hand presses as it arrives: a decided hand
/// does that too.
const SETTLE_CHANCE: f64 = 0.7;

/// With a runner-up within reach, the shapes of the approach: how often the
/// hand only settles on its choice (A), and how often it rests on the
/// runner-up first (B, A). Otherwise it reaches for its choice, doubts it,
/// goes over to the runner-up and comes back (A, B, A).
const ONLY_SETTLE: f64 = 0.3;
const LOOK_FIRST: f64 = 0.42;

/// How long a hand rests somewhere, as a share of the rest it was given:
/// log-normal around `median`, so mostly near it and now and then a good deal
/// longer, never one fixed rhythm; held within `least..=most`.
struct Rest {
    median: f64,
    spread: f64,
    least: f64,
    most: f64,
}

/// On a tile looked at.
const LOOK_REST: Rest = Rest {
    median: 1.0,
    spread: 0.4,
    least: 0.5,
    most: 2.5,
};
/// On the tile pressed, before pressing it.
const SETTLE_REST: Rest = Rest {
    median: 0.55,
    spread: 0.5,
    least: 0.2,
    most: 2.0,
};

impl Rest {
    fn share<R: Rng + ?Sized>(&self, rng: &mut R) -> f64 {
        let drawn =
            LogNormal::new(self.median.ln(), self.spread).map_or(self.median, |d| d.sample(rng));
        drawn.clamp(self.least, self.most)
    }
}

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
/// leg ends on the press point; one that dwells there settles on the target
/// before pressing it, one that does not presses as it arrives — the press's
/// own hover follows.
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

/// The pointer leaving a press for `to`: a wait first — a hand does not
/// spring off the tile it has just let go, and how long it stays varies a
/// great deal: mostly about half a second, now and then at once, now and
/// then a second or two — given as the leg's dwell, which here comes
/// *before* the travel.
pub fn leave<R: Rng + ?Sized>(from: Point, to: Point, unit: f64, rng: &mut R) -> Leg {
    Leg {
        to,
        travel_ms: travel_ms(distance(from, to), unit),
        dwell_ms: linger_ms(rng),
        bend: bend(rng),
    }
}

/// How long a hand stays on what it pressed: log-normal around 550 ms.
fn linger_ms<R: Rng + ?Sized>(rng: &mut R) -> u32 {
    let wait = LogNormal::new(550f64.ln(), 0.6).map_or(550.0, |d| d.sample(rng));
    wait.clamp(120.0, 2500.0) as u32
}

/// Plan the pointer's way from `from` to a press at `press`, to take exactly
/// `think_ms`.
///
/// With a `look` at a runner-up that sits within reach of the press, the
/// pointer settles on the press alone; or rests on the runner-up first; or
/// rests on the press, goes over to the runner-up and comes back. With none,
/// it mostly settles on the press, and otherwise presses as it arrives. How
/// long it rests anywhere is drawn afresh against `rest_ms`. Whatever does
/// not fit in `think_ms` is dropped, the look before the settle and the
/// settle before the travel: a short think gets a plain approach, and a
/// shorter one gets a quicker hand.
pub fn approach<R: Rng + ?Sized>(
    think_ms: u32,
    from: Point,
    press: Point,
    look: Option<Point>,
    rest_ms: u32,
    unit: f64,
    rng: &mut R,
) -> Approach {
    let near = look.filter(|&at| distance(press, at) <= LOOK_REACH * unit);
    // The stops to make on the way, the fullest first: each gives way to the
    // next when the think cannot hold it.
    let shapes: Vec<Vec<Point>> = match near {
        Some(at) => {
            let roll: f64 = rng.random();
            if roll < ONLY_SETTLE {
                vec![vec![]]
            } else if roll < ONLY_SETTLE + LOOK_FIRST {
                vec![vec![at], vec![]]
            } else {
                vec![vec![press, at], vec![at], vec![]]
            }
        }
        None if rng.random_bool(SETTLE_CHANCE) => vec![vec![]],
        None => Vec::new(),
    };
    for stops in &shapes {
        if let Some(found) = with_stops(think_ms, from, press, stops, rest_ms, unit, rng) {
            return found;
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

/// An approach that rests on each of `stops` on its way to `press`, and
/// settles on `press` before pressing it; `None` when `think_ms` cannot hold
/// that.
fn with_stops<R: Rng + ?Sized>(
    think_ms: u32,
    from: Point,
    press: Point,
    stops: &[Point],
    rest_ms: u32,
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
    let spare = think_ms.checked_sub(travel)?;
    let rest = f64::from(rest_ms);
    let least = rest * (LOOK_REST.least * stops.len() as f64 + SETTLE_REST.least);
    if f64::from(spare) < least {
        return None;
    }
    // A rest on each tile looked at and one on the tile pressed; together no
    // more than what is left once the travel is paid for.
    for (i, leg) in legs.iter_mut().enumerate() {
        let kind = if i < stops.len() {
            &LOOK_REST
        } else {
            &SETTLE_REST
        };
        leg.dwell_ms = (rest * kind.share(rng)) as u32;
    }
    let wished: u32 = legs.iter().map(|l| l.dwell_ms).sum();
    if wished > spare {
        for leg in &mut legs {
            leg.dwell_ms = (u64::from(leg.dwell_ms) * u64::from(spare) / u64::from(wished)) as u32;
        }
    }
    let rested: u32 = legs.iter().map(|l| l.dwell_ms).sum();
    Some(Approach {
        pause_ms: spare - rested,
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

/// Where the pointer rests between presses, as a normalised 16:9 point:
/// along the action buttons' row and the table above it, where a hand waits
/// for the next thing it may have to answer — a wide band, more than half the
/// width of the game, so that it is not the same spot every time. Off the
/// hand, so no tile is left lifted.
pub fn rest_point<R: Rng + ?Sized>(rng: &mut R) -> (f64, f64) {
    let (x, y) = crate::autoplay::majsoul::coords::ACTIONS[0];
    (
        x + rng.random_range(-6.4..2.4),
        y + rng.random_range(-1.1..0.25),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    const UNIT: f64 = 100.0;
    const PRESS: Point = (1170.0, 836.0);
    /// Two tiles along from the press.
    const NEAR: Point = (1012.0, 836.0);
    /// The other end of the hand.
    const FAR: Point = (300.0, 836.0);

    fn discard(pai: &str, prob: f64) -> Candidate {
        Candidate {
            kind: Some("dahai".into()),
            pais: vec![pai.into()],
            prob,
        }
    }

    fn median(mut values: Vec<u32>) -> u32 {
        values.sort_unstable();
        values[values.len() / 2]
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
            for look in [None, Some(NEAR), Some(FAR)] {
                for _ in 0..200 {
                    let from = (
                        rng.random_range(200.0..1300.0),
                        rng.random_range(660.0..750.0),
                    );
                    let plan = approach(think, from, PRESS, look, LOOK_MS, UNIT, &mut rng);
                    assert_eq!(plan.total_ms(), think, "{plan:?}");
                    assert_eq!(plan.legs.last().unwrap().to, PRESS);
                }
            }
        }
    }

    #[test]
    fn a_torn_hand_settles_on_its_choice_or_looks_at_the_runner_up_first() {
        let mut rng = StdRng::seed_from_u64(11);
        let mut shapes = std::collections::BTreeSet::new();
        for _ in 0..400 {
            let plan = approach(
                20_000,
                (700.0, 700.0),
                PRESS,
                Some(NEAR),
                LOOK_MS,
                UNIT,
                &mut rng,
            );
            let stops: Vec<Point> = plan.legs.iter().map(|l| l.to).collect();
            assert!(
                stops == vec![PRESS]
                    || stops == vec![NEAR, PRESS]
                    || stops == vec![PRESS, NEAR, PRESS],
                "{stops:?}"
            );
            let (settle, looks) = plan.legs.split_last().unwrap();
            for leg in looks {
                assert!((400..=2_000).contains(&leg.dwell_ms), "{leg:?}");
            }
            assert!((160..=1_600).contains(&settle.dwell_ms), "{settle:?}");
            shapes.insert(stops.len());
        }
        assert_eq!(shapes.len(), 3, "all three shapes should occur");
    }

    #[test]
    fn a_press_is_mostly_settled_on_and_now_and_then_made_on_arrival() {
        let mut rng = StdRng::seed_from_u64(19);
        let plans: Vec<Approach> = (0..1_000)
            .map(|_| approach(9_000, (700.0, 700.0), PRESS, None, LOOK_MS, UNIT, &mut rng))
            .collect();
        assert!(plans.iter().all(|plan| plan.legs.len() == 1));
        let settles: Vec<u32> = plans
            .iter()
            .map(|plan| plan.legs[0].dwell_ms)
            .filter(|&dwell| dwell > 0)
            .collect();
        assert!(
            (600..=800).contains(&settles.len()),
            "{} settled",
            settles.len()
        );
        // Rests are drawn afresh, long-tailed: mostly near the median, some
        // twice as long or more.
        let middle = median(settles.clone());
        assert!((360..=520).contains(&middle), "median {middle}");
        assert!(settles.iter().filter(|&&dwell| dwell >= 2 * middle).count() > 20);
        let distinct: std::collections::BTreeSet<u32> = settles.iter().copied().collect();
        assert!(distinct.len() > settles.len() / 2);
    }

    /// A longer rest asked for is a longer rest given.
    #[test]
    fn the_rest_on_a_tile_grows_with_the_one_asked_for() {
        let mut rng = StdRng::seed_from_u64(13);
        let mut looks = |rest_ms: u32| -> u32 {
            let dwells = (0..400)
                .filter_map(|_| {
                    let plan = approach(
                        20_000,
                        (700.0, 700.0),
                        PRESS,
                        Some(NEAR),
                        rest_ms,
                        UNIT,
                        &mut rng,
                    );
                    (plan.legs.len() > 1).then(|| plan.legs[0].dwell_ms)
                })
                .collect();
            median(dwells)
        };
        let short = looks(800);
        let long = looks(1_600);
        assert!(long > short * 3 / 2, "{short} vs {long}");
    }

    #[test]
    fn tiles_far_apart_are_not_looked_between() {
        let mut rng = StdRng::seed_from_u64(17);
        for _ in 0..100 {
            let plan = approach(
                9_000,
                (700.0, 700.0),
                PRESS,
                Some(FAR),
                LOOK_MS,
                UNIT,
                &mut rng,
            );
            assert_eq!(plan.legs.len(), 1, "{plan:?}");
            assert_eq!(plan.legs[0].to, PRESS);
        }
    }

    #[test]
    fn a_think_too_short_to_rest_gets_a_plain_approach() {
        let mut rng = StdRng::seed_from_u64(3);
        for _ in 0..100 {
            // The travel takes most of it: no look fits, and at most a short settle.
            let plan = approach(
                480,
                (700.0, 700.0),
                PRESS,
                Some(NEAR),
                LOOK_MS,
                UNIT,
                &mut rng,
            );
            assert_eq!(plan.legs.len(), 1);
            assert_eq!(plan.total_ms(), 480);
        }
        // And one too short even to travel gets a quicker hand, not a later press.
        let plan = approach(60, (200.0, 700.0), PRESS, None, LOOK_MS, UNIT, &mut rng);
        assert_eq!(
            (plan.pause_ms, plan.legs[0].travel_ms, plan.legs[0].dwell_ms),
            (0, 60, 0)
        );
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
    fn a_hand_stays_on_its_press_for_a_varying_while_before_it_leaves() {
        let mut rng = StdRng::seed_from_u64(9);
        let mut waits: Vec<u32> = (0..600)
            .map(|_| leave((0.0, 0.0), (100.0, 0.0), UNIT, &mut rng).dwell_ms)
            .collect();
        waits.sort_unstable();
        assert!(waits.iter().all(|w| (120..=2500).contains(w)));
        let median = waits[waits.len() / 2];
        assert!((420..=700).contains(&median), "median {median}");
        // Now and then at once, now and then a second or more.
        assert!(
            waits[30] < 250 && waits[waits.len() - 30] > 1_100,
            "{:?}",
            (waits[30], waits[waits.len() - 30])
        );
    }

    #[test]
    fn the_pointer_rests_by_the_buttons_and_off_the_hand() {
        let mut rng = StdRng::seed_from_u64(5);
        for _ in 0..500 {
            let (x, y) = rest_point(&mut rng);
            assert!((4.4..13.3).contains(&x), "{x}");
            // Above a lifted tile: on the buttons' row or over the table above it.
            assert!((5.85..7.3).contains(&y), "{y}");
        }
    }
}
