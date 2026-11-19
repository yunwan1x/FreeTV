fn main() {
    tauri_plugin::Builder::new(&["start", "control", "status", "pip"])
        .android_path("android")
        .build();
}
