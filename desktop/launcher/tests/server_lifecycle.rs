//! Proves the launcher against a stand-in server that keeps the same
//! agreement the real one does (see ../src/lib.rs): a ready line on stdout,
//! `live_turns` at /api/standalone, a stop-turns door, exit on SIGTERM or
//! when stdin closes.
//!
//! The stand-in is a small Python script written into a temp folder laid out
//! like the app (`scripts/standalone.py`), so the launcher runs it exactly the
//! way it runs the real thing. Needs `python3` on PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use exo_launcher::{Server, ServerSpec, StartError};

const STAND_IN: &str = r#"
import argparse, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int)
parser.add_argument("--data")
parser.add_argument("--exit-with-stdin", action="store_true")
args = parser.parse_args()
mode = os.environ.get("STAND_IN_MODE", "ok")
if mode == "crash":
    print("boom: could not open the database", file=sys.stderr)
    sys.exit(3)
turns = {"live": 2}

class Handler(BaseHTTPRequestHandler):
    def _send(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._send({"standalone": True, "live_turns": turns["live"]})
    def do_POST(self):
        stopped, turns["live"] = turns["live"], 0
        self._send({"stopped": stopped})
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Handler)
if args.exit_with_stdin:
    def watch():
        sys.stdin.read()
        os._exit(0)
    threading.Thread(target=watch, daemon=True).start()
print("a stray line before the ready line")
if mode != "silent":
    print(json.dumps({"ready": True, "url": "http://127.0.0.1:%d" % server.server_port,
                      "port": server.server_port, "data_dir": args.data}), flush=True)
sys.stdout.flush()
server.serve_forever()
"#;

fn app_folder(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("exo-launcher-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(root.join("scripts").join("standalone.py"), STAND_IN).unwrap();
    root
}

fn spec(root: &Path, mode: &str, timeout_secs: u64) -> ServerSpec {
    ServerSpec {
        python: PathBuf::from("python3"),
        app_dir: root.to_path_buf(),
        data_dir: root.join("data"),
        log_path: Some(root.join("logs").join("server.log")),
        extra_env: vec![("STAND_IN_MODE".into(), mode.into())],
        ready_timeout: Duration::from_secs(timeout_secs),
    }
}

fn is_running(pid: u32) -> bool {
    // A stopped-and-reaped process has no /proc entry.
    Path::new(&format!("/proc/{pid}")).exists()
}

#[test]
fn starts_asks_about_turns_and_leaves_nothing_running() {
    let root = app_folder("ok");
    let mut server = Server::start(&spec(&root, "ok", 20)).expect("server should start");
    let pid = server.pid();

    assert!(server.url().starts_with("http://127.0.0.1:"));
    assert_eq!(server.ready().data_dir, root.join("data").to_string_lossy());
    assert_eq!(server.live_turns(), Some(2));
    assert_eq!(server.stop_turns(), Some(2));
    assert_eq!(server.live_turns(), Some(0));

    server.stop();
    assert!(!is_running(pid), "the server must be gone after stop()");
    assert_eq!(server.live_turns(), None, "a stopped server is 'don't know', not zero");
}

#[test]
fn a_server_that_dies_reports_its_own_last_words() {
    let root = app_folder("crash");
    match Server::start(&spec(&root, "crash", 20)) {
        Err(StartError::ExitedEarly { log_tail }) => {
            assert!(log_tail.contains("could not open the database"), "got: {log_tail}")
        }
        Err(other) => panic!("expected ExitedEarly, got {other}"),
        Ok(_) => panic!("expected ExitedEarly, but it started"),
    }
}

#[test]
fn a_server_that_never_says_ready_is_stopped_not_left_behind() {
    let root = app_folder("silent");
    let before = std::time::Instant::now();
    let result = Server::start(&spec(&root, "silent", 2));
    assert!(matches!(result, Err(StartError::TimedOut { .. })));
    assert!(before.elapsed() < Duration::from_secs(10));
    // Nothing of ours may still be running this folder's script.
    let listing = std::process::Command::new("pgrep")
        .args(["-f", &root.join("scripts").join("standalone.py").to_string_lossy().into_owned()])
        .output()
        .unwrap();
    assert!(listing.stdout.is_empty(), "a silent server was left running");
}
