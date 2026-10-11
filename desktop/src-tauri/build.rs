// Tauri's build step: reads tauri.conf.json and the capabilities folder and
// bakes them into the program.
//
// Name the program's own commands, so permissions exist for them. Tauri only
// lets a page it did not ship itself (ours is served from 127.0.0.1, which
// counts as remote) call a command that a capability allows by name, and
// naming `choose_folder` here is what creates the `allow-choose-folder`
// permission that capabilities/main.json grants.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["choose_folder"])),
    )
    .expect("the Tauri build step failed");
}
