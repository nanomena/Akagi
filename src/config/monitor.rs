use serde::{Deserialize, Serialize};

/// The application's window. It is always open — it is the application — so
/// what is left to choose is whether it stays above other windows, and how
/// autoplay's pointer shows: drawn over the game, and resting between turns
/// where the next discard is likely to be.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorConfig {
    pub always_on_top: bool,
    /// Draw autoplay's pointer over the game: the path it takes and where it presses.
    pub pointer_trail: bool,
    /// While the others play, rest autoplay's pointer on the tiles the bot
    /// expects to throw next, as a person's eye already would be (see
    /// `autoplay::lean`). Asks the bot between turns, so only a bot that
    /// answers with a lean gives the pointer anywhere to go.
    pub pointer_lean: bool,
}
