use serde::Serialize;
use std::thread;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{window::Color, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, Serialize)]
struct PttKeyEvent {
    key: String,
    pressed: bool,
}

// Converts an rdev::Key into the same uppercase single-character / named
// representation the frontend already expects from its old KeyboardEvent
// based bindings (e.g. "Y", "R", "F1", "SPACE").
fn key_to_label(key: rdev::Key) -> Option<String> {
    use rdev::Key::*;
    let label = match key {
        KeyA => "A", KeyB => "B", KeyC => "C", KeyD => "D", KeyE => "E", KeyF => "F",
        KeyG => "G", KeyH => "H", KeyI => "I", KeyJ => "J", KeyK => "K", KeyL => "L",
        KeyM => "M", KeyN => "N", KeyO => "O", KeyP => "P", KeyQ => "Q", KeyR => "R",
        KeyS => "S", KeyT => "T", KeyU => "U", KeyV => "V", KeyW => "W", KeyX => "X",
        KeyY => "Y", KeyZ => "Z",
        Num0 => "0", Num1 => "1", Num2 => "2", Num3 => "3", Num4 => "4",
        Num5 => "5", Num6 => "6", Num7 => "7", Num8 => "8", Num9 => "9",
        Space => "SPACE",
        F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4", F5 => "F5", F6 => "F6",
        F7 => "F7", F8 => "F8", F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
        _ => return None,
    };
    Some(label.to_string())
}

// Spawns a background OS thread that passively taps the global keyboard
// stream (CGEventTap on macOS, WH_KEYBOARD_LL on Windows, evdev/X11 record
// on Linux). This never consumes or blocks the event, so every key still
// reaches whatever window/app actually has focus — including this app's own
// text inputs and other apps running fullscreen. We just forward key
// up/down transitions to the frontend as Tauri events.
fn spawn_ptt_listener(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        log_line("ptt listener thread starting");
        let result = rdev::listen(move |event| {
            let (key, pressed) = match event.event_type {
                rdev::EventType::KeyPress(k) => (k, true),
                rdev::EventType::KeyRelease(k) => (k, false),
                _ => return,
            };
            if let Some(label) = key_to_label(key) {
                log_line(&format!("key event: {label} pressed={pressed}"));
                let emit_result = app_handle.emit("ptt-key", PttKeyEvent { key: label, pressed });
                if let Err(error) = emit_result {
                    log_line(&format!("emit failed: {error:?}"));
                }
            }
        });
        if let Err(error) = result {
            log_line(&format!("global key listener failed to start: {error:?}"));
        }
    });
}

// Temporary diagnostic logging, since a release build with
// windows_subsystem = "windows" has no visible console for eprintln!.
// Writes to %TEMP%\logicomms-ptt.log — check this file if shortcuts aren't
// registering any key events at all.
fn log_line(message: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("logicomms-ptt.log");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            spawn_ptt_listener(app.handle().clone());

            let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html#overlay".into()))
                .title("LogiComms Overlay")
                .inner_size(240.0, 360.0)
                .position(12.0, 12.0)
                .decorations(false)
                .transparent(true)
                .background_color(Color(0, 0, 0, 0))
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .build()?;
            let _ = overlay.set_ignore_cursor_events(true);

            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &exit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("logicomms")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "exit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let _ = tray.app_handle().get_webview_window("main").unwrap().show();
                        let _ = tray.app_handle().get_webview_window("main").unwrap().set_focus();
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
