//! The presses between decisions ([`crate::autoplay::acts`]): through a
//! hand's result, and on the client's auto-win toggle after a riichi.
//!
//! Majsoul only, with autoplay on, each behind its own switch
//! (`monitor.quick_confirm`, `monitor.riichi_auto_win`).

use super::AutoplayManager;
use crate::autoplay::acts::Act;
use crate::autoplay::cdp_input::user_active;
use crate::autoplay::context::CanvasRect;
use crate::autoplay::humanize;
use crate::autoplay::majsoul::{coords, reach_of};
use crate::autoplay::pixels::{self, Glyph};
use crate::autoplay::pointer::aim;
use crate::config::Platform;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// How long the client takes to draw a toggle's new state after a press.
const REDRAW: Duration = Duration::from_millis(400);

/// How long an act waits for the user's hand to leave the mouse, or for our
/// own decision to be made, before it is looked at again.
const PUT_OFF: Duration = Duration::from_millis(1200);

impl AutoplayManager {
    /// The act due now, if it still is and is wanted.
    pub(super) async fn table_act(&mut self) {
        let confirmed = self.ctx.input_watch.confirmed();
        let Some(act) = self.acts.next(Instant::now(), confirmed, &mut rand::rng()) else {
            return;
        };
        let (wanted, hover_ms, hold_ms) = {
            let cfg = self.cfg.read().await;
            let on = cfg.autoplay.enabled && cfg.platform.kind == Platform::Majsoul;
            let wanted = match act {
                Act::Burst(_) => on && cfg.monitor.quick_confirm,
                Act::AutoWinOn => on && cfg.monitor.riichi_auto_win,
            };
            let majsoul = &cfg.autoplay.majsoul;
            (wanted, majsoul.hover_delay_ms, majsoul.click_hold_ms)
        };
        if !wanted {
            return;
        }
        // The user's hand is on the mouse; and switching auto-win on can wait
        // for our own decision to be made.
        let deciding = self.ctx.time_budget.read().ok().and_then(|g| *g).is_some();
        if user_active() || (act == Act::AutoWinOn && deciding) {
            self.acts.later(act, Instant::now(), PUT_OFF);
            return;
        }
        match act {
            Act::Burst(presses) => self.press_through(presses, hover_ms, hold_ms).await,
            Act::AutoWinOn => self.switch_auto_win_on(hover_ms, hold_ms).await,
        }
    }

    /// One burst of `presses` at the result's confirm button: the first
    /// press as any press between decisions, the rest quick and on the spot.
    /// A burst once begun is pressed to its end, as a hand clicking fast does
    /// not stop the moment the screen changes: the confirm button's corner is
    /// empty table in the next hand. Only the user's hand back on the mouse
    /// stops it; whether another burst follows is asked after it.
    async fn press_through(&mut self, presses: u32, hover_ms: u32, hold_ms: u32) {
        let watch = self.ctx.input_watch.clone();
        if let Some(rect) = self.canvas.resolve(&self.ctx).await {
            let reach = reach_of(coords::CONFIRM);
            let mut at = aim::again(coords::CONFIRM, reach, &mut rand::rng());
            for press in 0..presses {
                if press > 0 {
                    let gap = humanize::BURST_GAP.draw_ms(&mut rand::rng());
                    tokio::time::sleep(Duration::from_millis(u64::from(gap))).await;
                }
                let gone = press == 0 && !self.acts.result_up(watch.confirmed());
                if gone || user_active() {
                    break;
                }
                let pressed = if press == 0 {
                    self.hand
                        .press_at(rect.pixel(at.0, at.1), rect, hover_ms, hold_ms)
                        .await
                } else {
                    // A hand clicking fast barely moves, and never off the button.
                    at = {
                        let mut rng = rand::rng();
                        let (cx, cy) = coords::CONFIRM;
                        (
                            (at.0 + humanize::TAP_DRIFT.draw(&mut rng))
                                .clamp(cx - reach.half_x, cx + reach.half_x),
                            (at.1 + humanize::TAP_DRIFT.draw(&mut rng))
                                .clamp(cy - reach.half_y, cy + reach.half_y),
                        )
                    };
                    self.hand
                        .tap(rect.pixel(at.0, at.1), 0, humanize::TAP_HOLD_MS)
                        .await
                };
                if !pressed {
                    break;
                }
            }
            debug!("autoplay: pressed through a result, a burst of {presses}");
        }
        self.acts
            .burst_done(Instant::now(), watch.confirmed(), &mut rand::rng());
    }

    /// Switch the client's auto-win on by its toggle, left of the table,
    /// reading it first and after. One already on is left alone, and one that
    /// cannot be seen (its strip folded away, or covered) is not pressed.
    async fn switch_auto_win_on(&mut self, hover_ms: u32, hold_ms: u32) {
        let Some(rect) = self.canvas.resolve(&self.ctx).await else {
            return;
        };
        match self.read_toggle(rect, coords::AUTO_WIN).await {
            Glyph::Unlit => {}
            Glyph::Lit => {
                debug!("autoplay: the client's auto-win is on already");
                return;
            }
            Glyph::Absent => {
                debug!("autoplay: the auto-win toggle is not in sight");
                return;
            }
        }
        let at = aim::again(
            coords::AUTO_WIN,
            reach_of(coords::AUTO_WIN),
            &mut rand::rng(),
        );
        let pressed = self
            .hand
            .press_at(rect.pixel(at.0, at.1), rect, hover_ms, hold_ms)
            .await;
        tokio::time::sleep(REDRAW).await;
        match self.read_toggle(rect, coords::AUTO_WIN).await {
            Glyph::Lit if pressed => info!("autoplay: switched the client's auto-win on"),
            glyph => warn!(
                "autoplay: switching the client's auto-win on did not take; it reads {glyph:?}"
            ),
        }
        self.hand.rest(rect).await;
    }

    /// What the toggle whose glyph is at `at` (a normalised point) shows.
    async fn read_toggle(&self, rect: CanvasRect, at: (f64, f64)) -> Glyph {
        let half = coords::TOGGLE_HALF;
        let (x0, y0) = rect.pixel(at.0 - half, at.1 - half);
        let (x1, y1) = rect.pixel(at.0 + half, at.1 + half);
        let page_guard = self.ctx.page.read().await;
        let Some(page) = page_guard.as_ref() else {
            return Glyph::Absent;
        };
        pixels::glyph(page, x0, y0, x1 - x0, y1 - y0)
            .await
            .unwrap_or_else(|e| {
                warn!("autoplay: reading a toggle failed: {e:#}");
                Glyph::Absent
            })
    }
}
