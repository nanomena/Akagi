//! Offline monitor validation: no browser, bot subprocess or model service.
use akagi::game_state::GameTracker;
use akagi::monitor::MonitorHandle;
use akagi::schema::MjaiEvent;
use std::io::{BufRead, BufReader};

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("Usage: replay_monitor <mjai.jsonl> [snapshot.json]"))?;
    let monitor = MonitorHandle::default();
    let mut tracker = GameTracker::new();
    let mut events = 0;
    let mut errors = 0;
    let mut wins = 0;
    let mut draws = 0;
    for line in BufReader::new(std::fs::File::open(path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: MjaiEvent = serde_json::from_str(&line)?;
        let error = tracker.handle(&event).err().map(|e| format!("{e:#}"));
        if let Some(error) = &error {
            eprintln!(
                "event {} {}: {error}",
                events + 1,
                serde_json::to_string(&event)?
            );
        }
        errors += usize::from(error.is_some());
        monitor.game_event(&event, tracker.snapshot(), error);
        let snapshot = monitor.snapshot();
        if let Some(game) = &snapshot.game {
            for player in &game.players {
                if Some(player.seat) != game.our_seat {
                    anyhow::ensure!(
                        player.tehai.iter().all(|t| t == "?") && player.drawn_tile.is_none(),
                        "private hand exposed"
                    );
                }
            }
        }
        if let Some(last) = snapshot.events.back() {
            if let MjaiEvent::Tsumo { actor, pai } = &last.event {
                if Some(*actor) != snapshot.game.as_ref().and_then(|g| g.our_seat) {
                    anyhow::ensure!(pai == "?", "private drawn event exposed");
                }
            }
        }
        if matches!(event, MjaiEvent::Hora { .. }) {
            wins += 1;
        }
        if matches!(event, MjaiEvent::Ryukyoku { .. }) {
            draws += 1;
        }
        events += 1;
        if let Some(output) = std::env::args().nth(2) {
            if !snapshot.round_ended
                && snapshot
                    .game
                    .as_ref()
                    .is_some_and(|g| g.players[g.our_seat.unwrap_or(0) as usize].tehai.len() == 14)
            {
                std::fs::write(output, serde_json::to_string_pretty(&snapshot)?)?;
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({ "events": events, "public_wins": wins, "public_draws": draws, "tracker_errors": errors, "private_hands_hidden": true })
    );
    anyhow::ensure!(errors == 0, "monitor replay encountered tracker errors");
    Ok(())
}
