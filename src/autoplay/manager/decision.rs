//! Reading a decision: the bot's answer joined with everything known about
//! the table at that moment, owned so that the stages after it can borrow it.

use super::{AutoplayManager, ManagerState};
use crate::autoplay::budget::TimeBudget;
use crate::autoplay::canvas::Canvas;
use crate::autoplay::delay::{BudgetSnapshot, DecisionProbs, DelayScript, Reading};
use crate::autoplay::platform::ActionContext;
use crate::autoplay::tenhou_state::{DecisionWindow, TenhouState};
use crate::bot::BotResponse;
use crate::config::{DelayModelConfig, MajsoulAutoplayConfig, Platform};
use crate::game_state::snapshot::GameStateSnapshot;
use crate::schema::MjaiEvent;
use riichienv_core::action::Action;
use riichienv_core::state::legal_actions::GameStateLegalActions;
use riichienv_core::state_3p::legal_actions::GameState3PLegalActions;
use tracing::info;

/// One decision's reading of the table.
pub(super) struct Decision {
    pub(super) cfg: MajsoulAutoplayConfig,
    delay_cfg: DelayModelConfig,
    pub(super) platform: Platform,
    /// Tenhou's planner needs the bridge's hand at Tenhou tile-index
    /// resolution; the slot stays empty on every other platform.
    tenhou_state: Option<TenhouState>,
    /// The Tenhou window we plan against, kept as its own identity for the
    /// post-delay staleness check (`tenhou_window_moved`).
    pub(super) planned_window: Option<DecisionWindow>,
    /// The server time budget for the current decision window (written by
    /// the Majsoul bridge; None off-Majsoul or pre-game). Its `opened_at` is
    /// the window's identity for the post-sleep staleness check.
    pub(super) planned_budget: Option<TimeBudget>,
    budget: Option<BudgetSnapshot>,
    probs: Option<DecisionProbs>,
    our_seat: u8,
    legal_actions: Vec<Action>,
    snapshot: GameStateSnapshot,
    num_players: u8,
    reading: Reading,
    /// Where the pointer is, as a normalised point.
    pub(super) pointer: Option<(f64, f64)>,
}

impl Decision {
    /// What the platform plans from.
    pub(super) fn context<'a>(
        &'a self,
        action: &'a MjaiEvent,
        state: &'a ManagerState,
        delay_script: Option<&'a DelayScript>,
    ) -> ActionContext<'a> {
        ActionContext {
            action,
            snapshot: &self.snapshot,
            legal_actions: &self.legal_actions,
            our_seat: self.our_seat,
            last_kawa_tile: state.last_kawa_tile.as_deref(),
            last_self_tsumo: state.last_self_tsumo.as_deref(),
            self_riichi_accepted: state.self_riichi_accepted,
            num_players: self.num_players,
            cfg: &self.cfg,
            delay_cfg: self.delay_cfg.clone(),
            budget: self.budget,
            probs: self.probs,
            reading: self.reading,
            delay_script,
            tenhou: self.tenhou_state.as_ref(),
            pointer: self.pointer,
        }
    }
}

impl AutoplayManager {
    /// Read the table for `resp`. `None` when autoplay is off, or when the
    /// game has not started for our seat.
    pub(super) async fn read_decision(&mut self, resp: &BotResponse) -> Option<Decision> {
        // Re-read config every time so `cfg.autoplay.enabled` can be
        // toggled at runtime via the Settings UI without restarting.
        let cfg_guard = self.cfg.read().await;
        if !cfg_guard.autoplay.enabled {
            return None;
        }
        let cfg = cfg_guard.autoplay.majsoul.clone();
        let delay_cfg = cfg_guard.autoplay.delay.clone();
        let platform = cfg_guard.platform.kind;
        drop(cfg_guard);

        let tenhou_state = self.ctx.tenhou_state.read().ok().and_then(|g| g.clone());
        let planned_window = tenhou_state.as_ref().and_then(|s| s.window);

        // The time budget and the bot's confidence both feed the delay model
        // — neither can alter the chosen action.
        let planned_budget = self.ctx.time_budget.read().ok().and_then(|g| *g);
        let budget = planned_budget.map(|b| BudgetSnapshot {
            fixed_ms: b.fixed_ms,
            add_ms: b.add_ms,
            elapsed_ms: b.elapsed_ms(),
        });
        let probs = crate::autoplay::delay::probs::normalize_meta(resp.meta.as_ref());

        // The delay script lives at a fixed path next to the config file.
        // In Lua mode it is generated from the bundled default when
        // missing, then hot-reloaded on change (cheap mtime stat). In
        // legacy mode the script is dropped entirely.
        let lua_mode = delay_cfg.mode == crate::config::DelayMode::Lua;
        let script_path = self.config_dir.join("delay.lua");
        if lua_mode {
            self.delay_script.ensure_default(&script_path);
        }
        self.delay_script.maybe_reload(&script_path, lua_mode);

        // Pull our seat + legal actions from the live engine state. This
        // bracket releases the tracker mutex before we sleep/click.
        let (our_seat, legal_actions, snapshot, num_players) = {
            let tracker = self.tracker.lock().await;
            // No seat: the game hasn't started or no perspective is tagged.
            let our_seat = tracker.our_seat()?;
            // Keep cached_our_seat up to date for handle_mjai_event.
            self.state.cached_our_seat = Some(our_seat);
            let snapshot = tracker.snapshot()?;
            let num_players = snapshot.num_players;
            let legal_actions: Vec<Action> = if num_players == 3 {
                tracker
                    .state_3p()
                    .map(|s| s._get_legal_actions_internal(our_seat))
                    .unwrap_or_default()
            } else {
                tracker
                    .state()
                    .map(|s| s._get_legal_actions_internal(our_seat))
                    .unwrap_or_default()
            };
            (our_seat, legal_actions, snapshot, num_players)
        };

        let reading = self.reading(resp, &snapshot, our_seat);
        // One line a decision, for measuring a pace against afterwards.
        info!(action = ?resp.action, ?probs, ?reading, "autoplay: decision read");

        // Where the pointer is now: a discard of the tile it rests on presses
        // that copy, not its twin. The user's own mouse may have left it somewhere.
        self.hand.sync_with_user();
        let pointer = match self.hand.at() {
            Some((px, py)) => Canvas::cached(&self.ctx)
                .await
                .map(|rect| rect.norm(px, py)),
            None => None,
        };
        Some(Decision {
            cfg,
            delay_cfg,
            platform,
            tenhou_state,
            planned_window,
            planned_budget,
            budget,
            probs,
            our_seat,
            legal_actions,
            snapshot,
            num_players,
            reading,
            pointer,
        })
    }

    /// What the table and a second opinion say about this decision (see
    /// `autoplay::table`, `autoplay::advisor`). Like the probabilities it
    /// feeds the delay model and cannot alter the chosen action.
    fn reading(
        &mut self,
        resp: &BotResponse,
        snapshot: &GameStateSnapshot,
        our_seat: u8,
    ) -> Reading {
        let (loose, runner_up_loose, safe) = match &resp.action {
            MjaiEvent::Dahai { pai, .. } => {
                let hand = snapshot
                    .players
                    .get(our_seat as usize)
                    .map_or(&[][..], |p| p.tehai.as_slice());
                let candidates = crate::autoplay::delay::probs::candidates(resp.meta.as_ref());
                let riichi_rivers: Vec<Vec<&str>> = snapshot
                    .players
                    .iter()
                    .filter(|p| p.seat != our_seat && p.riichi_declared)
                    .map(|p| p.river.iter().map(|d| d.tile.as_str()).collect())
                    .collect();
                (
                    Some(crate::autoplay::table::is_loose(pai, hand)),
                    crate::autoplay::pointer::runner_up(&candidates, pai)
                        .map(|other| crate::autoplay::table::is_loose(other, hand)),
                    crate::autoplay::table::is_safe(pai, &riichi_rivers),
                )
            }
            _ => (None, None, None),
        };
        Reading {
            loose,
            runner_up_loose,
            safe,
            human: self.advisor.view(&resp.action),
        }
    }
}
