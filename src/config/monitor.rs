use serde::{Deserialize, Serialize};

/// The application's window. It is always open — it is the application — so
/// what is left to choose is whether it stays above other windows, and whether
/// autoplay's pointer is drawn over the game.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorConfig {
    pub always_on_top: bool,
    /// Draw autoplay's pointer over the game: the path it takes and where it presses.
    pub pointer_trail: bool,
}
