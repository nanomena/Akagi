//! The pointer's unhurried moves, waiting their turn.
//!
//! Two kinds of move can wait and can be cut short: the rest after a press
//! (off what was pressed, to where the hand waits) and the looks between
//! turns. They queue here by priority — a rest before a look — and the
//! manager's loop makes them a frame at a time, so the loop stays free to
//! hear what comes. A press gives way to nothing: when a decision, or a
//! press between decisions, wants the pointer, the move under way brakes to
//! a stop where it is ([`brake`]) and the moves waiting are dropped, and the
//! press's own way starts from where the pointer actually stopped.
//!
//! Before this, each of those moves ran to its end while everything else
//! waited, and a press set off the moment it ended, whichever way that was.

use super::lean::Spot;
use super::Point;
use std::time::Instant;

/// What an unhurried move is for, the more urgent first.
#[derive(Debug, Clone, PartialEq)]
pub enum Errand {
    /// Off a press to where the hand waits; with `settle`, the looks at the
    /// next turn start once it is there.
    Rest { settle: bool },
    /// At a spot of the hand at rest, between turns.
    Look(Spot),
}

impl Errand {
    fn rank(&self) -> u8 {
        match self {
            Errand::Rest { .. } => 0,
            Errand::Look(_) => 1,
        }
    }

    /// What the log calls it.
    pub fn name(&self) -> &'static str {
        match self {
            Errand::Rest { .. } => "rest",
            Errand::Look(_) => "look",
        }
    }
}

/// A move waiting: where to, how long it takes, how it bows, and the
/// earliest it may set off.
#[derive(Debug, Clone, PartialEq)]
pub struct Motion {
    pub errand: Errand,
    pub to: Point,
    pub travel_ms: u32,
    pub bend: f64,
    pub not_before: Instant,
}

/// The moves waiting.
#[derive(Debug, Default)]
pub struct Queue {
    waiting: Vec<Motion>,
}

impl Queue {
    /// Add `motion`. A rest takes the place of everything waiting: it comes
    /// after a press, and what waited was for before it. A look takes the
    /// place of the look waiting, if one is.
    pub fn push(&mut self, motion: Motion) {
        match motion.errand {
            Errand::Rest { .. } => self.waiting.clear(),
            Errand::Look(_) => self.drop_looks(),
        }
        self.waiting.push(motion);
    }

    /// The move to make first: the most urgent, of those the oldest.
    fn first(&self) -> Option<usize> {
        self.waiting
            .iter()
            .enumerate()
            .min_by_key(|(_, m)| m.errand.rank())
            .map(|(i, _)| i)
    }

    /// When the first move may set off.
    pub fn due(&self) -> Option<Instant> {
        self.first().map(|i| self.waiting[i].not_before)
    }

    /// The first move, if it may set off at `now`.
    pub fn take(&mut self, now: Instant) -> Option<Motion> {
        let i = self.first()?;
        (self.waiting[i].not_before <= now).then(|| self.waiting.remove(i))
    }

    /// Put `motion` back first, as it was taken: a move waiting for its stop.
    pub fn push_front(&mut self, motion: Motion) {
        self.waiting.insert(0, motion);
    }

    /// The first move sets off no sooner than `until`.
    pub fn put_off(&mut self, until: Instant) {
        if let Some(i) = self.first() {
            let first = &mut self.waiting[i];
            first.not_before = first.not_before.max(until);
        }
    }

    pub fn drop_looks(&mut self) {
        self.waiting
            .retain(|m| !matches!(m.errand, Errand::Look(_)));
    }

    pub fn clear(&mut self) {
        self.waiting.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
}

/// How hard a hand brakes, in CSS pixels per millisecond squared: from a
/// brisk 1 px/ms to a stop in a tenth of a second.
const DECELERATION: f64 = 0.01;
/// The longest a brake takes.
const BRAKE_MOST_MS: f64 = 180.0;
/// Below this speed, in px/ms, a hand is as good as still.
const STILL: f64 = 0.05;

/// A hand cut short in a move does not halt dead: it brakes to a stop along
/// the way it was going. For a pointer at `at` moving at `velocity` (px/ms),
/// `left` pixels short of where it was going: where it stops, never past
/// that, and how long the braking takes in ms.
pub fn brake(at: Point, velocity: Point, left: f64) -> (Point, u32) {
    let speed = (velocity.0 * velocity.0 + velocity.1 * velocity.1).sqrt();
    if !speed.is_finite() || speed < STILL {
        return (at, 0);
    }
    let ms = (speed / DECELERATION).min(BRAKE_MOST_MS);
    let distance = (speed * ms / 2.0).min(left.max(0.0));
    let way = (velocity.0 / speed, velocity.1 / speed);
    (
        (at.0 + way.0 * distance, at.1 + way.1 * distance),
        ms as u32,
    )
}

/// Where a brake from `at` to `stop` is a share `u` (`0..=1` in time) of the
/// way through: quick at first, slowing evenly to nothing.
pub fn braking(at: Point, stop: Point, u: f64) -> Point {
    let u = u.clamp(0.0, 1.0);
    let s = 1.0 - (1.0 - u) * (1.0 - u);
    (at.0 + (stop.0 - at.0) * s, at.1 + (stop.1 - at.1) * s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn motion(errand: Errand, at: Instant) -> Motion {
        Motion {
            errand,
            to: (0.0, 0.0),
            travel_ms: 300,
            bend: 0.0,
            not_before: at,
        }
    }

    /// The most urgent waiting move goes first, and none before its time.
    #[test]
    fn a_rest_goes_before_a_look_and_neither_before_its_time() {
        let now = Instant::now();
        let later = now + Duration::from_millis(500);
        let mut queue = Queue::default();
        queue.push(motion(Errand::Rest { settle: true }, later));
        queue.push(motion(Errand::Look(Spot::Draw), now));
        assert_eq!(queue.due(), Some(later), "the rest first, at its time");
        assert_eq!(queue.take(now), None, "not before it");
        let first = queue.take(later).expect("the rest");
        assert_eq!(first.errand, Errand::Rest { settle: true });
        assert_eq!(
            queue.take(later).expect("then the look").errand,
            Errand::Look(Spot::Draw)
        );
        assert!(queue.is_empty());
    }

    /// A rest replaces everything waiting; a look, only the look waiting.
    #[test]
    fn a_new_move_replaces_what_it_makes_stale() {
        let now = Instant::now();
        let mut queue = Queue::default();
        queue.push(motion(Errand::Look(Spot::Draw), now));
        queue.push(motion(Errand::Look(Spot::Hand("5m".into())), now));
        assert_eq!(queue.waiting.len(), 1, "one look waits at a time");
        assert_eq!(
            queue.waiting[0].errand,
            Errand::Look(Spot::Hand("5m".into()))
        );
        queue.push(motion(Errand::Rest { settle: false }, now));
        assert_eq!(
            queue.waiting.len(),
            1,
            "a rest makes the looks before it stale"
        );
        queue.push(motion(Errand::Look(Spot::Draw), now));
        queue.drop_looks();
        assert_eq!(
            queue.waiting.len(),
            1,
            "a rest stays when looks are dropped"
        );
        queue.put_off(now + Duration::from_millis(300));
        assert_eq!(queue.due(), Some(now + Duration::from_millis(300)));
        queue.clear();
        assert!(queue.is_empty());
    }

    /// A brake carries on the way the hand was going, a short way, slowing
    /// to nothing; never past where it was going, and not at all when still.
    #[test]
    fn a_cut_short_move_brakes_along_its_way() {
        let (stop, ms) = brake((100.0, 100.0), (1.0, 0.0), 500.0);
        assert!(ms > 50 && ms <= BRAKE_MOST_MS as u32, "{ms}");
        assert!(
            stop.0 > 100.0 && stop.0 < 200.0 && stop.1 == 100.0,
            "{stop:?}"
        );
        let (short, _) = brake((100.0, 100.0), (1.0, 0.0), 10.0);
        assert!(
            (short.0 - 110.0).abs() < 1e-9,
            "never past the target: {short:?}"
        );
        assert_eq!(
            brake((100.0, 100.0), (0.01, 0.0), 500.0),
            ((100.0, 100.0), 0)
        );
        // Quick at first, slower at the end.
        let a = braking((0.0, 0.0), (100.0, 0.0), 0.5);
        assert!(a.0 > 50.0, "{a:?}");
        assert_eq!(braking((0.0, 0.0), (100.0, 0.0), 1.0), (100.0, 0.0));
    }
}
