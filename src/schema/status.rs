//! What the core's parts report about themselves: notices for the user, the
//! bot's lifecycle, how capture stands, and one line of the log.
//!
//! These travel on the buses in `crate::event_bus` and, as part of the monitor
//! snapshot, to the shell's interface. Variants are tagged so the wire shape
//! stays stable when a state is added — the interface matches on `state` /
//! `level` / `stage` without positional surprises.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------- Notification ----------

/// How much a notice matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyLevel {
    Info,
    Success,
    Warn,
    Error,
}

/// One frontend-facing notification. Any subsystem may push these onto
/// `event_bus::NotifyBus`; `crate::ipc` forwards them to all webviews as
/// the `notify` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub level: NotifyLevel,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// `true` → frontend keeps the toast until the user dismisses it.
    /// Used for long-running blocking states (e.g. "installing bot deps").
    #[serde(default)]
    pub sticky: bool,
    /// Stable key. Frontends should replace any prior toast with the same
    /// `id`, so progress updates don't pile up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl Notification {
    pub fn info(title: impl Into<String>) -> Self {
        Self::new(NotifyLevel::Info, title)
    }
    pub fn success(title: impl Into<String>) -> Self {
        Self::new(NotifyLevel::Success, title)
    }
    pub fn warn(title: impl Into<String>) -> Self {
        Self::new(NotifyLevel::Warn, title)
    }
    pub fn error(title: impl Into<String>) -> Self {
        Self::new(NotifyLevel::Error, title)
    }

    fn new(level: NotifyLevel, title: impl Into<String>) -> Self {
        Self {
            level,
            title: title.into(),
            body: None,
            sticky: false,
            id: None,
        }
    }

    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn sticky(mut self) -> Self {
        self.sticky = true;
        self
    }

    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
}

// ---------- BotStatus ----------

/// Sub-stage during the slow first-spawn path.
///
/// `SyncingDeps` is the long one — `uv sync` downloads every wheel listed
/// in the bot's `pyproject.toml` into `<bot_dir>/.akagi/venv` on first use,
/// which can take tens of seconds. `Spawning` is the short tail (process
/// creation + waiting for the first react round-trip).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadStage {
    SyncingDeps,
    Spawning,
}

/// Lifecycle state of the active bot subprocess.
///
/// Tagged with `state` so the frontend can match on a string discriminant
/// (`{"state":"loading","bot":"mortal","stage":"syncing_deps"}`) without
/// having to know Rust's untagged-enum trick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BotStatus {
    /// No active bot — waiting for `start_game` (or bot disabled).
    Idle,
    /// First-time install / spawn in progress. UI should show a spinner.
    Loading { bot: String, stage: LoadStage },
    /// Subprocess up and reacting.
    Ready { bot: String, actor_id: u8 },
    /// Spawn or react path failed; runner torn down.
    Error { bot: String, error: String },
    /// Game ended (`EndGame`) — runner dropped, awaiting next start.
    Stopped { bot: String },
}

// ---------- CaptureStatus ----------

/// How capture from the game view stands.
///
/// `descriptor` is where capture reaches the view — the local DevTools
/// address. For showing; not to be parsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CaptureStatus {
    Stopped,
    Running {
        descriptor: String,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        descriptor: Option<String>,
        error: String,
    },
}

// ---------- Logs ----------
//
// One canonical shape for an emitted tracing event: a line of `all.jsonl`.

/// One log event. `ts_ms` is millisecond Unix time (local clock at emit).
/// `fields` carries the structured fields recorded via `tracing` (the
/// canonical `message` is hoisted to its own slot).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts_ms: i64,
    pub level: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub message: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub fields: HashMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_minimal_round_trips() {
        let n = Notification::info("hi");
        let s = serde_json::to_string(&n).unwrap();
        // No body / id; sticky=false is emitted (no skip_if).
        assert_eq!(s, r#"{"level":"info","title":"hi","sticky":false}"#);
        let back: Notification = serde_json::from_str(&s).unwrap();
        assert_eq!(back, n);
    }

    #[test]
    fn notification_full_round_trips() {
        let n = Notification::error("boom")
            .body("stack trace here")
            .sticky()
            .id("bot-load-fail");
        let s = serde_json::to_string(&n).unwrap();
        let back: Notification = serde_json::from_str(&s).unwrap();
        assert_eq!(back, n);
        assert!(s.contains(r#""level":"error""#));
        assert!(s.contains(r#""sticky":true"#));
        assert!(s.contains(r#""id":"bot-load-fail""#));
    }

    #[test]
    fn bot_status_loading_tagged_correctly() {
        let s = BotStatus::Loading {
            bot: "mortal".into(),
            stage: LoadStage::SyncingDeps,
        };
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(
            j,
            r#"{"state":"loading","bot":"mortal","stage":"syncing_deps"}"#
        );
        let back: BotStatus = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn bot_status_ready_round_trips() {
        let s = BotStatus::Ready {
            bot: "example".into(),
            actor_id: 2,
        };
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#"{"state":"ready","bot":"example","actor_id":2}"#);
        let back: BotStatus = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn bot_status_idle_has_no_extra_fields() {
        let s = BotStatus::Idle;
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#"{"state":"idle"}"#);
    }

    #[test]
    fn capture_status_running_round_trips() {
        let s = CaptureStatus::Running {
            descriptor: "127.0.0.1:58129".into(),
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: CaptureStatus = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
        assert_eq!(j, r#"{"state":"running","descriptor":"127.0.0.1:58129"}"#);
    }

    #[test]
    fn capture_status_error_omits_null_descriptor() {
        let s = CaptureStatus::Error {
            descriptor: None,
            error: "connection refused".into(),
        };
        let j = serde_json::to_string(&s).unwrap();
        // skip_serializing_if = Option::is_none → no descriptor key
        assert_eq!(j, r#"{"state":"error","error":"connection refused"}"#);
    }

    #[test]
    fn capture_status_stopped_minimal() {
        let s = CaptureStatus::Stopped;
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#"{"state":"stopped"}"#);
    }

    #[test]
    fn log_entry_round_trips_minimal() {
        // Minimal entry with no file/line/fields — empty fields map and
        // missing optional file/line should not appear in the JSON.
        let e = LogEntry {
            ts_ms: 1_700_000_000_000,
            level: "INFO".into(),
            target: "akagi::lib".into(),
            file: None,
            line: None,
            message: "hello".into(),
            fields: HashMap::new(),
        };
        let j = serde_json::to_string(&e).unwrap();
        assert!(!j.contains("file"), "got: {j}");
        assert!(!j.contains("line"), "got: {j}");
        assert!(!j.contains("fields"), "got: {j}");
        let back: LogEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn log_entry_round_trips_full() {
        let mut fields = HashMap::new();
        fields.insert("seat".into(), serde_json::Value::Number(2.into()));
        fields.insert("kind".into(), serde_json::Value::String("ron".into()));
        let e = LogEntry {
            ts_ms: 1_700_000_000_000,
            level: "WARN".into(),
            target: "akagi::proxy::handler".into(),
            file: Some("src/proxy/handler.rs".into()),
            line: Some(42),
            message: "stalled".into(),
            fields,
        };
        let j = serde_json::to_string(&e).unwrap();
        let back: LogEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(back, e);
    }
}
