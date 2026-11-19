fn main() {
    tauri_plugin::Builder::new(&["start", "control", "status"])
        .android_path("android")
        .build();
}
