//! The application's one window: Mahjong Soul in an isolated WebView2 child on
//! a 16:9 stage, and the monitor's dock under it. The game has no Tauri
//! capability; capture still uses CDP.
//!
//! Akagi's own main window still exists — the rest of the backend talks to it —
//! but it stays hidden. Closing this window closes the application.

use super::AppState;
use crate::config::MonitorConfig;
use crate::monitor::{MonitorHandle, MonitorSnapshot};
use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, Webview, WebviewUrl,
    WebviewWindowBuilder, Window,
};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub const LABEL: &str = "monitor";
pub const GAME_LABEL: &str = "monitor-game";

/// The window is a fixed canvas the page scales as one piece (`Monitor.tsx`):
/// the game at 16:9 with a quarter-height dock under it, 4:3 in all. It keeps
/// that ratio at every size — its floor, its default and whatever it is dragged to.
const SIZE: (f64, f64) = (1200., 900.);
const MIN: (f64, f64) = (880., 660.);
const RATIO: f64 = SIZE.0 / SIZE.1;

/// Holds the window to its canvas's aspect ratio while an edge is dragged.
/// Tauri has no such constraint on Windows, so the sizing rectangle is
/// corrected in `WM_SIZING`, before the frame is drawn at the new size.
#[cfg(target_os = "windows")]
mod ratio_lock {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    type Callback =
        unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize;

    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(hwnd: *mut c_void, callback: Callback, id: usize, data: usize) -> i32;
        fn RemoveWindowSubclass(hwnd: *mut c_void, callback: Callback, id: usize) -> i32;
        fn DefSubclassProc(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut Rect) -> i32;
        fn GetClientRect(hwnd: *mut c_void, rect: *mut Rect) -> i32;
    }

    const WM_NCDESTROY: u32 = 0x0082;
    const WM_SIZING: u32 = 0x0214;
    const ID: usize = 0x6d69_6169;

    /// Must run on the thread that owns the window. `ratio` is the client
    /// area's width over its height.
    pub fn install(hwnd: *mut c_void, ratio: f64) {
        // SAFETY: `hwnd` is a live window of this thread and `hold` outlives it.
        // The ratio rides along as the subclass's reference data.
        unsafe {
            SetWindowSubclass(hwnd, hold, ID, ratio.to_bits() as usize);
        }
    }

    unsafe extern "system" fn hold(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        data: usize,
    ) -> isize {
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, hold, ID);
        }
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        if msg != WM_SIZING {
            return result;
        }
        let ratio = f64::from_bits(data as u64);
        let (mut window, mut client) = (Rect::default(), Rect::default());
        if GetWindowRect(hwnd, &mut window) == 0 || GetClientRect(hwnd, &mut client) == 0 {
            return result;
        }
        // The ratio is the client area's; the frame around it rides along.
        let frame_w = (window.right - window.left) - (client.right - client.left);
        let frame_h = (window.bottom - window.top) - (client.bottom - client.top);
        // SAFETY: for WM_SIZING, lparam points at the drag rectangle.
        let rect = &mut *(lparam as *mut Rect);
        let tall = (f64::from(rect.right - rect.left - frame_w) / ratio).round() as i32 + frame_h;
        let wide = (f64::from(rect.bottom - rect.top - frame_h) * ratio).round() as i32 + frame_w;
        match wparam {
            // WMSZ_LEFT, WMSZ_RIGHT, and the bottom corners: the bottom edge follows the width.
            1 | 2 | 7 | 8 => rect.bottom = rect.top + tall,
            // WMSZ_TOP, WMSZ_BOTTOM: the right edge follows the height.
            3 | 6 => rect.right = rect.left + wide,
            // The top corners: the top edge follows the width.
            4 | 5 => rect.top = rect.bottom - tall,
            _ => {}
        }
        1
    }
}

/// The size a fresh window opens at: its own, or as much of it as the display
/// has room for.
fn opening_size<R: Runtime>(app: &AppHandle<R>) -> (f64, f64) {
    let room = app.primary_monitor().ok().flatten().map(|display| {
        let size = display.size().to_logical::<f64>(display.scale_factor());
        (size.width * 0.92, size.height * 0.84)
    });
    let fit = room.map_or(1., |(w, h)| (w / SIZE.0).min(h / SIZE.1).min(1.));
    ((SIZE.0 * fit).max(MIN.0), (SIZE.1 * fit).max(MIN.1))
}

/// Bring a window whose size was restored from a saved state back to the
/// canvas's ratio, keeping its width.
fn conform<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let width = size.width.max(MIN.0);
    let height = width / RATIO;
    if (size.width - width).abs() > 1. || (size.height - height).abs() > 1. {
        window.set_size(LogicalSize::new(width, height))?;
    }
    Ok(())
}

pub fn forward<R: Runtime>(app: AppHandle<R>, monitor: MonitorHandle) {
    let mut rx = monitor.subscribe();
    tauri::async_runtime::spawn(async move {
        while rx.changed().await.is_ok() {
            // watch coalesces bursty events without ever dropping canonical state.
            let snapshot = rx.borrow_and_update().clone();
            let _ = app.emit("monitor-updated", snapshot);
        }
    });
}

/// The name the window goes by: the active bot's display name, as its
/// manifest gives it, or Akagi's own when no bot is selected.
pub fn brand(config: &crate::config::AppConfig) -> String {
    let root = crate::util::resolve_dir(std::path::Path::new(&config.bot.dir));
    crate::bot::BotRegistry::scan(&root)
        .ok()
        .and_then(|registry| registry.find(config.bot.active_for(4)).cloned())
        .map(|bot| {
            bot.manifest
                .and_then(|manifest| manifest.bot.display)
                .unwrap_or(bot.name)
        })
        .unwrap_or_else(|| "Akagi".into())
}

/// Open the window, or bring the open one in line with `config`.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>, config: &MonitorConfig) {
    let app = app.clone();
    let handle = app.clone();
    let config = config.clone();
    let _ = handle.run_on_main_thread(move || {
        let result = (|| -> tauri::Result<()> {
            if let Some(window) = app.get_window(LABEL) {
                return window.set_always_on_top(config.always_on_top);
            }
            let size = opening_size(&app);
            let brand = app
                .try_state::<AppState>()
                .map(|state| state.monitor.snapshot().brand)
                .unwrap_or_else(|| "Akagi".into());
            let window =
                WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
                    .title(format!("{brand} · 雀魂"))
                    .inner_size(size.0, size.1)
                    .min_inner_size(MIN.0, MIN.1)
                    // A maximized window cannot keep the canvas's ratio.
                    .maximizable(false)
                    .always_on_top(config.always_on_top)
                    .focused(false)
                    .build()?;
            // The window belongs where it was last put.
            if let Err(e) = window.restore_state(StateFlags::POSITION | StateFlags::SIZE) {
                tracing::warn!("monitor window: could not restore saved geometry: {e}");
            }
            if let Some(frame) = app.get_window(LABEL) {
                conform(&frame)?;
                #[cfg(target_os = "windows")]
                ratio_lock::install(frame.hwnd()?.0 as *mut std::ffi::c_void, RATIO);
            }
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    // This is the application as far as anyone can see. Closing
                    // the hidden main window takes the ordinary way out: it
                    // tears this window and the game down and lets Tauri exit.
                    if let Some(main) = handle.get_window("main") {
                        let _ = main.close();
                    }
                }
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    // Moving to a display with another scale resizes the frame
                    // in whole pixels and drifts off the ratio by one or two.
                    // Put it back once the move has been applied.
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(frame) = app.get_window(LABEL) {
                            let _ = conform(&frame);
                        }
                    });
                }
                _ => {}
            });
            Ok(())
        })();
        if let Err(e) = result {
            tracing::warn!("monitor window: {e}");
        }
        let _ = app.emit("monitor-config", config);
    });
}

pub fn destroy<R: Runtime>(app: &AppHandle<R>) {
    if let Some(game) = app.get_webview(GAME_LABEL) {
        let _ = game.close();
    }
    if let Some(window) = app.get_window(LABEL) {
        let _ = window.destroy();
    }
}

#[tauri::command]
pub fn get_monitor(
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<MonitorSnapshot, String> {
    local_view(&webview)?;
    Ok(state.monitor.snapshot())
}

fn local_view(webview: &Webview) -> Result<(), String> {
    if matches!(webview.label(), LABEL | "main") {
        Ok(())
    } else {
        Err("Only the local application UI can control monitoring.".into())
    }
}

/// Change the configuration and write it back to the file it was loaded from,
/// leaving everything else in that file as it is.
async fn save(
    state: &AppState,
    change: impl FnOnce(&mut crate::config::AppConfig),
) -> Result<crate::config::AppConfig, String> {
    let mut config = state.config.write().await;
    let mut next = config.clone();
    change(&mut next);
    let saved = crate::config::merge_into(
        &next,
        &std::fs::read_to_string(&*state.config_path).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&*state.config_path, saved).map_err(|e| e.to_string())?;
    *config = next.clone();
    Ok(next)
}

/// Keep the window above the others, or let it go; the choice is saved.
#[tauri::command]
pub async fn set_monitor_pinned(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    pinned: bool,
) -> Result<MonitorConfig, String> {
    local_view(&webview)?;
    let config = save(&state, |c| c.monitor.always_on_top = pinned).await?;
    reconcile(&app, &config.monitor);
    Ok(config.monitor)
}

/// Let the model's actions be carried out in the game, or stop that; the choice
/// is saved. This is `autoplay.enabled`, the one switch the main window's
/// settings page has for it: it says what is allowed from now on, not that any
/// action has been taken. The window learns the new state the way it learns
/// everything else, from the next monitor snapshot.
#[tauri::command]
pub async fn set_monitor_autoplay(
    webview: Webview,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    local_view(&webview)?;
    save(&state, |c| c.autoplay.enabled = enabled).await?;
    state.monitor.set_autoplay(enabled);
    super::commands::start_autoplay_manager(enabled, &state);
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GameBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: Option<bool>,
}
impl GameBounds {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite())
            || self.x < 0.
            || self.y < 0.
            || self.width < 100.
            || self.height < 100.
            || self.width > 16000.
            || self.height > 16000.
        {
            return Err("Invalid game view bounds.".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn resize_monitor_game(
    app: AppHandle,
    webview: Webview,
    bounds: GameBounds,
) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("Only the local monitor can position the game.".into());
    }
    bounds.validate()?;
    if let Some(game) = app.get_webview(GAME_LABEL) {
        if bounds.visible == Some(false) {
            return game.hide().map_err(|e| e.to_string());
        }
        game.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        game.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        game.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_monitor_game(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    bounds: GameBounds,
) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("Only the local monitor can open the game.".into());
    }
    bounds.validate()?;
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Err("The embedded game currently requires Windows WebView2.".into())
    }
    #[cfg(target_os = "windows")]
    {
        if app.get_webview(GAME_LABEL).is_some() {
            return Ok(());
        }
        if !state.monitor.snapshot().game_ended {
            return Err("请在当前对局结束后切换游戏窗口。".into());
        }
        let config = state.config.read().await.clone();
        // Named in full: nothing outside this Windows-only block uses them.
        if config.capture.mode != crate::config::CaptureMode::Chromium
            || config.platform.kind != crate::config::Platform::Majsoul
        {
            return Err("内置雀魂需要 Chromium 采集模式和雀魂平台。".into());
        }
        let url: tauri::Url = config
            .capture
            .chromium
            .start_url
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
        super::capture_supervisor::stop_and_wait(&state, std::time::Duration::from_secs(6)).await;
        if matches!(
            state.capture_control.lock().await.status,
            crate::schema::CaptureStatus::Running { .. }
        ) {
            return Err("采集仍在停止，请稍后重试。".into());
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let profile = state
            .config_path
            .parent()
            .ok_or("Configuration directory unavailable.")?
            .join("monitor-game-profile");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let window = handle
                    .get_window(LABEL)
                    .ok_or("Monitor window unavailable.")?;
                let builder = tauri::webview::WebviewBuilder::new(
                    GAME_LABEL,
                    WebviewUrl::External("about:blank".parse().unwrap()),
                )
                .data_directory(profile)
                .additional_browser_args(&format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ));
                window
                    .add_child(
                        builder,
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())??;
        let endpoint = match crate::capture::embedded::discover_endpoint(port).await {
            Ok(endpoint) => endpoint,
            Err(e) => {
                if let Some(game) = app.get_webview(GAME_LABEL) {
                    let _ = game.close();
                }
                return Err(format!("{e:#}"));
            }
        };
        *state.embedded_game.lock().await = Some((endpoint, url.to_string()));
        super::capture_supervisor::spawn_capture_supervisor((*state).clone())
            .await
            .map_err(|e| e.to_string())
    }
}
