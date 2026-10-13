//! Versioned, read-only observations for the monitoring workspace.
//! No UI subscriber can start a bot or mutate game state through this cache.

use crate::bot::{BotResponse, ServiceStatus};
use crate::game_state::{GameStateSnapshot, MahgenView};
use crate::schema::{BotStatus, CaptureStatus, MjaiEvent, Notification, NotifyLevel};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionContext {
    pub game: u64,
    pub round: u64,
    pub event_seq: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorEvent {
    pub seq: u64,
    pub ts_ms: i64,
    pub event: MjaiEvent,
}

#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub id: u64,
    pub context: DecisionContext,
    pub started_ms: i64,
    pub completed_ms: Option<i64>,
    pub reaction_ms: Option<u64>,
    pub bot: String,
    pub trigger: MjaiEvent,
    /// thinking / awaiting / confirmed / expired / failed / unavailable / declined
    pub state: String,
    pub response: Option<BotResponse>,
    pub error: Option<String>,
    pub confirmed_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicHand {
    pub seat: u8,
    pub tiles: Vec<String>,
    pub winning_tile: Option<String>,
    pub target: Option<u8>,
    pub ura_markers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoundResult {
    pub kind: String,
    pub hands: Vec<PublicHand>,
    pub scores: Option<Vec<i32>>,
    pub deltas: Option<Vec<i32>>,
}

/// One thing a bot or its service wants the user to know, shown as it is
/// written: the monitor does not interpret it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub name: String,
    pub value: String,
    /// A longer explanation, shown on demand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The `facts` list of a reply's `meta` or of a service's `ready` line.
/// Anything that is not a well-formed fact is left out.
pub fn facts_of(value: Option<&serde_json::Value>) -> Vec<Fact> {
    value
        .and_then(|v| v.as_array())
        .map(|facts| {
            facts
                .iter()
                .filter_map(|fact| serde_json::from_value(fact.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorSnapshot {
    pub revision: u64,
    pub context: DecisionContext,
    pub names: Vec<String>,
    pub red_fives: Option<bool>,
    pub game: Option<GameStateSnapshot>,
    pub view: Option<MahgenView>,
    pub round_ended: bool,
    pub game_ended: bool,
    pub capture: CaptureStatus,
    pub bot: BotStatus,
    /// unknown / connected / error; independent of the Bot process state.
    pub service: String,
    pub service_error: Option<String>,
    /// The process behind `service` when the app runs it: whether it is up,
    /// not whether the bot has reached it.
    pub server: ServiceStatus,
    pub sync_error: Option<String>,
    /// The name the window goes by: the active bot's display name.
    pub brand: String,
    /// What the bot's latest reply said about itself (`meta.facts`).
    pub facts: Vec<Fact>,
    pub autoplay_enabled: bool,
    pub decision: Option<Decision>,
    pub previous_decision: Option<Decision>,
    pub result: Option<RoundResult>,
    pub previous_result: Option<RoundResult>,
    pub events: VecDeque<MonitorEvent>,
    pub last_event_ms: Option<i64>,
}

impl Default for MonitorSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            context: DecisionContext {
                game: 0,
                round: 0,
                event_seq: 0,
            },
            names: vec![],
            red_fives: None,
            game: None,
            view: None,
            round_ended: true,
            game_ended: true,
            capture: CaptureStatus::Stopped,
            bot: BotStatus::Idle,
            service: "unknown".into(),
            service_error: None,
            server: ServiceStatus::None,
            sync_error: None,
            brand: "Akagi".into(),
            facts: vec![],
            autoplay_enabled: false,
            decision: None,
            previous_decision: None,
            result: None,
            previous_result: None,
            events: VecDeque::new(),
            last_event_ms: None,
        }
    }
}

struct Inner {
    snapshot: MonitorSnapshot,
    next_decision: u64,
}

#[derive(Clone)]
pub struct MonitorHandle {
    inner: Arc<Mutex<Inner>>,
    updates: watch::Sender<MonitorSnapshot>,
}

impl Default for MonitorHandle {
    fn default() -> Self {
        let snapshot = MonitorSnapshot::default();
        let (updates, _) = watch::channel(snapshot.clone());
        Self {
            inner: Arc::new(Mutex::new(Inner {
                snapshot,
                next_decision: 0,
            })),
            updates,
        }
    }
}

impl MonitorHandle {
    pub fn snapshot(&self) -> MonitorSnapshot {
        self.updates.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<MonitorSnapshot> {
        self.updates.subscribe()
    }

    fn update<T>(&self, change: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.inner.lock().expect("monitor lock poisoned");
        let result = change(&mut inner);
        inner.snapshot.revision += 1;
        self.updates.send_replace(inner.snapshot.clone());
        result
    }

    /// Called by the tracker before it publishes the corresponding TrackedEvent.
    pub fn game_event(
        &self,
        event: &MjaiEvent,
        game: Option<GameStateSnapshot>,
        error: Option<String>,
    ) -> DecisionContext {
        self.update(|inner| {
            let s = &mut inner.snapshot;
            s.context.event_seq += 1;
            let now = chrono::Local::now().timestamp_millis();
            if let MjaiEvent::StartGame {
                names, aka_flag, ..
            } = event
            {
                s.context.game += 1;
                s.context.round = 0;
                s.names = names.clone();
                s.red_fives = *aka_flag;
                s.decision = None;
                s.previous_decision = None;
                s.result = None;
                s.previous_result = None;
                s.events.clear();
                s.game_ended = false;
                s.round_ended = true;
                s.sync_error = None;
                s.service = "unknown".into();
                s.service_error = None;
                s.facts.clear();
            }
            if matches!(event, MjaiEvent::StartKyoku { .. }) {
                expire(&mut s.decision);
                s.previous_decision = s.decision.take().or(s.previous_decision.take());
                s.previous_result = s.result.take().or(s.previous_result.take());
                s.context.round += 1;
                s.round_ended = false;
                s.events.clear();
                s.sync_error = None;
            }
            let mut game = game;
            // The monitor is a public view even when an offline replay contains
            // omniscient engine state. Public reveals have their own provenance.
            if let Some(g) = &mut game {
                for player in &mut g.players {
                    if Some(player.seat) != g.our_seat {
                        player.tehai.fill("?".into());
                        player.drawn_tile = None;
                    }
                }
            }
            s.view = game.as_ref().map(MahgenView::from_snapshot);
            s.game = game;
            if let Some(error) = error {
                s.sync_error = Some(error);
                expire(&mut s.decision);
            }
            match event {
                MjaiEvent::Hora {
                    actor,
                    target,
                    tehai,
                    pai,
                    scores,
                    deltas,
                    ura_markers,
                } => {
                    let result = s.result.get_or_insert_with(|| RoundResult {
                        kind: "hora".into(),
                        hands: vec![],
                        scores: None,
                        deltas: None,
                    });
                    if let Some(tiles) = tehai.as_ref().filter(|t| public_tiles(t)) {
                        if !result.hands.iter().any(|h| h.seat == *actor) {
                            result.hands.push(PublicHand {
                                seat: *actor,
                                tiles: tiles.clone(),
                                winning_tile: pai.clone(),
                                target: Some(*target),
                                ura_markers: ura_markers.clone().unwrap_or_default(),
                            });
                        }
                    }
                    if scores.is_some() {
                        result.scores = scores.clone();
                    }
                    if deltas.is_some() {
                        result.deltas = deltas.clone();
                    }
                    s.round_ended = true;
                }
                MjaiEvent::Ryukyoku {
                    tehais,
                    scores,
                    deltas,
                    reason,
                } => {
                    let hands = tehais
                        .as_ref()
                        .map(|hands| {
                            hands
                                .iter()
                                .enumerate()
                                .filter_map(|(seat, hand)| {
                                    hand.as_ref().filter(|t| public_tiles(t)).map(|tiles| {
                                        PublicHand {
                                            seat: seat as u8,
                                            tiles: tiles.clone(),
                                            winning_tile: None,
                                            target: None,
                                            ura_markers: vec![],
                                        }
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    s.result = Some(RoundResult {
                        kind: reason.clone().unwrap_or_else(|| "draw".into()),
                        hands,
                        scores: scores.clone(),
                        deltas: deltas.clone(),
                    });
                    s.round_ended = true;
                }
                MjaiEvent::EndKyoku => s.round_ended = true,
                MjaiEvent::EndGame { .. } => {
                    s.game_ended = true;
                    s.round_ended = true;
                }
                _ => {}
            }
            // Settlement scores are authoritative. Do not reapply aggregate
            // deltas on each winner in a multi-ron sequence.
            if let (Some(game), Some(scores)) = (
                &mut s.game,
                s.result.as_ref().and_then(|r| r.scores.as_ref()),
            ) {
                for player in &mut game.players {
                    if let Some(score) = scores.get(player.seat as usize) {
                        player.score = *score;
                    }
                }
            }
            s.last_event_ms = Some(now);
            let mut visible_event = event.clone();
            if let MjaiEvent::StartKyoku { tehais, .. } = &mut visible_event {
                let seat = s.game.as_ref().and_then(|g| g.our_seat);
                for (i, tiles) in tehais.iter_mut().enumerate() {
                    if Some(i as u8) != seat {
                        tiles.fill("?".into());
                    }
                }
            }
            if let MjaiEvent::Tsumo { actor, pai } = &mut visible_event {
                if Some(*actor) != s.game.as_ref().and_then(|g| g.our_seat) {
                    *pai = "?".into();
                }
            }
            s.events.push_back(MonitorEvent {
                seq: s.context.event_seq,
                ts_ms: now,
                event: visible_event,
            });
            while s.events.len() > 80 {
                s.events.pop_front();
            }
            confirm(s);
            if s.round_ended {
                expire(&mut s.decision);
            }
            s.context
        })
    }

    pub fn begin(&self, context: DecisionContext, bot: &str, trigger: &MjaiEvent) -> Option<u64> {
        self.update(|inner| {
            let s = &mut inner.snapshot;
            if !same_round(context, s.context) || s.round_ended || s.sync_error.is_some() {
                return None;
            }
            inner.next_decision += 1;
            expire(&mut s.decision);
            s.previous_decision = s.decision.take().or(s.previous_decision.take());
            s.decision = Some(Decision {
                id: inner.next_decision,
                context,
                bot: bot.into(),
                trigger: trigger.clone(),
                started_ms: chrono::Local::now().timestamp_millis(),
                completed_ms: None,
                reaction_ms: None,
                state: "thinking".into(),
                response: None,
                error: None,
                confirmed_seq: None,
            });
            Some(inner.next_decision)
        })
    }

    pub fn complete(&self, id: u64, response: &BotResponse, reaction_ms: u64) {
        self.update(|inner| {
            let s = &mut inner.snapshot;
            let Some(d) = &mut s.decision else {
                return;
            };
            if d.id != id || !same_round(d.context, s.context) {
                return;
            }
            d.completed_ms = Some(chrono::Local::now().timestamp_millis());
            d.reaction_ms = Some(reaction_ms);
            d.response = Some(response.clone());
            d.state = if s.round_ended || s.sync_error.is_some() {
                "expired"
            } else if matches!(response.action, MjaiEvent::None) {
                if response
                    .meta
                    .as_ref()
                    .is_some_and(|m| m.get("show").is_some())
                {
                    "declined"
                } else {
                    "unavailable"
                }
            } else {
                "awaiting"
            }
            .into();
            if let Some(meta) = &response.meta {
                // A reply that says nothing about the bot leaves what the last one said.
                if meta.get("facts").is_some() {
                    s.facts = facts_of(meta.get("facts"));
                }
                if meta.get("show").is_some() {
                    s.service = "connected".into();
                    s.service_error = None;
                }
            }
            confirm(s);
        });
    }

    pub fn fail(&self, id: u64, error: String) {
        self.update(|inner| {
            if let Some(d) = &mut inner.snapshot.decision {
                if d.id == id {
                    d.state = "failed".into();
                    d.error = Some(error);
                }
            }
        });
    }

    pub fn gap(&self, detail: String) {
        self.update(|i| {
            i.snapshot.sync_error = Some(detail);
            expire(&mut i.snapshot.decision);
        });
    }
    pub fn set_capture(&self, capture: CaptureStatus) {
        self.update(|i| {
            if !matches!(capture, CaptureStatus::Running { .. }) {
                expire(&mut i.snapshot.decision);
            }
            i.snapshot.capture = capture;
        });
    }
    pub fn set_bot(&self, bot: BotStatus) {
        self.update(|i| {
            if matches!(
                bot,
                BotStatus::Error { .. } | BotStatus::Stopped { .. } | BotStatus::Idle
            ) {
                expire(&mut i.snapshot.decision);
            }
            i.snapshot.bot = bot;
        });
    }
    pub fn set_autoplay(&self, enabled: bool) {
        self.update(|i| i.snapshot.autoplay_enabled = enabled);
    }
    pub fn set_server(&self, server: ServiceStatus) {
        self.update(|i| i.snapshot.server = server);
    }
    pub fn set_brand(&self, brand: String) {
        self.update(|i| i.snapshot.brand = brand);
    }

    pub fn notification(&self, notice: &Notification) {
        let Some(id) = notice.id.as_deref() else {
            return;
        };
        let bot = match &self.snapshot().bot {
            BotStatus::Ready { bot, .. }
            | BotStatus::Loading { bot, .. }
            | BotStatus::Error { bot, .. }
            | BotStatus::Stopped { bot } => bot.clone(),
            _ => String::new(),
        };
        let suffix = id.strip_prefix(&format!("{bot}-"));
        let Some(suffix) = suffix.filter(|_| !bot.is_empty()) else {
            return;
        };
        self.update(|i| {
            let s = &mut i.snapshot;
            let fault = matches!(notice.level, NotifyLevel::Error | NotifyLevel::Warn);
            if suffix == "server" {
                s.service = if fault { "error" } else { "connected" }.into();
                s.service_error =
                    fault.then(|| notice.body.clone().unwrap_or_else(|| notice.title.clone()));
                if fault {
                    expire(&mut s.decision);
                }
            } else if fault && ["desync", "unsupported", "error"].contains(&suffix) {
                s.sync_error = Some(notice.body.clone().unwrap_or_else(|| notice.title.clone()));
                expire(&mut s.decision);
            }
        });
    }
}

fn public_tiles(tiles: &[String]) -> bool {
    !tiles.is_empty() && tiles.iter().all(|t| t != "?" && !t.is_empty())
}
fn same_round(a: DecisionContext, b: DecisionContext) -> bool {
    a.game == b.game && a.round == b.round
}
fn expire(decision: &mut Option<Decision>) {
    if let Some(d) = decision {
        if d.state == "thinking" || d.state == "awaiting" {
            d.state = "expired".into();
        }
    }
}

fn confirm(s: &mut MonitorSnapshot) {
    let Some(d) = &mut s.decision else {
        return;
    };
    if d.state != "awaiting" || !same_round(d.context, s.context) {
        return;
    }
    let Some(response) = &d.response else {
        return;
    };
    let events: Vec<_> = s
        .events
        .iter()
        .filter(|e| e.seq > d.context.event_seq)
        .collect();
    let actor = match &response.action {
        MjaiEvent::Reach { actor, .. } => Some(*actor),
        action => action_actor(action).or(s.game.as_ref().and_then(|g| g.our_seat)),
    };
    let actual = events
        .iter()
        .find(|e| action_actor(&e.event) == actor && actor.is_some());
    if let MjaiEvent::Reach { actor, pai } = &response.action {
        let declared = events
            .iter()
            .any(|e| matches!(&e.event, MjaiEvent::Reach { actor: a, .. } if a == actor));
        if declared {
            if let Some(e) = actual.filter(|e| matches!(&e.event, MjaiEvent::Dahai { actor: a, pai: p, .. } if a == actor && pai.as_ref().is_none_or(|expected| expected == p))) {
                d.state = "confirmed".into(); d.confirmed_seq = Some(e.seq);
            }
        }
    } else if let Some(e) = actual.filter(|e| action_matches(&response.action, &e.event)) {
        d.state = "confirmed".into();
        d.confirmed_seq = Some(e.seq);
    }
    // A real own action different from the plan invalidates the suggestion.
    if d.state == "awaiting" {
        if actual.is_some() {
            d.state = "expired".into();
            d.error = Some("The game confirmed a different action.".into());
        }
    }
}

// Declarations alone do not commit a move. Use the first actual own move
// after the trigger, so a matching tile on a later turn cannot confirm it.
fn action_actor(event: &MjaiEvent) -> Option<u8> {
    match event {
        MjaiEvent::Dahai { actor, .. }
        | MjaiEvent::Chi { actor, .. }
        | MjaiEvent::Pon { actor, .. }
        | MjaiEvent::Daiminkan { actor, .. }
        | MjaiEvent::Ankan { actor, .. }
        | MjaiEvent::Kakan { actor, .. }
        | MjaiEvent::Kita { actor, .. }
        | MjaiEvent::Hora { actor, .. } => Some(*actor),
        _ => None,
    }
}

fn action_matches(a: &MjaiEvent, b: &MjaiEvent) -> bool {
    match (a, b) {
        (
            MjaiEvent::Dahai {
                actor: a, pai: p, ..
            },
            MjaiEvent::Dahai {
                actor: b, pai: q, ..
            },
        ) => a == b && p == q,
        (
            MjaiEvent::Hora {
                actor: a,
                target: t,
                ..
            },
            MjaiEvent::Hora {
                actor: b,
                target: u,
                ..
            },
        ) => a == b && t == u,
        (
            MjaiEvent::Chi { .. }
            | MjaiEvent::Pon { .. }
            | MjaiEvent::Daiminkan { .. }
            | MjaiEvent::Ankan { .. }
            | MjaiEvent::Kakan { .. }
            | MjaiEvent::Kita { .. },
            _,
        ) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(json: &str) -> MjaiEvent {
        serde_json::from_str(json).unwrap()
    }
    fn hand(m: &MonitorHandle) -> DecisionContext {
        m.game_event(
            &event(r#"{"type":"start_game","id":0,"names":["a","b","c","d"],"aka_flag":true}"#),
            None,
            None,
        );
        m.game_event(&event(r#"{"type":"start_kyoku","bakaze":"E","dora_marker":"1m","kyoku":1,"honba":0,"kyotaku":0,"oya":0,"scores":[25000,25000,25000,25000],"tehais":[[],[],[],[]]}"#), None, None)
    }
    fn response(json: &str) -> BotResponse {
        serde_json::from_str(json).unwrap()
    }
    #[test]
    fn stale_round_reply_is_not_current() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        hand(&m);
        m.complete(
            id,
            &response(r#"{"type":"dahai","actor":0,"pai":"5mr","tsumogiri":false}"#),
            140,
        );
        assert!(m.snapshot().decision.is_none());
    }
    #[test]
    fn what_a_bot_says_about_itself_is_kept_as_written_until_it_says_otherwise() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.complete(
            id,
            &response(
                r#"{"type":"dahai","actor":0,"pai":"1m","tsumogiri":false,"meta":{"facts":[{"name":"Depth","value":"42 plies","note":"Counted from the deal."},{"value":"nameless"}]}}"#,
            ),
            140,
        );
        let facts = m.snapshot().facts;
        assert_eq!(facts.len(), 1, "a fact is a name and a value");
        assert_eq!(
            (facts[0].name.as_str(), facts[0].value.as_str()),
            ("Depth", "42 plies")
        );
        assert_eq!(facts[0].note.as_deref(), Some("Counted from the deal."));

        // A reply that says nothing about the bot leaves the last word standing.
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.complete(
            id,
            &response(r#"{"type":"none","meta":{"show":{"items":[]}}}"#),
            90,
        );
        assert_eq!(m.snapshot().facts.len(), 1);
    }
    #[test]
    fn red_identity_is_required_and_early_wire_echo_confirms() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.game_event(
            &event(r#"{"type":"dahai","actor":0,"pai":"5mr","tsumogiri":false}"#),
            None,
            None,
        );
        m.complete(
            id,
            &response(r#"{"type":"dahai","actor":0,"pai":"5mr","tsumogiri":false}"#),
            140,
        );
        assert_eq!(m.snapshot().decision.unwrap().state, "confirmed");
        assert!(!action_matches(
            &event(r#"{"type":"dahai","actor":0,"pai":"5m","tsumogiri":false}"#),
            &event(r#"{"type":"dahai","actor":0,"pai":"5mr","tsumogiri":false}"#)
        ));
    }
    #[test]
    fn discard_without_reach_never_confirms_riichi() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.complete(
            id,
            &response(r#"{"type":"reach","actor":0,"pai":"3p"}"#),
            80,
        );
        m.game_event(
            &event(r#"{"type":"dahai","actor":0,"pai":"3p","tsumogiri":false}"#),
            None,
            None,
        );
        assert_ne!(m.snapshot().decision.unwrap().state, "confirmed");
    }
    #[test]
    fn partial_draw_and_multi_ron_keep_only_explicit_reveals() {
        let m = MonitorHandle::default();
        hand(&m);
        m.game_event(&event(r#"{"type":"ryukyoku","tehais":[null,["5pr","P"],[],null],"reason":"exhaustive","scores":[24000,28000,24000,24000]}"#), None, None);
        let result = m.snapshot().result.unwrap();
        assert_eq!(result.hands.len(), 1);
        assert_eq!(result.hands[0].tiles[0], "5pr");
        hand(&m);
        for seat in [1, 2] {
            m.game_event(&event(&format!(r#"{{"type":"hora","actor":{seat},"target":0,"tehai":["P"],"pai":"5mr","deltas":[-8000,4000,4000,0]}}"#)), None, None);
        }
        let result = m.snapshot().result.unwrap();
        assert_eq!(result.hands.len(), 2);
        assert_eq!(result.deltas.unwrap()[0], -8000);
        assert_eq!(result.hands[0].tiles.len(), 1);
    }
    #[test]
    fn none_on_service_failure_cannot_show_a_fresh_success() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        m.set_bot(BotStatus::Ready {
            bot: "demo".into(),
            actor_id: 0,
        });
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.notification(&Notification::error("unreachable").id("demo-server"));
        m.complete(id, &response(r#"{"type":"none"}"#), 4000);
        assert_eq!(m.snapshot().service, "error");
        assert_eq!(m.snapshot().decision.unwrap().state, "unavailable");
    }
    #[test]
    fn notices_require_the_current_bot_namespace() {
        let m = MonitorHandle::default();
        hand(&m);
        m.set_bot(BotStatus::Ready {
            bot: "demo".into(),
            actor_id: 0,
        });
        m.notification(&Notification::error("Socket closed").id("demo-server"));
        assert_eq!(m.snapshot().service, "error");
        m.set_bot(BotStatus::Ready {
            bot: "another-bot".into(),
            actor_id: 0,
        });
        m.notification(&Notification::info("Connected").id("demo-server"));
        assert_ne!(m.snapshot().service, "connected");
    }
    #[test]
    fn later_matching_discard_cannot_confirm_an_old_suggestion() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        for tile in ["1m", "5mr"] {
            m.game_event(
                &event(&format!(
                    r#"{{"type":"dahai","actor":0,"pai":"{tile}","tsumogiri":false}}"#
                )),
                None,
                None,
            );
        }
        m.complete(
            id,
            &response(r#"{"type":"dahai","actor":0,"pai":"5mr","tsumogiri":false}"#),
            400,
        );
        assert_eq!(m.snapshot().decision.unwrap().state, "expired");
    }
    #[test]
    fn riichi_needs_both_declaration_and_the_selected_red_discard() {
        let m = MonitorHandle::default();
        let context = hand(&m);
        let id = m.begin(context, "demo", &MjaiEvent::None).unwrap();
        m.complete(
            id,
            &response(r#"{"type":"reach","actor":0,"pai":"5pr"}"#),
            100,
        );
        m.game_event(&event(r#"{"type":"reach","actor":0}"#), None, None);
        assert_eq!(m.snapshot().decision.as_ref().unwrap().state, "awaiting");
        m.game_event(
            &event(r#"{"type":"dahai","actor":0,"pai":"5pr","tsumogiri":false}"#),
            None,
            None,
        );
        assert_eq!(m.snapshot().decision.unwrap().state, "confirmed");
    }
}
