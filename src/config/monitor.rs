use serde::{Deserialize, Serialize};

/// The application's window. It is always open — it is the application — so
/// the only thing left to choose is whether it stays above other windows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorConfig {
    pub always_on_top: bool,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            always_on_top: false,
        }
    }
}
