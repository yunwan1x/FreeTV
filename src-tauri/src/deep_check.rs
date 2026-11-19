#[tauri::command]
pub fn deep_check_backend() -> &'static str {
    if cfg!(mobile) {
        "player"
    } else {
        "ffmpeg"
    }
}

#[cfg(desktop)]
mod desktop {
    use freetv_core::network::web_url;
    use std::{
        env,
        path::{Path, PathBuf},
        process::Stdio,
        time::Duration,
    };
    use tokio::{process::Command, sync::Semaphore, time::timeout};

    static SLOT: Semaphore = Semaphore::const_new(1);
    const NAME: &str = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    fn executable(path: &Path) -> bool {
        if !path.is_absolute()
            || !path
                .file_name()
                .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(NAME))
        {
            return false;
        }
        let Ok(metadata) = path.metadata() else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return false;
            }
        }
        metadata.is_file()
    }

    pub fn resolve(selected: Option<String>) -> Result<PathBuf, String> {
        if let Some(path) = selected {
            let path = PathBuf::from(path);
            return executable(&path)
                .then_some(path)
                .ok_or_else(|| format!("所选文件不可用，请重新选择 {NAME}"));
        }
        let path = env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<_> = env::split_paths(&path)
            .filter(|p| p.is_absolute())
            .collect();
        if cfg!(target_os = "macos") {
            dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        }
        dirs.into_iter()
            .map(|dir| dir.join(NAME))
            .find(|file| executable(file))
            .ok_or_else(|| format!("未找到 {NAME}，可选择本机程序或使用快速检测"))
    }

    pub async fn choose() -> Result<Option<String>, String> {
        let file = rfd::AsyncFileDialog::new()
            .set_title(format!("选择 {NAME}"))
            .pick_file()
            .await;
        file.map(|f| {
            resolve(Some(f.path().to_string_lossy().into_owned()))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .transpose()
    }

    pub async fn decode(url: String, selected: Option<String>) -> Result<(), String> {
        let url = web_url(&url)?;
        let path = resolve(selected)?;
        let _slot = SLOT.try_acquire().map_err(|_| "已有深度检测正在进行")?;
        let mut cmd = Command::new(path);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if url.host_str() == Some("127.0.0.1") {
            cmd.env("no_proxy", "127.0.0.1")
                .env("NO_PROXY", "127.0.0.1");
        }
        cmd.kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .args([
                "-nostdin",
                "-loglevel",
                "quiet",
                "-nostats",
                "-progress",
                "pipe:1",
                "-protocol_whitelist",
                "http,https,tcp,tls,crypto",
                "-i",
                url.as_str(),
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-an",
                "-sn",
                "-dn",
                "-f",
                "null",
                "-",
            ]);
        let output = timeout(Duration::from_secs(15), cmd.output())
            .await
            .map_err(|_| "15 秒内未解码出视频帧")?
            .map_err(|_| "无法启动 FFmpeg，请检查程序路径和执行权限")?;
        // An empty video stream may end successfully without producing a frame.
        let decoded = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|s| s.strip_prefix("frame="))
            .any(|s| s.trim().parse::<u64>().is_ok_and(|n| n > 0));
        if output.status.success() && decoded {
            Ok(())
        } else {
            Err("FFmpeg 未能解码出视频帧，请检查线路或编码支持".into())
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn choose_ffmpeg() -> Result<Option<String>, String> {
    desktop::choose().await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn decode_route(
    url: String,
    path: Option<String>,
    engine: tauri::State<'_, crate::Engine>,
) -> Result<(), String> {
    let local = engine.playback_url(&url, false, false).await?;
    desktop::decode(local, path).await
}
