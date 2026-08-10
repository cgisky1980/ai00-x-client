// Hide console window in Windows release builds.
// TEMPORARY: switch to "console" subsystem to capture stderr from acestep_c.dll
// for debugging the "ace_synth_load failed" error. Revert after diagnosis.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "console"
)]

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    std::env::set_var("RUST_MIN_STACK", "8388608"); // 8MB
    ai00_x_desktop_lib::run().await
}
