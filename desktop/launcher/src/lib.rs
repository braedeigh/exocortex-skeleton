//! exo-launcher — starts the app's Python server for the desktop window, and
//! stops it again.
//!
//! Plain English: the desktop app is a window plus the same Python server the
//! website runs. Something has to start that server when the app opens, find
//! out which address it is listening on, and make sure it is gone when the app
//! closes. That job is this file. It knows nothing about windows, so it can be
//! tested by itself.
//!
//! Touches:
//!   - `scripts/standalone.py` (the server's standalone start command). The
//!     agreement with it: run `<python> scripts/standalone.py --port 0 --data
//!     <dir> --exit-with-stdin`; it prints ONE line of JSON on stdout when it
//!     is listening (`{"ready": true, "url": ..., "port": ..., "data_dir":
//!     ...}`); its logs go to stderr; SIGTERM stops it; and it exits by itself
//!     if its stdin closes, which is what happens if the window crashes.
//!   - `GET /api/standalone` (carries `live_turns`, how many agent turns are
//!     running) and `POST /api/standalone/stop-turns` (stops them all).
//!   - `../src-tauri/src/main.rs`, the window, which calls everything here.
//!
//! Unix only for now (Linux, Mac): stopping uses SIGTERM.
//!
//! Prompt that produced it: "Make a prototype that runs on THIS machine
//! (Linux): one thing to launch, it starts the server itself on a free local
//! port with its own data folder, opens a window on Observatory and Terrain,
//! and stops the server when the window closes."

use std::fmt;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Everything needed to start the server.
pub struct ServerSpec {
    /// The Python to run it with. In a download this is the Python packed
    /// inside the app; in development it is the checkout's `venv`.
    pub python: PathBuf,
    /// The folder holding the app's code (the one with `scripts/` in it).
    pub app_dir: PathBuf,
    /// Where this person's data lives. Created by the server if missing.
    pub data_dir: PathBuf,
    /// Where the server's log lines (its stderr) are appended. `None` lets
    /// them fall through to wherever the window's own stderr goes.
    pub log_path: Option<PathBuf>,
    /// Extra environment for the server, e.g. a fuller `PATH`.
    pub extra_env: Vec<(String, String)>,
    /// How long to wait for the ready line before giving up.
    pub ready_timeout: Duration,
}

/// The line the server prints when it is listening.
#[derive(Debug, Clone, Deserialize)]
pub struct Ready {
    pub ready: bool,
    pub url: String,
    pub port: u16,
    #[serde(default)]
    pub data_dir: String,
}

/// Why the server did not come up.
#[derive(Debug)]
pub enum StartError {
    /// The Python program could not be started at all.
    Spawn(std::io::Error),
    /// It started but exited before saying it was ready.
    ExitedEarly { log_tail: String },
    /// It is still running but never said it was ready; it has been stopped.
    TimedOut { waited: Duration },
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::Spawn(e) => write!(f, "could not start the server: {e}"),
            StartError::ExitedEarly { log_tail } => {
                write!(f, "the server stopped before it was ready.\n{log_tail}")
            }
            StartError::TimedOut { waited } => write!(
                f,
                "the server did not become ready within {} seconds",
                waited.as_secs()
            ),
        }
    }
}

impl std::error::Error for StartError {}

/// A running server. Dropping it stops the server.
pub struct Server {
    child: Child,
    ready: Ready,
    // Hold the server's input open for as long as this lives. The server
    // exits when it closes (`--exit-with-stdin`), so if this process dies
    // without running `stop`, the server still goes away.
    _stdin: Option<ChildStdin>,
}

impl Server {
    /// Start the server and wait until it says it is listening.
    pub fn start(spec: &ServerSpec) -> Result<Server, StartError> {
        let script = spec.app_dir.join("scripts").join("standalone.py");
        let mut command = Command::new(&spec.python);
        command
            .arg(&script)
            .args(["--port", "0", "--data"])
            .arg(&spec.data_dir)
            .arg("--exit-with-stdin")
            .current_dir(&spec.app_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        for (name, value) in &spec.extra_env {
            command.env(name, value);
        }
        // Send the server's log lines to a file. A pipe nobody reads would
        // fill up and freeze the server once it had written about 64 KB.
        if let Some(log_path) = &spec.log_path {
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(file) = OpenOptions::new().create(true).append(true).open(log_path) {
                command.stderr(Stdio::from(file));
            }
        }

        let mut child = command.spawn().map_err(StartError::Spawn)?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout was piped");

        // Read the server's output on a helper thread and wait for the ready
        // line with a time limit. The thread keeps draining stdout afterwards
        // so the server can never block on a full pipe; it ends when the
        // server does.
        let (sender, receiver) = mpsc::channel::<Ready>();
        thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sent || !line.trim_start().starts_with('{') {
                    continue;
                }
                if let Ok(ready) = serde_json::from_str::<Ready>(line.trim()) {
                    if ready.ready {
                        sent = sender.send(ready).is_ok();
                    }
                }
            }
        });

        match receiver.recv_timeout(spec.ready_timeout) {
            Ok(ready) => Ok(Server { child, ready, _stdin: stdin }),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.wait();
                Err(StartError::ExitedEarly { log_tail: tail_of(spec.log_path.as_ref()) })
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate(&mut child, Duration::from_secs(3));
                Err(StartError::TimedOut { waited: spec.ready_timeout })
            }
        }
    }

    /// The address the window should open.
    pub fn url(&self) -> &str {
        &self.ready.url
    }

    pub fn ready(&self) -> &Ready {
        &self.ready
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// How many agent turns are running right now. `None` if the server could
    /// not be asked, which callers should treat as "don't know", not zero.
    pub fn live_turns(&self) -> Option<u64> {
        let body = http(self.ready.port, "GET", "/api/standalone")?;
        serde_json::from_str::<serde_json::Value>(&body).ok()?.get("live_turns")?.as_u64()
    }

    /// Stop every running agent turn. Returns how many were stopped.
    pub fn stop_turns(&self) -> Option<u64> {
        let body = http(self.ready.port, "POST", "/api/standalone/stop-turns")?;
        serde_json::from_str::<serde_json::Value>(&body).ok()?.get("stopped")?.as_u64()
    }

    /// Stop the server: ask politely, wait a few seconds, then insist.
    pub fn stop(&mut self) {
        self._stdin = None;
        terminate(&mut self.child, Duration::from_secs(5));
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Stop a process: SIGTERM, wait up to `grace`, then SIGKILL. Always reaps it.
fn terminate(child: &mut Child, grace: Duration) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The last few lines of the server's log, for an error message.
fn tail_of(log_path: Option<&PathBuf>) -> String {
    let Some(path) = log_path else { return String::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return String::new() };
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

/// One small request to the local server, returning the reply's body.
/// Hand-written HTTP/1.0 on purpose: it is two requests to 127.0.0.1, and a
/// full HTTP library would be the largest thing in this crate.
fn http(port: u16, method: &str, path: &str) -> Option<String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok()?;
    let (head, body) = reply.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?;
    if !status.starts_with('2') {
        return None;
    }
    Some(body.to_string())
}

/// The `PATH` a terminal would have, for an app started from a dock or menu.
///
/// An app launched from the desktop gets a short `PATH` that usually lacks
/// `~/.local/bin` and (on a Mac) `/opt/homebrew/bin`, which is where `claude`
/// and `git` tend to live, so both would look "not installed". This asks the
/// person's own login shell what its `PATH` is. `None` if the shell could not
/// be asked or took too long; the caller then keeps the `PATH` it has.
pub fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    // Markers around the value, because a login shell's startup files may
    // print greetings of their own before ours.
    let mut child = Command::new(shell)
        .args(["-lc", "printf '<<exo:%s:exo>>' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let text = match receiver.recv_timeout(Duration::from_secs(4)) {
        Ok(text) => text,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    let start = text.find("<<exo:")? + "<<exo:".len();
    let end = text[start..].find(":exo>>")? + start;
    let path = text[start..end].trim();
    if path.is_empty() { None } else { Some(path.to_string()) }
}
