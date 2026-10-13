//! Isolated WebView2 game capture using the same CDP route and autoplay Page
//! as a controlled Chromium browser. No new model session is opened here.
use super::{CaptureBackend, CaptureCtx, CaptureDescriptor, CaptureKind, ShutdownToken};
use crate::capture::chromium::cdp;
use crate::capture::flow::FlowBridges;
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

pub struct EmbeddedBackend {
    pub endpoint: String,
    pub initial_url: String,
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
                    let url: tauri::Url =
                        endpoint.parse().context("invalid WebView2 CDP endpoint")?;
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
    anyhow::bail!("WebView2 did not expose its local CDP endpoint")
}

#[async_trait]
impl CaptureBackend for EmbeddedBackend {
    async fn run(self: Box<Self>, ctx: CaptureCtx, shutdown: ShutdownToken) -> Result<()> {
        let mut hooks = ctx
            .autoplay
            .as_ref()
            .map(|a| crate::bridge::BridgeHooks {
                time_budget: Some(a.time_budget.clone()),
                input_watch: Some(a.input_watch.clone()),
                tenhou_state: Some(a.tenhou_state.clone()),
                riichi_inject: None,
                notify: None,
            })
            .unwrap_or_default();
        hooks.notify = Some(ctx.notify_bus.clone());
        let bridges = Arc::new(FlowBridges::<cdp::FlowKey>::new(
            ctx.session.clone(),
            ctx.platform,
            hooks,
        ));
        tokio::select! {
            result = cdp::run(&self.endpoint, bridges, ctx.mjai_bus, ctx.session.inspector(), ctx.autoplay,
                ctx.http, ctx.notify_bus, Some(self.initial_url)) => result,
            _ = shutdown.wait() => Ok(()),
        }
    }
    fn descriptor(&self) -> CaptureDescriptor {
        CaptureDescriptor {
            kind: CaptureKind::Chromium,
            label: "embedded WebView2".into(),
        }
    }
}
