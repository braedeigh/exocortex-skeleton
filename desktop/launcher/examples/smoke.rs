//! smoke — starts the real server through the launcher, with no window.
//!
//! Plain English: the quickest way to check that the launcher and the real
//! `scripts/standalone.py` still agree with each other, on a machine that
//! cannot build the window. It starts the server, prints its address and how
//! many agents it says are working, then stops it.
//!
//!   cargo run --example smoke -- <python> <app folder> <data folder>
use std::path::PathBuf;
use std::time::Duration;

use exo_launcher::{login_shell_path, Server, ServerSpec};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("usage: smoke <python> <app folder> <data folder>");
        std::process::exit(2);
    }
    let data_dir = PathBuf::from(&args[2]);
    let spec = ServerSpec {
        python: PathBuf::from(&args[0]),
        app_dir: PathBuf::from(&args[1]),
        log_path: Some(data_dir.join("logs").join("desktop-server.log")),
        data_dir,
        extra_env: login_shell_path().map(|path| vec![("PATH".to_string(), path)]).unwrap_or_default(),
        ready_timeout: Duration::from_secs(60),
    };
    match Server::start(&spec) {
        Ok(mut server) => {
            println!("ready: {} (pid {})", server.url(), server.pid());
            println!("data folder: {}", server.ready().data_dir);
            println!("live turns: {:?}", server.live_turns());
            server.stop();
            println!("stopped");
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
