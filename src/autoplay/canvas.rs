//! Where the game's canvas is on the page.
//!
//! Presses are planned in normalised 16:9 points and sent in CSS pixels, so
//! each needs the canvas's bounding rect. Measuring it is a CDP round trip, so
//! the rect is kept for a while ([`TTL`]) in
//! [`AutoplayContext::canvas_rect`], which capture also clears whenever it
//! replaces the page. A retried press measures it afresh.

use crate::autoplay::cdp_input::evaluate_canvas_rect;
use crate::autoplay::context::{AutoplayContext, CanvasRect};
use std::time::{Duration, Instant};
use tracing::debug;

/// How long before a cached rect is treated as stale and measured again.
pub const TTL: Duration = Duration::from_secs(30);

/// When the cached rect was measured; the rect itself is the context's.
#[derive(Debug, Default)]
pub struct Canvas {
    measured_at: Option<Instant>,
}

impl Canvas {
    /// The canvas: the cached rect while it is fresh, else measured.
    pub async fn resolve(&mut self, ctx: &AutoplayContext) -> Option<CanvasRect> {
        if let Some(at) = self.measured_at {
            if at.elapsed() < TTL {
                if let Some(rect) = *ctx.canvas_rect.read().await {
                    return Some(rect);
                }
            }
        }
        self.remeasure(ctx).await
    }

    /// The canvas measured afresh, whatever the cache holds, and cached for
    /// the presses that follow. `None` when the page cannot say.
    pub async fn remeasure(&mut self, ctx: &AutoplayContext) -> Option<CanvasRect> {
        let now = Instant::now();
        let page_guard = ctx.page.read().await;
        let page = page_guard.as_ref()?.clone();
        drop(page_guard);
        match evaluate_canvas_rect(&page).await {
            Ok(rect) => {
                *ctx.canvas_rect.write().await = Some(rect);
                self.measured_at = Some(now);
                Some(rect)
            }
            Err(e) => {
                debug!("autoplay: evaluate_canvas_rect failed: {e:#}");
                None
            }
        }
    }

    /// The rect last measured, however old, without measuring.
    pub async fn cached(ctx: &AutoplayContext) -> Option<CanvasRect> {
        *ctx.canvas_rect.read().await
    }

    /// Forget the rect: the next press measures the canvas again.
    pub async fn forget(&mut self, ctx: &AutoplayContext) {
        self.measured_at = None;
        *ctx.canvas_rect.write().await = None;
    }
}
