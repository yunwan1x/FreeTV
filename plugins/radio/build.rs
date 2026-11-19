fn main() {
    tauri_plugin::Builder::new(&["start", "control", "status", "pip", "fullscreen"])
        .android_path("android")
        .build();
}
