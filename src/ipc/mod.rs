//! The application's shared state and capture supervisor, and — in the Tauri
//! application (feature `app`) — the backend ↔ frontend integration over Tauri.
//! The headless core (`crate::headless`) uses the first two and speaks to its
//! shell itself.
//!
//! Two halves wired together by [`install`]:
//!
//! - **Outbound (backend → frontend)**: forwarder tasks subscribe to each
//!   `event_bus` channel and `app.emit()` the payload to every webview.
//!   Status buses additionally mirror the latest value into `AppState`
//!   so a fresh frontend can ask `get_status` for a snapshot.
//! - **Inbound (frontend → backend)**: `#[tauri::command]` handlers in
//!   [`commands`]; register them via the `ipc_handlers!()` macro on the
//!   `tauri::Builder`.
//!
//! Wiring example (in `lib.rs`):
//!
//! ```ignore
//! tauri::Builder::default()
//!     .invoke_handler(akagi::ipc_handlers!())
//!     .setup(move |app| {
//!         akagi::ipc::install(&app.handle(), state.clone())?;
//!         // …rest of setup
//!         Ok(())
//!     })
//!     .run(tauri::generate_context!())?;
//! ```
//!
//! Event names (kebab-case, Tauri convention):
//!
//! | Event             | Payload type                  |
//! |-------------------|-------------------------------|
//! | `mjai-event`       | `schema::MjaiEvent`           |
//! | `bot-response`     | `bot::BotResponse`            |
//! | `bot-status`       | `schema::BotStatus`           |
//! | `capture-status`   | `schema::CaptureStatus`       |
//! | `notify`           | `schema::Notification`        |
//! | `analysis-result`  | `analysis::AnalysisResult`    |
//! | `history-recorded` | `schema::HistoryEvent`        |
//! | `overlay-config`   | `config::OverlayConfig`       |
//!
//! All of the above are broadcast to every webview, which is what lets the
//! [`overlay`] window render suggestions without any dedicated plumbing.
//! `overlay-config` is the exception: it is emitted to the overlay label only.

pub mod capture_supervisor;
#[cfg(feature = "app")]
pub mod commands;
#[cfg(feature = "app")]
mod install;
#[cfg(feature = "app")]
pub mod monitor;
#[cfg(feature = "app")]
pub mod overlay;
pub mod state;

#[cfg(feature = "app")]
pub use install::install;
pub use state::AppState;
