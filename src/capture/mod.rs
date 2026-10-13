//! Capture — where the WebSocket frames a [`crate::bridge::Bridge`] parses come
//! from.
//!
//! There is one source: the game the desktop shell shows in a Chromium view of
//! its own, watched over the Chrome DevTools Protocol ([`embedded`], [`cdp`]).
//! [`supervisor`] starts and stops it and says how it stands; [`flow`] gives
//! each WebSocket a bridge of its own, which emits mjai events on
//! [`crate::event_bus::MjaiBus`].

pub mod cdp;
pub mod embedded;
pub mod flow;
pub mod supervisor;

use crate::autoplay::AutoplayContext;
use crate::config::Platform;
use crate::event_bus::{MjaiBus, NotifyBus};
use crate::logger::Session;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Notify;

/// Long-lived shutdown signal. The supervisor holds the `Notify` and fires it
/// when capture is to stop. The capture loop treats the future returned by
/// [`ShutdownToken::wait`] as a cooperative cancellation point.
#[derive(Clone)]
pub struct ShutdownToken(Arc<Notify>);

impl ShutdownToken {
    pub fn new() -> (Self, Arc<Notify>) {
        let n = Arc::new(Notify::new());
        (Self(n.clone()), n)
    }

    /// Resolves once shutdown has been requested.
    pub fn wait(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.0.notified().await;
        })
    }
}

/// Everything capture needs to push parsed mjai events into the rest of the
/// core. Cheap to clone (all `Arc`/`Sender`/`Notify`).
#[derive(Clone)]
pub struct CaptureCtx {
    pub session: Arc<Session>,
    pub platform: Platform,
    pub mjai_bus: MjaiBus,
    pub notify_bus: NotifyBus,
    /// Shared with the autoplay manager. Capture writes the game page's
    /// `Page` handle here when it sees the game's WebSocket open; autoplay
    /// reads it to dispatch `Input.dispatchMouseEvent`.
    pub autoplay: Option<Arc<AutoplayContext>>,
    /// What to record of the HTTP traffic capture sees.
    pub http: crate::config::HttpCaptureConfig,
}
