//! The game the desktop shell shows in a Chromium view of its own: where it is,
//! which address it may be sent to, and the loop that captures from it.
use super::{cdp, CaptureCtx, ShutdownToken};
use crate::capture::flow::FlowBridges;
use anyhow::{Context, Result};
use std::sync::Arc;
use std::time::Duration;

/// Where opened replays are exported, under the home the shell gives the core.
const REPLAY_DIR: &str = "./replays";

/// Where the game view is: the shell's local DevTools endpoint, and the page
/// there to watch and send to the game.
#[derive(Debug, Clone)]
pub struct EmbeddedGame {
    pub endpoint: String,
    pub page: cdp::EmbeddedPage,
}

pub async fn discover_endpoint(port: u16) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .no_proxy()
        .build()?;
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(12) {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .send()
            .await
        {
            if let Ok(value) = response.json::<serde_json::Value>().await {
                if let Some(endpoint) = value.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                    let url: reqwest::Url =
                        endpoint.parse().context("invalid local CDP endpoint")?;
                    if url.scheme() == "ws"
                        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
                        && url.port() == Some(port)
                    {
                        return Ok(endpoint.into());
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    anyhow::bail!("the game view did not expose its local CDP endpoint")
}

/// The address an embedded game may be opened at: Mahjong Soul's own site, over
/// HTTPS. The game view is signed in to the player's account, so the
/// configuration cannot be allowed to point it anywhere else.
pub fn game_url(configured: &str) -> Result<reqwest::Url, String> {
    let url: reqwest::Url = configured
        .parse()
        .map_err(|e| format!("Invalid game URL: {e}"))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !["mahjongsoul.com", "maj-soul.com", "majsoul.com"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("内置游戏地址必须是雀魂的 HTTPS 网站。".into());
    }
    Ok(url)
}

impl EmbeddedGame {
    /// Capture until the browser goes away, the loop fails, or `shutdown` is asked for.
    pub async fn run(self, ctx: CaptureCtx, shutdown: ShutdownToken) -> Result<()> {
        let mut hooks = ctx
            .autoplay
            .as_ref()
            .map(|a| crate::bridge::BridgeHooks {
                time_budget: Some(a.time_budget.clone()),
                input_watch: Some(a.input_watch.clone()),
                tenhou_state: Some(a.tenhou_state.clone()),
                riichi_inject: None,
                notify: None,
                replay_dir: None,
            })
            .unwrap_or_default();
        hooks.notify = Some(ctx.notify_bus.clone());
        hooks.replay_dir = Some(crate::util::resolve_dir(std::path::Path::new(REPLAY_DIR)));
        let bridges = Arc::new(FlowBridges::<cdp::FlowKey>::new(
            ctx.session.clone(),
            ctx.platform,
            hooks,
        ));
        tokio::select! {
            result = cdp::run(&self.endpoint, bridges, ctx.mjai_bus, ctx.session.inspector(), ctx.autoplay,
                ctx.http, ctx.notify_bus, Some(self.page)) => result,
            _ = shutdown.wait() => Ok(()),
        }
    }

    /// The address capture reaches the view at, for the status to show: the
    /// endpoint's host and port, without the browser's id.
    pub fn address(&self) -> String {
        self.endpoint
            .parse::<reqwest::Url>()
            .ok()
            .and_then(|url| Some(format!("{}:{}", url.host_str()?, url.port()?)))
            .unwrap_or_else(|| self.endpoint.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_shows_where_the_view_is_and_not_which_browser() {
        let game = EmbeddedGame {
            endpoint: "ws://127.0.0.1:58129/devtools/browser/e579741d-cbe6".into(),
            page: cdp::EmbeddedPage {
                url: "https://game.maj-soul.com/1/".into(),
                target: None,
            },
        };
        assert_eq!(game.address(), "127.0.0.1:58129");
    }

    #[test]
    fn the_game_opens_only_at_its_own_site_over_https() {
        assert!(game_url("https://game.maj-soul.com/1/").is_ok());
        assert!(game_url("https://game.mahjongsoul.com/").is_ok());
        assert!(game_url("http://game.maj-soul.com/1/").is_err());
        assert!(game_url("https://maj-soul.com.example.org/").is_err());
        assert!(game_url("https://notmaj-soul.com/").is_err());
        assert!(game_url("file:///etc/passwd").is_err());
        assert!(game_url("not a url").is_err());
    }
}
