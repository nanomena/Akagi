//! Replay a local inspector capture through the real bridge, without a client or network.
use akagi::bridge::{Bridge, Direction, MajsoulBridge};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
};

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: replay_majsoul <inspector.jsonl>")?;
    let mut bridges = HashMap::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let row: Value = serde_json::from_str(&line?)?;
        if row["kind"] != "ws_frame" || row["raw"]["format"] != "binary" {
            continue;
        }
        let flow = row["flow_id"].as_str().context("frame has no flow id")?;
        if !row["parsed"]["method"]
            .as_str()
            .is_some_and(|method| method.starts_with(".lq."))
        {
            continue;
        }
        let direction = match row["direction"].as_str() {
            Some("up") => Direction::Up,
            Some("down") => Direction::Down,
            _ => anyhow::bail!("unknown frame direction"),
        };
        let bytes = STANDARD.decode(
            row["raw"]["data"]
                .as_str()
                .context("frame has no binary data")?,
        )?;
        let bridge = bridges
            .entry(flow.to_owned())
            .or_insert_with(|| MajsoulBridge::new(None, None));
        for event in bridge.parse(direction, &bytes).events {
            println!("{}", json!({"flow_id": flow, "event": event}));
        }
    }
    Ok(())
}
