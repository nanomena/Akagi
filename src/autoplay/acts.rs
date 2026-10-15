//! What the hand does at the table between decisions, as a person's does.
//!
//! - **A hand's result.** From the moment a hand's result shows, the hand
//!   presses its way through it: bursts of two to seven quick presses at the
//!   confirm button, bottom right, which skip the animation and then confirm. The first
//!   burst starts at any moment as likely as the next, after a look at the
//!   result (`humanize::RESULT_START`; longer after a win of our own), and
//!   each burst after it follows a pause (`humanize::RESULT_PAUSE`). No
//!   burst starts once the client confirms the result; one already begun is
//!   pressed to its end, its last presses on the empty corner of the next
//!   hand's table. A game's last result is never pressed: the game ends as
//!   it shows, and nothing is pressed after the end (the screens that follow
//!   are not a hand's).
//! - **Auto-win after a riichi.** Once our riichi is accepted, the hand may
//!   switch the client's own auto-win on, at any moment as likely as the next
//!   (`humanize::AUTO_WIN_ON`): an early riichi, with longer to go, is the
//!   likelier to have it on. The client switches it off again by itself for
//!   every new hand.
//!
//! This is the plan alone; the manager makes the presses, and reads the
//! toggle's colour to know where it stands (`autoplay::pixels`).

use crate::autoplay::humanize::{
    self, Hazard, AUTO_WIN_ON, OUR_WIN_LINGER, RESULT_PAUSE, RESULT_START,
};
use rand::Rng;
use std::time::{Duration, Instant};

/// The longest a result is pressed: past it the client has long confirmed
/// by its own clock, and a confirm missed by the count must not leave the
/// hand pressing whatever came next.
const RESULT_MOST: Duration = Duration::from_secs(30);

/// What to do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    /// Press the result's confirm button this many times.
    Burst(u32),
    /// Switch the client's auto-win on.
    AutoWinOn,
}

/// A result on screen.
#[derive(Debug, Clone, Copy)]
struct Shown {
    /// How many results the client had confirmed when it showed: one more,
    /// and it is gone.
    seen: u64,
    shown_at: Instant,
    /// When the next burst goes; `None` while one is under way.
    next: Option<Instant>,
    /// The seat's own win: the result is let show for longer.
    ours: bool,
}

/// The acts in hand.
#[derive(Debug, Default)]
pub struct Acts {
    result: Option<Shown>,
    win_on_at: Option<Instant>,
}

fn after<R: Rng + ?Sized>(now: Instant, wait: Hazard, rng: &mut R) -> Instant {
    now + Duration::from_millis(u64::from(wait.draw_ms(rng)))
}

impl Acts {
    /// A hand's result has shown, the seat's own win when `ours`; the client
    /// had confirmed `confirmed` so far.
    pub fn result_shown<R: Rng + ?Sized>(
        &mut self,
        confirmed: u64,
        ours: bool,
        now: Instant,
        rng: &mut R,
    ) {
        let start = |rng: &mut R| {
            let wait = f64::from(RESULT_START.draw_ms(rng));
            let wait = if ours { wait * OUR_WIN_LINGER } else { wait };
            now + Duration::from_millis(wait as u64)
        };
        match &mut self.result {
            None => {
                self.result = Some(Shown {
                    seen: confirmed,
                    shown_at: now,
                    next: Some(start(rng)),
                    ours,
                });
            }
            // Two wins on one discard are one result; one of them ours makes
            // it ours, while nothing has been pressed yet.
            Some(shown) if ours && !shown.ours => {
                shown.ours = true;
                if let Some(next) = &mut shown.next {
                    *next = (*next).max(start(rng));
                }
            }
            Some(_) => {}
        }
        // A riichi that ended before its auto-win was switched on stays without it.
        self.win_on_at = None;
    }

    /// Our riichi was accepted.
    pub fn riichi_accepted<R: Rng + ?Sized>(&mut self, now: Instant, rng: &mut R) {
        self.win_on_at = Some(after(now, AUTO_WIN_ON, rng));
    }

    /// A new hand is dealt, or the game is over: nothing that was due is.
    pub fn hand_over(&mut self) {
        *self = Self::default();
    }

    /// When [`Self::next`] next has something to do.
    pub fn due(&self) -> Option<Instant> {
        [self.result.and_then(|r| r.next), self.win_on_at]
            .into_iter()
            .flatten()
            .min()
    }

    /// What to do at `now`, the client having confirmed `confirmed` results.
    pub fn next<R: Rng + ?Sized>(
        &mut self,
        now: Instant,
        confirmed: u64,
        rng: &mut R,
    ) -> Option<Act> {
        if let Some(result) = self.result {
            if confirmed != result.seen || now >= result.shown_at + RESULT_MOST {
                self.result = None;
            } else if result.next.is_some_and(|at| now >= at) {
                self.result = Some(Shown {
                    next: None,
                    ..result
                });
                return Some(Act::Burst(humanize::burst_len(rng)));
            }
        }
        if self.win_on_at.is_some_and(|at| now >= at) {
            self.win_on_at = None;
            return Some(Act::AutoWinOn);
        }
        None
    }

    /// Whether the result a burst is pressing is still up.
    pub fn result_up(&self, confirmed: u64) -> bool {
        self.result.is_some_and(|r| r.seen == confirmed)
    }

    /// A burst is over at `now`: the next follows a pause, if the result is still up.
    pub fn burst_done<R: Rng + ?Sized>(&mut self, now: Instant, confirmed: u64, rng: &mut R) {
        self.result = self.result.filter(|r| r.seen == confirmed).map(|r| Shown {
            next: Some(after(now, RESULT_PAUSE, rng)),
            ..r
        });
    }

    /// Not now: the act comes again a while after `now` — a riichi's auto-win
    /// while our own decision is open, say.
    pub fn later(&mut self, act: Act, now: Instant, wait: Duration) {
        let at = Some(now + wait);
        match act {
            Act::Burst(_) => {
                if let Some(result) = &mut self.result {
                    result.next = at;
                }
            }
            Act::AutoWinOn => self.win_on_at = at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    /// After a win of our own the result is let show two and a half times as
    /// long before the first burst; a second win on the same discard that is
    /// ours makes the wait ours too.
    #[test]
    fn our_own_win_is_looked_at_longer() {
        let mut rng = StdRng::seed_from_u64(31);
        let t0 = Instant::now();
        let wait = |ours: bool, rng: &mut StdRng| {
            let mut acts = Acts::default();
            acts.result_shown(0, ours, t0, rng);
            acts.due().unwrap().duration_since(t0).as_millis() as f64
        };
        let theirs: f64 = (0..3000).map(|_| wait(false, &mut rng)).sum::<f64>() / 3000.0;
        let ours: f64 = (0..3000).map(|_| wait(true, &mut rng)).sum::<f64>() / 3000.0;
        let ratio = ours / theirs;
        assert!((ratio - OUR_WIN_LINGER).abs() < 0.2, "{ratio}");

        let mut acts = Acts::default();
        acts.result_shown(0, false, t0, &mut rng);
        let before = acts.due().unwrap();
        acts.result_shown(0, true, t0, &mut rng);
        assert!(acts.due().unwrap() >= before);
        assert!(acts.result.unwrap().ours);
    }

    /// A result is pressed through in bursts, the first after a reaction,
    /// until the client confirms it; then nothing more.
    #[test]
    fn a_result_is_pressed_in_bursts_until_it_is_confirmed() {
        let mut rng = StdRng::seed_from_u64(1);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.result_shown(4, false, t0, &mut rng);
        let first = acts.due().expect("a burst is due");
        assert!(first >= ms(t0, 2100), "after a look at the result");
        assert_eq!(
            acts.next(ms(t0, 1), 4, &mut rng),
            None,
            "not before its time"
        );
        let Some(Act::Burst(n)) = acts.next(first, 4, &mut rng) else {
            panic!("a burst")
        };
        assert!((humanize::BURST_LEAST..=humanize::BURST_MOST).contains(&n));
        assert_eq!(acts.due(), None, "nothing while the burst is under way");
        assert!(acts.result_up(4));
        acts.burst_done(first, 4, &mut rng);
        let second = acts.due().expect("another burst");
        assert!(second >= first + Duration::from_millis(300));
        // The client confirms: the result is gone, and no burst follows.
        assert!(!acts.result_up(5));
        assert_eq!(acts.next(second, 5, &mut rng), None);
        assert_eq!(acts.due(), None);
    }

    /// A result whose confirm was never counted is not pressed for ever.
    #[test]
    fn a_result_is_pressed_for_half_a_minute_at_most() {
        let mut rng = StdRng::seed_from_u64(5);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.result_shown(0, false, t0, &mut rng);
        let (mut bursts, mut last) = (0, t0);
        while let Some(at) = acts.due() {
            if let Some(Act::Burst(_)) = acts.next(at, 0, &mut rng) {
                (bursts, last) = (bursts + 1, at);
                acts.burst_done(at, 0, &mut rng);
            }
        }
        assert!(bursts >= 1);
        assert!(
            last < t0 + RESULT_MOST,
            "the last burst started within the half minute"
        );
    }

    /// The game's end stops the presses: the screens after it are not a hand's.
    #[test]
    fn nothing_is_pressed_once_the_game_is_over() {
        let mut rng = StdRng::seed_from_u64(6);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.result_shown(0, false, t0, &mut rng);
        acts.hand_over();
        assert_eq!(acts.due(), None);
        assert_eq!(acts.next(ms(t0, 5000), 0, &mut rng), None);
    }

    /// A riichi has auto-win switched on at some moment after it, once.
    #[test]
    fn auto_win_goes_on_some_while_after_a_riichi() {
        let mut rng = StdRng::seed_from_u64(2);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.riichi_accepted(t0, &mut rng);
        let on = acts.due().expect("due to go on");
        assert!(on >= ms(t0, 2000));
        assert_eq!(
            acts.next(ms(t0, 1000), 0, &mut rng),
            None,
            "not before its time"
        );
        assert_eq!(acts.next(on, 0, &mut rng), Some(Act::AutoWinOn));
        assert_eq!(acts.due(), None, "once");
    }

    /// A riichi whose hand ends before auto-win went on stays without it.
    #[test]
    fn a_hand_that_ends_first_keeps_auto_win_off() {
        let mut rng = StdRng::seed_from_u64(3);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.riichi_accepted(t0, &mut rng);
        acts.result_shown(0, false, ms(t0, 100), &mut rng);
        acts.hand_over();
        assert_eq!(acts.due(), None);
    }

    /// An act put off comes again after the wait.
    #[test]
    fn an_act_put_off_comes_again() {
        let mut rng = StdRng::seed_from_u64(9);
        let t0 = Instant::now();
        let mut acts = Acts::default();
        acts.riichi_accepted(t0, &mut rng);
        let on = acts.due().unwrap();
        assert_eq!(acts.next(on, 0, &mut rng), Some(Act::AutoWinOn));
        acts.later(Act::AutoWinOn, on, Duration::from_millis(700));
        assert_eq!(acts.due(), Some(on + Duration::from_millis(700)));
    }

    /// The longer a riichi lasts, the likelier auto-win went on in it: any
    /// moment as likely as the next.
    #[test]
    fn a_longer_riichi_is_likelier_to_have_auto_win_on() {
        let mut rng = StdRng::seed_from_u64(4);
        let mut within = |secs: u64| {
            (0..4000)
                .filter(|_| u64::from(AUTO_WIN_ON.draw_ms(&mut rng)) <= secs * 1000)
                .count() as f64
                / 4000.0
        };
        let (short, long) = (within(10), within(40));
        // 1 - e^(-(t - 2) / 25): about 0.27 by 10 s, 0.78 by 40 s.
        assert!((short - 0.274).abs() < 0.04, "{short}");
        assert!((long - 0.781).abs() < 0.04, "{long}");
    }
}
