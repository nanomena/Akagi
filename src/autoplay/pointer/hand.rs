//! The pointer over one hand, and the moves that send it to the page.
//!
//! [`Hand`] keeps where the pointer is and what the bot expects of the seat's
//! next turn, and makes the moves the rest of [`super`] plans: the way to a
//! press ([`super::approach`]), the looks between turns ([`super::lean`]), and
//! leaving a press for a rest by the buttons ([`super::leave`]), and the
//! presses between decisions (`autoplay::acts`). What it knows belongs to one
//! hand, but for where the pointer is: the manager resets it at every hand's
//! start and end, and the pointer stays where it was.

use super::approach::{approach, wait_to_see, Approach, LOOK_MS, LOOK_REACH};
use super::lean::{self, Lean, Spot};
use super::{distance, leave, Point};
use crate::autoplay::context::{AutoplayContext, CanvasRect};
use crate::autoplay::humanize;
use crate::autoplay::platform::{PlanResult, Step};
use crate::schema::MjaiEvent;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{info, warn};

pub struct Hand {
    ctx: Arc<AutoplayContext>,
    /// Where the pointer was last put, in CSS pixels. `None` until its first
    /// move of the hand.
    at: Option<Point>,
    /// What the bot expects of the seat's next turn, and when the pointer
    /// next looks at it. `None` on the seat's own turn and outside a hand.
    lean: Option<Lean>,
    glance_at: Option<Instant>,
    /// The seat whose turn it last was, by a draw or a call: when it is the
    /// one before ours, our draw comes next.
    last_turn: Option<u8>,
    /// The pointer went to where the draw lands before the draw came: a
    /// tsumogiri then leaves it there rather than taking it back to rest.
    waiting_on_draw: bool,
    /// The way the pointer last moved, as a unit direction, and when it got
    /// there: a sharp turn from it waits for a stop (see [`turn_wait`]).
    last_move: Option<(Point, Instant)>,
}

impl Hand {
    pub fn new(ctx: Arc<AutoplayContext>) -> Self {
        Self {
            ctx,
            at: None,
            lean: None,
            glance_at: None,
            last_turn: None,
            waiting_on_draw: false,
            last_move: None,
        }
    }

    /// Forget the hand: the next one starts with nothing known but where
    /// the pointer is, which a new hand does not move.
    pub fn reset(&mut self) {
        *self = Self {
            at: self.at,
            last_move: self.last_move,
            ..Self::new(self.ctx.clone())
        };
    }

    /// Where the pointer is, in CSS pixels, once it has moved.
    pub fn at(&self) -> Option<Point> {
        self.at
    }

    /// Go on from where the user's own mouse left the pointer, if it has
    /// since autoplay last moved it: the page's pointer is there now, and a
    /// move from anywhere else would start with a jump.
    pub fn sync_with_user(&mut self) {
        if let Some(at) = crate::autoplay::cdp_input::take_user_left_pointer() {
            info!(
                "autoplay: pointer taken up where the user's mouse left it ({:.0}, {:.0})",
                at.0, at.1
            );
            self.at = Some(at);
            // The user's hand moved it last; there is no way of ours to turn from.
            self.last_move = None;
        }
    }

    /// When the pointer next looks at the seat's next turn, while it looks.
    pub fn glance_due(&self) -> Option<Instant> {
        self.glance_at
    }

    /// The pointer pressed at `at`.
    pub fn pressed(&mut self, at: Point) {
        self.at = Some(at);
    }

    /// Plan the pointer's way to the plan's first press and take its time
    /// out of the pause that leads the plan. `None` for a plan that does not
    /// open with a pause and a press: there is no thinking time to move in.
    /// `glance` is the runner-up to look at, as a normalised point; `shown_at`
    /// when the frame that opened the decision came, before which the pointer
    /// cannot have seen what it answers (see [`wait_to_see`]).
    pub fn plan_approach(
        &mut self,
        plan: &mut PlanResult,
        rect: CanvasRect,
        glance: Option<(f64, f64)>,
        shown_at: Option<Instant>,
    ) -> Option<Approach> {
        self.sync_with_user();
        let rest_ms = plan.look_ms.unwrap_or(LOOK_MS);
        let [Step::Sleep { duration_ms }, Step::Click { x_norm, y_norm }, ..] =
            plan.steps.as_mut_slice()
        else {
            return None;
        };
        let mut rng = rand::rng();
        // A pointer that has not been anywhere yet starts from where it
        // would have been resting.
        let from = *self.at.get_or_insert_with(|| {
            let (x, y) = humanize::rest_spot(&mut rng);
            rect.pixel(x, y)
        });
        // The runner-up is rested on where a tile is: high on it, as a press.
        let glance = glance.map(|(x, y)| {
            rect.pixel(
                x + humanize::LOOK_OFF_X.draw(&mut rng),
                y + humanize::on_tile_y(&mut rng),
            )
        });
        let mut approach = approach(
            *duration_ms,
            from,
            rect.pixel(*x_norm, *y_norm),
            glance,
            rest_ms,
            rect.width / 16.0,
            &mut rng,
        );
        if let Some(shown_at) = shown_at {
            let seen_at =
                shown_at + Duration::from_millis(u64::from(humanize::SEE.draw_ms(&mut rng)));
            let see_ms = seen_at
                .saturating_duration_since(Instant::now())
                .as_millis();
            wait_to_see(&mut approach, u32::try_from(see_ms).unwrap_or(u32::MAX));
        }
        *duration_ms = approach.pause_ms;
        Some(approach)
    }

    /// Walk the pointer along `approach`. False when it could not be moved.
    pub async fn walk(&mut self, approach: &Approach) -> bool {
        for leg in &approach.legs {
            if !self
                .move_to("approach", leg.to, leg.travel_ms, leg.bend)
                .await
            {
                return false;
            }
            if leg.dwell_ms > 0 {
                tokio::time::sleep(Duration::from_millis(u64::from(leg.dwell_ms))).await;
            }
        }
        true
    }

    /// A new lean from the bot. The pointer keeps its own pace; only a
    /// changed mind brings its next look forward, by a reaction time.
    pub fn take_lean(&mut self, lean: Lean) {
        let changed = self.lean.as_ref().and_then(|l| l.first()) != lean.first();
        self.lean = Some(lean);
        if let (true, Some(at)) = (changed, self.glance_at) {
            self.glance_at = Some(at.min(after_a_reaction()));
        }
    }

    /// A seat's turn began. Once it is `kamicha`, the seat before ours, a
    /// lean on throwing what we draw may look where the draw will land —
    /// after a reaction time, as a person sees their turn coming.
    pub fn took_turn(&mut self, actor: u8, kamicha: Option<u8>) {
        self.last_turn = Some(actor);
        let draw_next = kamicha == Some(actor);
        let leans_on_draw = self.lean.as_ref().and_then(|lean| lean.first()) == Some(Spot::Draw);
        if let (true, true, Some(at)) = (draw_next, leans_on_draw, self.glance_at) {
            self.glance_at = Some(at.min(after_a_reaction()));
        }
    }

    /// Start looking at the next turn, a while after the pointer was last
    /// put to rest — if the pointer is to lean at all.
    pub fn settle_glances(&mut self) {
        let settle = humanize::SETTLE.draw_ms(&mut rand::rng());
        self.glance_at = Some(Instant::now() + Duration::from_millis(u64::from(settle)));
    }

    pub fn stop_glances(&mut self) {
        self.glance_at = None;
        self.lean = None;
    }

    /// The spot this look goes to, if it goes anywhere (see
    /// [`lean::glance`]); the look after it is scheduled either way.
    pub fn next_glance(&mut self) -> Option<Spot> {
        let mut rng = rand::rng();
        let spot = self
            .lean
            .as_ref()
            .and_then(|lean| lean::glance(lean, &mut rng));
        let wait = lean::wait_ms(self.lean.as_ref(), &mut rng);
        self.glance_at = Some(Instant::now() + Duration::from_millis(u64::from(wait)));
        spot
    }

    /// Whether `spot` can be looked at now. Where the draw lands is empty
    /// until the draw: a hand goes there only once its turn is next, when
    /// the last turn was `kamicha`'s, not with the tile still in the wall.
    pub fn may_look_at(&self, spot: &Spot, kamicha: Option<u8>) -> bool {
        !(*spot == Spot::Draw && self.last_turn != kamicha)
    }

    /// Look at `spot` of a hand at rest holding `tehai`, on the canvas at
    /// `rect`.
    pub async fn look_at(&mut self, spot: Spot, tehai: &[String], rect: CanvasRect) {
        self.sync_with_user();
        let pointer = self.at.map(|(x, y)| rect.norm(x, y));
        let leg = {
            let mut rng = rand::rng();
            let point = |spot: &Spot, rng: &mut rand::rngs::ThreadRng| match spot {
                Spot::Hand(pai) => crate::autoplay::majsoul::hand_point(pai, tehai, pointer, rng),
                Spot::Draw => Some(crate::autoplay::majsoul::draw_point(tehai.len())),
            };
            let Some(mut at) = point(&spot, &mut rng) else {
                return;
            };
            // Weighing two tiles is a look between neighbours: one far from
            // the likeliest is not looked at, the likeliest is.
            let first = self.lean.as_ref().and_then(|lean| lean.first());
            if let Some(main) = first
                .filter(|main| *main != spot)
                .and_then(|main| point(&main, &mut rng))
            {
                if (at.0 - main.0).abs() > LOOK_REACH {
                    at = main;
                }
            }
            // A look at the tile the hand is already on is a look that stays.
            if crate::autoplay::majsoul::on_tile(at, pointer) {
                return;
            }
            // Not the middle of the tile every time, and high on it, as a press.
            let at = (
                at.0 + humanize::LOOK_OFF_X.draw(&mut rng),
                at.1 + humanize::on_tile_y(&mut rng),
            );
            let to = rect.pixel(at.0, at.1);
            let from = self.at.unwrap_or(to);
            leave(from, to, rect.width / 16.0, &mut rng)
        };
        // A look is unhurried: half the speed of the way to a press.
        if self
            .move_to("look", leg.to, leg.travel_ms * 2, leg.bend)
            .await
        {
            self.waiting_on_draw = spot == Spot::Draw;
        }
    }

    /// Take the pointer off what the plan last pressed, to somewhere the
    /// client draws nothing under it, and look on to the next turn from
    /// there.
    ///
    /// Not after a tsumogiri the pointer was already waiting for: a hand that
    /// threw the tile it drew stays where it drew it. Nor after a call: the
    /// seat's own discard comes next, and a hand goes from the button to the
    /// tile it throws, not up to wait and straight back down.
    pub async fn rest_after(&mut self, rect: CanvasRect, plan: &PlanResult, action: &MjaiEvent) {
        let threw_draw = matches!(
            action,
            MjaiEvent::Dahai {
                tsumogiri: true,
                ..
            }
        );
        if std::mem::take(&mut self.waiting_on_draw) && threw_draw {
            self.settle_glances();
            return;
        }
        if discards_next(action) {
            return;
        }
        let Some(pressed) = plan.steps.iter().rev().find_map(|s| match s {
            Step::Click { x_norm, y_norm } => Some((*x_norm, *y_norm)),
            _ => None,
        }) else {
            return;
        };
        let from = self.at.unwrap_or_else(|| rect.pixel(pressed.0, pressed.1));
        self.rest_from(from, rect).await;
        self.settle_glances();
    }

    /// Take the pointer off what it last pressed between decisions, to where it waits.
    pub async fn rest(&mut self, rect: CanvasRect) {
        self.sync_with_user();
        if let Some(from) = self.at {
            self.rest_from(from, rect).await;
        }
    }

    async fn rest_from(&mut self, from: Point, rect: CanvasRect) {
        let leg = {
            let mut rng = rand::rng();
            let (x, y) = humanize::rest_spot(&mut rng);
            leave(from, rect.pixel(x, y), rect.width / 16.0, &mut rng)
        };
        tokio::time::sleep(Duration::from_millis(u64::from(leg.dwell_ms))).await;
        self.move_to("rest", leg.to, leg.travel_ms, leg.bend).await;
    }

    /// Take the pointer to `to`, in CSS pixels, and press there, as a press
    /// between decisions is made: a way of its own, then [`Self::tap`]. False
    /// when the pointer could not be moved or the press failed.
    pub async fn press_at(
        &mut self,
        to: Point,
        rect: CanvasRect,
        hover_ms: u32,
        hold_ms: u32,
    ) -> bool {
        self.sync_with_user();
        let leg = {
            let mut rng = rand::rng();
            // A pointer that has not been anywhere yet starts from where it
            // would have been resting.
            let from = *self.at.get_or_insert_with(|| {
                let (x, y) = humanize::rest_spot(&mut rng);
                rect.pixel(x, y)
            });
            leave(from, to, rect.width / 16.0, &mut rng)
        };
        self.move_to("press", leg.to, leg.travel_ms, leg.bend).await
            && self.tap(to, hover_ms, hold_ms).await
    }

    /// Take the pointer to `to`, in CSS pixels, along an arc, for a press no
    /// approach led to: a plan's later presses (the riichi button's tile, a
    /// call's candidate) and presses made again. The press would otherwise
    /// put the pointer there in one jump. Nothing to do where it already is.
    /// False when the pointer could not be moved.
    pub async fn reach(&mut self, to: Point, rect: CanvasRect) -> bool {
        self.sync_with_user();
        let leg = {
            let mut rng = rand::rng();
            let from = *self.at.get_or_insert_with(|| {
                let (x, y) = humanize::rest_spot(&mut rng);
                rect.pixel(x, y)
            });
            if distance(from, to) < 1.0 {
                return true;
            }
            leave(from, to, rect.width / 16.0, &mut rng)
        };
        // The pause after the press before is the plan's own, already made.
        self.move_to("next press", leg.to, leg.travel_ms, leg.bend)
            .await
    }

    /// Press at `to`, in CSS pixels, where the pointer is or all but is:
    /// about `hover_ms` on it first, the button held about `hold_ms`. False
    /// when the press failed.
    pub async fn tap(&mut self, to: Point, hover_ms: u32, hold_ms: u32) -> bool {
        let page_guard = self.ctx.page.read().await;
        let Some(page) = page_guard.as_ref() else {
            warn!("autoplay: no page handle — cannot press");
            return false;
        };
        if let Err(e) = crate::autoplay::cdp_input::dispatch_click_shaped(
            page, to.0, to.1, hover_ms, hold_ms, false,
        )
        .await
        {
            warn!("autoplay: a press between decisions failed: {e:#}");
            return false;
        }
        drop(page_guard);
        self.at = Some(to);
        true
    }

    /// Move the pointer to `to` over `travel_ms`, a move of the `kind` the
    /// log names. False when it could not be moved.
    async fn move_to(&mut self, kind: &str, to: Point, travel_ms: u32, bend: f64) -> bool {
        self.sync_with_user();
        let from = self.at.unwrap_or(to);
        // Whoever planned this move, a hand turns sharply only from a stop.
        let wait = turn_wait(self.last_move, from, to, Instant::now(), &mut rand::rng());
        if let Some(wait) = wait {
            tokio::time::sleep(wait).await;
        }
        info!(
            "autoplay: pointer {kind} ({:.0}, {:.0}) -> ({:.0}, {:.0}) in {travel_ms} ms{}",
            from.0,
            from.1,
            to.0,
            to.1,
            wait.map(|w| format!(", after a stop of {} ms to turn", w.as_millis()))
                .unwrap_or_default()
        );
        let page_guard = self.ctx.page.read().await;
        let Some(page) = page_guard.as_ref() else {
            warn!("autoplay: no page handle — cannot move the pointer");
            return false;
        };
        if let Err(e) = crate::autoplay::cdp_input::travel(page, from, to, travel_ms, bend).await {
            warn!("autoplay: moving the pointer failed: {e:#}");
            return false;
        }
        drop(page_guard);
        self.at = Some(to);
        if let Some(way) = direction(from, to) {
            self.last_move = Some((way, Instant::now()));
        }
        true
    }
}

/// How long a move from `from` to `to` waits before it sets off, when it
/// turns sharply — by more than 60 degrees — from the last move (`last`: its
/// direction and when it ended): long enough that the hand has been still
/// [`humanize::TURN_STOP`] since. A gentle bend, a turn after such a stop
/// anyway (a press's hover and hold count), or a move of a few pixels waits
/// nothing.
fn turn_wait<R: rand::Rng + ?Sized>(
    last: Option<(Point, Instant)>,
    from: Point,
    to: Point,
    now: Instant,
    rng: &mut R,
) -> Option<Duration> {
    let (was, ended) = last?;
    let way = direction(from, to)?;
    if was.0 * way.0 + was.1 * way.1 >= 0.5 {
        return None;
    }
    let stop = Duration::from_millis(u64::from(humanize::TURN_STOP.draw_ms(rng)));
    stop.checked_sub(now.saturating_duration_since(ended))
        .filter(|wait| !wait.is_zero())
}

/// Which way a move from `from` to `to` goes, as a unit vector; `None` for a
/// move of a few pixels, which has no way worth turning from.
fn direction(from: Point, to: Point) -> Option<Point> {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let length = (dx * dx + dy * dy).sqrt();
    (length >= 6.0).then(|| (dx / length, dy / length))
}

/// Whether the seat's own discard follows `action`: a call, after which the
/// seat throws a tile (a kan's or a kita's once its replacement is drawn).
fn discards_next(action: &MjaiEvent) -> bool {
    matches!(
        action,
        MjaiEvent::Chi { .. }
            | MjaiEvent::Pon { .. }
            | MjaiEvent::Daiminkan { .. }
            | MjaiEvent::Kakan { .. }
            | MjaiEvent::Ankan { .. }
            | MjaiEvent::Kita { .. }
    )
}

/// A reaction time from now: how soon a changed plan moves the pointer.
fn after_a_reaction() -> Instant {
    let reaction = humanize::REACTION.draw_ms(&mut rand::rng());
    Instant::now() + Duration::from_millis(u64::from(reaction))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    /// A move that reverses, or turns a corner, right after the last one
    /// waits for a stop; one that goes on the same way, or turns after a
    /// stop long enough, or barely moves, does not.
    #[test]
    fn a_sharp_turn_waits_for_a_stop_and_nothing_else_does() {
        let mut rng = StdRng::seed_from_u64(41);
        let ended = Instant::now();
        let right = Some(((1.0, 0.0), ended));
        let just_after = ended + Duration::from_millis(20);
        let from = (500.0, 500.0);
        // Back the way it came, and a right angle: a stop first.
        for to in [(300.0, 500.0), (500.0, 700.0)] {
            let wait = turn_wait(right, from, to, just_after, &mut rng).expect("a stop");
            let least = humanize::TURN_STOP.low as u64 - 20;
            assert!(wait >= Duration::from_millis(least), "{wait:?}");
            assert!(wait <= Duration::from_millis(humanize::TURN_STOP.high as u64));
        }
        // On the same way, or bending gently: no stop.
        assert_eq!(
            turn_wait(right, from, (700.0, 520.0), just_after, &mut rng),
            None
        );
        assert_eq!(
            turn_wait(right, from, (650.0, 620.0), just_after, &mut rng),
            None
        );
        // Still long enough already, or a nudge of a pixel or two: no stop.
        let later = ended + Duration::from_millis(humanize::TURN_STOP.high as u64);
        assert_eq!(
            turn_wait(right, from, (300.0, 500.0), later, &mut rng),
            None
        );
        assert_eq!(
            turn_wait(right, from, (497.0, 501.0), just_after, &mut rng),
            None
        );
        // Nothing moved before: nothing to turn from.
        assert_eq!(
            turn_wait(None, from, (300.0, 500.0), just_after, &mut rng),
            None
        );
    }

    #[test]
    fn a_call_is_followed_by_the_seats_own_discard_and_a_discard_is_not() {
        let pon = MjaiEvent::Pon {
            actor: 0,
            target: 2,
            pai: "5m".into(),
            consumed: ["5m".into(), "5m".into()],
        };
        let dahai = MjaiEvent::Dahai {
            actor: 0,
            pai: "5m".into(),
            tsumogiri: false,
        };
        assert!(discards_next(&pon));
        assert!(!discards_next(&dahai));
        let reach = MjaiEvent::Reach {
            actor: 0,
            pai: Some("5m".into()),
            tsumogiri: Some(false),
        };
        assert!(!discards_next(&reach));
    }
}
