//! Proving the presses: whether the client took them, pressing again when it
//! did not, and recovering a client that has stopped listening.
//!
//! A swallowed click reports success like any other — the page dispatched
//! the events and the engine ignored them — so the proof has to come from the
//! client's own uplink ([`crate::autoplay::verify`]). Only canvas clicks need
//! proving: the Tenhou steps run the client's own handlers, which report
//! their own failure.

use super::decision::Decision;
use super::AutoplayManager;
use crate::autoplay::cdp_input::dispatch_click_shaped;
use crate::autoplay::context::CanvasRect;
use crate::autoplay::platform::{PlanResult, Step};
use crate::autoplay::verify::InputTicket;
use crate::schema::MjaiEvent;
use std::time::Duration;
use tracing::{debug, info, warn};

impl AutoplayManager {
    /// After `plan` was carried out for `action`: prove its presses, recover
    /// a client that has stopped taking them, say so when a riichi did not
    /// go through, and take the pointer off the press.
    pub(super) async fn prove(
        &mut self,
        plan: &PlanResult,
        rect: Option<CanvasRect>,
        ticket: InputTicket,
        decision: &Decision,
        action: &MjaiEvent,
        threw_draw: bool,
    ) {
        let cfg = &decision.cfg;
        // `rect` is `None` for a plan of Tenhou steps, which skips the proof.
        let (true, Some(rect)) = (cfg.verify_input_ms > 0, rect) else {
            if let Some(rect) = rect {
                self.hand.rest_after(rect, plan, threw_draw).await;
            }
            return;
        };
        // What counts as proof. A discard plan is proven by any input.
        // Every other plan pressed action buttons, and for those a
        // plain discard can only be the client's own turn-timeout
        // tsumogiri — it arrives with a human-scale `timeuse` and no
        // `auto_operation` flag, so the wire-level filter cannot drop
        // it, and accepting it would report retries as registered at
        // the exact moments the presses had failed.
        let require_non_discard = !matches!(action, MjaiEvent::Dahai { .. });
        let registered = self
            .verify_and_retry(rect, plan, ticket, decision, action, require_non_discard)
            .await;
        // Once the client stops accepting presses it tends to stay that
        // way for the rest of the game — the failures do not come back
        // one at a time, they arrive and then every remaining decision
        // runs to timeout. A page reload reconnects into the hand
        // through the bridge's GameRestore path, so the way out costs a
        // reconnect rather than the game.
        if registered {
            self.state.dead_clicks = 0;
        } else {
            self.state.dead_clicks += 1;
            if cfg.reload_after_failures > 0 && self.state.dead_clicks >= cfg.reload_after_failures
            {
                warn!(
                    decisions = self.state.dead_clicks,
                    "autoplay: the client has stopped accepting presses — reloading to recover"
                );
                let _ = self.notify.send(
                    crate::schema::Notification::warn("Reloading the game")
                        .body("Clicks stopped registering; reconnecting to recover."),
                );
                self.state.dead_clicks = 0;
                self.reload_page().await;
            }
        }
        // A riichi plan that produced an input command has not
        // necessarily declared anything: if the button press was lost
        // and only the tile press landed, the client sends a plain
        // discard, which the presence check happily accepts. The wire
        // tells them apart, so check, and say so — the tile is gone
        // either way, but the player is now in a hand they did not
        // choose and nothing else would tell them. It is also the one
        // window where the bot's own view can drift: if the declaring
        // tile came from an autoplay reach follow-up (#257), the bot was
        // fed a reach that then did not happen, so flag that too.
        if matches!(action, MjaiEvent::Reach { .. })
            && self.ctx.input_watch.sent_since(ticket)
            && !self.ctx.input_watch.reach_since(ticket)
        {
            warn!(
                "autoplay: riichi was planned for {action:?} but the client sent a plain discard — the declaration press was lost and the tile went out without it"
            );
            let _ = self.notify.send(
                crate::schema::Notification::error("Riichi did not go through").body(
                    "The declaration press was lost and the tile was discarded without it. This hand is not in riichi — and the bot may still believe it declared, so its reads for the rest of this hand can be off.",
                ),
            );
        }
        if registered {
            self.hand.rest_after(rect, plan, threw_draw).await;
        }
    }

    /// Wait for the client's input command; press again if it never came.
    ///
    /// Retrying is bounded and gated on the decision window still being the
    /// one the plan was made for: if our action did land and the answer was
    /// merely slow, the server's echo closes that window and the retry is
    /// dropped rather than pressed into the next decision.
    ///
    /// Each retry measures the canvas again before it presses: a window
    /// resized or moved since the first press would otherwise put every retry
    /// where the target used to be.
    async fn verify_and_retry(
        &mut self,
        rect: CanvasRect,
        plan: &PlanResult,
        ticket: InputTicket,
        decision: &Decision,
        action: &MjaiEvent,
        require_non_discard: bool,
    ) -> bool {
        let cfg = &decision.cfg;
        let clicks: Vec<(f64, f64)> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                Step::Click { x_norm, y_norm } => Some((*x_norm, *y_norm)),
                Step::Sleep { .. }
                | Step::DomClick { .. }
                | Step::Discard { .. }
                | Step::AwaitReady { .. }
                | Step::SendFrame(_) => None,
            })
            .collect();
        if clicks.is_empty() {
            return true;
        }

        let mut rect = rect;
        for attempt in 0..=cfg.click_retries {
            if self
                .wait_for_input(ticket, cfg.verify_input_ms, require_non_discard)
                .await
            {
                if attempt > 0 {
                    info!("autoplay: retry {attempt} registered for {action:?}");
                }
                return true;
            }
            if attempt == cfg.click_retries {
                break;
            }
            if !self.window_still_open(decision.planned_budget) {
                debug!(
                    "autoplay: no input seen for {action:?}, but the decision window has moved on — not retrying"
                );
                return true;
            }
            let again = retry_slice(&clicks, attempt);
            // The coordinates are in the message on purpose: when a button
            // visibly reacts and the action still does not happen, this
            // line is what says which slot was aimed at.
            warn!(
                "autoplay: no input command after clicking {action:?} at {clicks:?} (hover {}ms, hold {}ms); pressing {} of {} click(s) again (attempt {})",
                cfg.hover_delay_ms,
                cfg.click_hold_ms,
                again.len(),
                clicks.len(),
                attempt + 1
            );
            // Retries vary the press rather than repeating it verbatim.
            // A press that lands on the right control and still does not
            // commit is not a positioning problem, so pressing the same way
            // again has nothing new to offer: the second attempt holds
            // longer, the third also nudges the cursor mid-press.
            let hold = retry_hold_ms(cfg.click_hold_ms, attempt);
            let jiggle = attempt >= 1;
            // Where the canvas is now, not where it was when the plan was
            // pressed: the same normalised point lands on the same control.
            if let Some(now) = self.canvas.remeasure(&self.ctx).await {
                if now != rect {
                    info!(
                        "autoplay: the canvas moved from {rect:?} to {now:?} since the last press; pressing where the target is now"
                    );
                }
                rect = now;
            }
            for (i, (x_norm, y_norm)) in again.iter().enumerate() {
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(u64::from(cfg.inter_click_delay_ms)))
                        .await;
                }
                let (px, py) = rect.pixel(*x_norm, *y_norm);
                if !rect.contains(px, py) {
                    warn!(
                        "autoplay: retry click ({px},{py}) outside canvas rect {:?}; skipping",
                        rect
                    );
                    continue;
                }
                let page_guard = self.ctx.page.read().await;
                let Some(page) = page_guard.as_ref() else {
                    warn!("autoplay: no page handle — abandoning retry for {action:?}");
                    return false;
                };
                if let Err(e) =
                    dispatch_click_shaped(page, px, py, cfg.hover_delay_ms, hold, jiggle).await
                {
                    warn!("autoplay: retry dispatch_click failed: {e:#}");
                }
                drop(page_guard);
                self.hand.pressed((px, py));
            }
        }
        // The timings are in the message because a config written before a
        // default changed keeps its stored values, and "the new default
        // never reached me" is otherwise indistinguishable from "the click
        // is landing in the wrong place".
        warn!(
            "autoplay: {action:?} never produced an input command after {} attempt(s) at {clicks:?} (hover {}ms, hold {}ms); if the button visibly reacts to these coordinates the press is being ignored — try longer timings under Settings -> Autoplay",
            cfg.click_retries + 1,
            cfg.hover_delay_ms,
            cfg.click_hold_ms
        );
        false
    }

    /// Poll for an input command until `timeout_ms` runs out. Polling (not
    /// one flat sleep) so a click that worked returns almost immediately and
    /// only a lost one pays the full wait. With `require_non_discard`, a
    /// plain discard does not satisfy the wait — the proof standard for a
    /// plan whose clicks were all action buttons.
    async fn wait_for_input(
        &self,
        ticket: InputTicket,
        timeout_ms: u32,
        require_non_discard: bool,
    ) -> bool {
        const POLL: Duration = Duration::from_millis(20);
        let deadline = std::time::Instant::now() + Duration::from_millis(u64::from(timeout_ms));
        loop {
            let seen = if require_non_discard {
                self.ctx.input_watch.non_discard_since(ticket)
            } else {
                self.ctx.input_watch.sent_since(ticket)
            };
            if seen {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// Whether the decision window the plan was made against is still the
    /// live one. With no budget tracked there is no signal, and the answer
    /// is "yes" — behaviour off-Majsoul is unchanged.
    fn window_still_open(&self, planned: Option<crate::autoplay::budget::TimeBudget>) -> bool {
        let Some(planned) = planned else {
            return true;
        };
        let current = self.ctx.time_budget.read().ok().and_then(|g| *g);
        current.map(|b| b.opened_at) == Some(planned.opened_at)
    }

    /// Reload the game tab. The bridge reconnects into the in-progress
    /// hand through its `GameRestore` path (`syncGame` replay), so the
    /// cost is a reconnect rather than the game.
    async fn reload_page(&mut self) {
        let page_guard = self.ctx.page.read().await;
        let Some(page) = page_guard.as_ref().cloned() else {
            warn!("autoplay: cannot reload — no page handle");
            return;
        };
        drop(page_guard);
        if let Err(e) = page.reload().await {
            warn!("autoplay: page reload failed: {e:#}");
        }
        // The canvas is rebuilt on reload: the next click measures it again.
        self.canvas.forget(&self.ctx).await;
    }
}

/// Which clicks to press again on retry `attempt` (0-based).
///
/// In a multi-click plan — a chi/pon/kan whose candidate row needs
/// disambiguating, or a Path-A riichi — the *last* click is both the one
/// that commits the action and the one most likely to have been swallowed:
/// it fires `inter_click_delay_ms` after the previous press, while the
/// candidate row is still animating in, whereas the opening click follows
/// the full thinking delay against a settled UI.
///
/// So the first retry presses only that last click. If the row never opened
/// because the *opening* click was the one that missed, it lands on empty
/// table and does nothing — a harmless way to be wrong, unlike re-pressing
/// a chi button whose row is already open, whose effect we cannot predict.
/// A second retry then replays the whole sequence on the theory that the
/// opening click was the one lost.
fn retry_slice(clicks: &[(f64, f64)], attempt: u32) -> &[(f64, f64)] {
    if attempt == 0 && clicks.len() > 1 {
        &clicks[clicks.len() - 1..]
    } else {
        clicks
    }
}

/// Hold duration for retry press number `attempt` (0-based). The original
/// press already ran at `base`, so the first retry — the second press
/// overall — is the one that must hold twice as long; `attempt + 1` would
/// have repeated the original hold verbatim and wasted the attempt.
/// Capped so a user-configured long hold cannot escalate past 2 s.
fn retry_hold_ms(base: u32, attempt: u32) -> u32 {
    base.saturating_mul(attempt + 2).min(2_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single-click plan (most of them: discard, pon, ron, skip) has
    /// nothing to escalate — every attempt presses the same one click.
    #[test]
    fn a_single_click_plan_always_retries_that_click() {
        let clicks = [(1.0, 2.0)];
        assert_eq!(retry_slice(&clicks, 0), &clicks[..]);
        assert_eq!(retry_slice(&clicks, 1), &clicks[..]);
    }

    /// A multi-click plan escalates: the committing click first (the one
    /// pressed while the candidate row was still animating), then the whole
    /// sequence. Re-pressing a chi button whose row is already open has an
    /// effect we cannot predict, so it is not the first thing tried.
    #[test]
    fn a_multi_click_plan_retries_the_committing_click_first() {
        let clicks = [(1.0, 2.0), (3.0, 4.0)];
        assert_eq!(
            retry_slice(&clicks, 0),
            &[(3.0, 4.0)],
            "first retry presses only the candidate/tile click"
        );
        assert_eq!(
            retry_slice(&clicks, 1),
            &clicks[..],
            "second retry assumes the opening click was lost too"
        );
    }

    /// Defensive: an empty plan is never verified, but the slice helper
    /// must not panic if it ever is.
    #[test]
    fn no_clicks_is_not_a_panic() {
        let clicks: [(f64, f64); 0] = [];
        assert!(retry_slice(&clicks, 0).is_empty());
        assert!(retry_slice(&clicks, 3).is_empty());
    }

    /// The first retry (attempt 0) is the *second* press overall and must
    /// already escalate the hold — `attempt + 1` would repeat the original
    /// hold verbatim and waste the attempt.
    #[test]
    fn retry_press_escalates_the_hold_from_the_first_retry() {
        assert_eq!(retry_hold_ms(120, 0), 240, "second press holds twice");
        assert_eq!(retry_hold_ms(120, 1), 360);
        assert_eq!(retry_hold_ms(1_500, 1), 2_000, "capped at 2s");
        assert_eq!(retry_hold_ms(u32::MAX, 5), 2_000, "no overflow");
    }
}
