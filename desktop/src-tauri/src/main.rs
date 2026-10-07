//! The desktop window.
//!
//! Plain English: this is the program a person double-clicks. It opens one
//! window on a "Starting…" page, starts the app's Python server in the
//! background (through ../launcher), and when the server says it is ready,
//! points the window at the Observatory. When the window closes, the server
//! is stopped. If agents are still working at that moment, it asks first.
//!
//! It is deliberately thin: nothing about agents, models or repos lives here.
//! Everything the app does is the server's and the page's business.
//!
//! Touches:
//!   - `../launcher/src/lib.rs` — starts, questions and stops the server.
//!   - `../splash/index.html` — the starting page, and its `showError()`.
//!   - `capabilities/main.json` — allows the served page to call
//!     `choose_folder`.
//!   - the page (frontend), which calls `window.exoDesktop.chooseFolder()`
//!     when it exists.
//!
//! NOT YET COMPILED. Written 2026-10-06 on a machine without the WebKitGTK
//! development packages Tauri needs on Linux, so nothing in this file has been
//! through the compiler or run. The launcher it calls has been (see
//! ../launcher/tests). Treat every Tauri call below as unverified until
//! `cargo build` passes; then delete this paragraph.
//!
//! Prompt that produced it: "one thing to launch, it starts the server itself
//! on a free local port with its own data folder, opens a window on
//! Observatory and Terrain, and stops the server when the window closes."

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use exo_launcher::{login_shell_path, Server, ServerSpec};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The running server, shared between the thread that starts it, the window's
/// close handler and the exit handler. `None` before it is up and after it has
/// been stopped.
struct Running(Mutex<Option<Server>>);

/// What the page gets as `window.exoDesktop`. Runs before every page the
/// window loads. `chooseFolder` resolves to one absolute path, or null if the
/// person cancelled.
const PAGE_BRIDGE: &str = r#"
window.exoDesktop = {
  chooseFolder: (options) => window.__TAURI_INTERNALS__.invoke('choose_folder', {
    title: (options && options.title) || null,
    startIn: (options && options.startIn) || null,
  }),
};
"#;

/// Open the system's own "choose a folder" dialog.
#[tauri::command]
async fn choose_folder(
    app: AppHandle,
    title: Option<String>,
    start_in: Option<String>,
) -> Option<String> {
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(start_in) = start_in {
        dialog = dialog.set_directory(start_in);
    }
    let chosen = dialog.blocking_pick_folder()?;
    let path = chosen.into_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Work out where the Python, the app's code and the person's data are.
///
/// Three cases, first match wins for each: an `EXO_DESKTOP_*` environment
/// variable (for testing); the copies packed inside a download (`python/` and
/// `app/` in the program's resources); or, in development, the checkout this
/// was built from and its `venv`.
fn server_spec(app: &AppHandle) -> ServerSpec {
    let resources = app.path().resource_dir().ok();
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");

    let packed_app = resources.as_ref().map(|dir| dir.join("app")).filter(|dir| dir.is_dir());
    let app_dir = std::env::var_os("EXO_DESKTOP_APP_DIR")
        .map(PathBuf::from)
        .or(packed_app)
        .unwrap_or(checkout);

    let packed_python = resources
        .as_ref()
        .map(|dir| dir.join("python").join("bin").join("python3"))
        .filter(|file| file.is_file());
    let python = std::env::var_os("EXO_DESKTOP_PYTHON")
        .map(PathBuf::from)
        .or(packed_python)
        .unwrap_or_else(|| app_dir.join("venv").join("bin").join("python3"));

    let data_dir = std::env::var_os("EXO_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().data_dir().ok().map(|dir| dir.join("exocortex-desktop")))
        .unwrap_or_else(|| PathBuf::from("exocortex-desktop-data"));

    // Give the server the PATH a terminal would have, so `claude` and `git`
    // are found when the app was started from a dock or menu.
    let mut extra_env = Vec::new();
    if let Some(path) = login_shell_path() {
        extra_env.push(("PATH".to_string(), path));
    }

    ServerSpec {
        python,
        app_dir,
        log_path: Some(data_dir.join("logs").join("desktop-server.log")),
        data_dir,
        extra_env,
        ready_timeout: Duration::from_secs(60),
    }
}

/// Start the server off the main thread, then point the window at it — or
/// show why it didn't start.
fn start_server_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        let spec = server_spec(&app);
        let window = app.get_webview_window("main");
        match Server::start(&spec) {
            Ok(server) => {
                let address = format!("{}/observatory", server.url());
                *app.state::<Running>().0.lock().unwrap() = Some(server);
                if let (Some(window), Ok(address)) = (window, address.parse()) {
                    let _ = window.navigate(address);
                }
            }
            Err(error) => {
                let reason = serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"unknown\"".to_string());
                if let Some(window) = window {
                    let _ = window.eval(&format!("showError({reason})"));
                }
            }
        }
    });
}

/// Stop the server if it is running. Safe to call more than once.
fn stop_server(app: &AppHandle) {
    if let Some(mut server) = app.state::<Running>().0.lock().unwrap().take() {
        server.stop();
    }
}

/// How many agent turns are running. Zero when the server isn't up or
/// couldn't be asked: there is then nothing this window could stop anyway.
fn live_turns(app: &AppHandle) -> u64 {
    let running = app.state::<Running>();
    let guard = running.0.lock().unwrap();
    guard.as_ref().and_then(|server| server.live_turns()).unwrap_or(0)
}

/// Ask before quitting while agents are working. Two questions, each with two
/// buttons: quit or keep open; then stop the agents or let them finish. A turn
/// runs in its own process and outlives the server, so "let them finish" just
/// means not stopping them.
fn ask_then_quit(app: AppHandle, count: u64) {
    std::thread::spawn(move || {
        let agents = if count == 1 { "1 agent is".to_string() } else { format!("{count} agents are") };
        let quit = app
            .dialog()
            .message(format!("{agents} still working."))
            .title("Quit Exocortex?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep open".into()))
            .blocking_show();
        if !quit {
            return;
        }
        let stop_them = app
            .dialog()
            .message("Stop them now, or let them finish in the background? Agents left running keep working, and spending, with no window open.")
            .title("Agents still working")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Stop them".into(), "Let them finish".into()))
            .blocking_show();
        if stop_them {
            let running = app.state::<Running>();
            if let Some(server) = running.0.lock().unwrap().as_ref() {
                let _ = server.stop_turns();
            }
        }
        stop_server(&app);
        app.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Running(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![choose_folder])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Exocortex")
                .inner_size(1400.0, 900.0)
                .initialization_script(PAGE_BRIDGE)
                .build()?;
            start_server_in_background(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window: if agents are working, hold the close and
            // ask. Otherwise let it close; the exit handler stops the server.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let count = live_turns(&app);
                if count > 0 {
                    api.prevent_close();
                    ask_then_quit(app, count);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("the desktop window could not be built")
        .run(|app, event| {
            // Every way out ends here, so this is where the server is stopped.
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
