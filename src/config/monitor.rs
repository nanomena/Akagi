use serde::{Deserialize, Serialize};

/// The application's window. It is always open — it is the application — so
/// what is left to choose is whether it stays above other windows, and how
/// autoplay's hand shows: its pointer drawn over the game, resting between
/// turns where the next discard is likely to be, and what it presses between
/// decisions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorConfig {
    pub always_on_top: bool,
    /// Draw autoplay's pointer over the game: the path it takes and where it presses.
    pub pointer_trail: bool,
    /// While the others play, rest autoplay's pointer on the tiles the bot
    /// expects to throw next, as a person's eye already would be (see
    /// `autoplay::pointer::lean`). Asks the bot between turns, so only a bot
    /// that answers with a lean gives the pointer anywhere to go.
    pub pointer_lean: bool,
    /// Press through a hand's result, in bursts at its confirm button, as a
    /// person in a hurry does (see `autoplay::acts`).
    pub quick_confirm: bool,
    /// Some while after our riichi, switch the client's own auto-win on; the
    /// client switches it off for every new hand (see `autoplay::acts`).
    pub riichi_auto_win: bool,
}
