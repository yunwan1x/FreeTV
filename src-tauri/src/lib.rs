mod deep_check;
use freetv_core::network::{ProxySettings, Routing, Traffic};
use freetv_core::relay::Relay;
use freetv_core::{catalog, checker, network};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tauri::{Manager, State};
use tokio::sync::{OnceCell, Semaphore};

struct Engine {
    routing: Arc<RwLock<Routing>>,
    path: PathBuf,
    relay: OnceCell<Arc<Relay>>,
    probes: Semaphore,
}

impl Engine {
    fn client(&self, traffic: Traffic) -> reqwest::Client {
        self.routing.read().unwrap().client(traffic)
    }
    async fn playback_url(&self, url: &str, radio: bool, playlist: bool) -> Result<String, String> {
        let url = network::web_url(url)?;
        let relay = self
            .relay
            .get_or_try_init(|| Relay::start(self.routing.clone()))
            .await?;
        Ok(relay.url(&url, radio, playlist))
    }
}

#[tauri::command]
fn proxy_settings(engine: State<'_, Engine>) -> ProxySettings {
    engine.routing.read().unwrap().settings.clone()
}

#[tauri::command]
fn save_proxy(settings: ProxySettings, engine: State<'_, Engine>) -> Result<(), String> {
    let updated = Routing::new(settings)?;
    let mut routing = engine.routing.write().unwrap();
    let folder = engine.path.parent().ok_or("配置目录不可用")?;
    std::fs::create_dir_all(folder).map_err(|_| "无法创建配置目录")?;
    let mut file = tempfile::NamedTempFile::new_in(folder).map_err(|_| "无法创建配置文件")?;
    serde_json::to_writer(&mut file, &updated.settings).map_err(|_| "保存代理配置失败")?;
    file.flush().map_err(|_| "保存代理配置失败")?;
    file.persist(&engine.path).map_err(|_| "保存代理配置失败")?;
    *routing = updated;
    Ok(())
}

#[tauri::command]
async fn playback_url(
    url: String,
    radio: bool,
    playlist: bool,
    engine: State<'_, Engine>,
) -> Result<String, String> {
    engine.playback_url(&url, radio, playlist).await
}

#[tauri::command]
fn native_radio() -> bool {
    cfg!(target_os = "android")
}

#[tauri::command]
async fn radio_stations(
    name: String,
    country: String,
    language: String,
    tag: String,
    offset: u32,
    engine: State<'_, Engine>,
) -> Result<freetv_core::radio::Page, String> {
    freetv_core::radio::search(
        &engine.client(Traffic::RadioList),
        &name,
        &country,
        &language,
        &tag,
        offset,
    )
    .await
}

#[tauri::command]
async fn subscription(
    source: usize,
    engine: State<'_, Engine>,
) -> Result<catalog::Catalog, String> {
    catalog::subscription(&engine.client(Traffic::TvList), source).await
}

#[tauri::command]
async fn probe_route(url: String, engine: State<'_, Engine>) -> Result<checker::Probe, String> {
    let _permit = engine.probes.acquire().await.map_err(|_| "检测已结束")?;
    Ok(checker::probe(&engine.client(Traffic::TvPlay), url).await)
}

// Prefix the binary payload with the final URL so relative HLS segments resolve after redirects.
#[tauri::command]
async fn media(
    url: String,
    range: Option<(u64, Option<u64>)>,
    radio: Option<bool>,
    engine: State<'_, Engine>,
) -> Result<tauri::ipc::Response, String> {
    let traffic = if radio.unwrap_or(false) {
        Traffic::RadioPlay
    } else {
        Traffic::TvPlay
    };
    let mut request = engine
        .client(traffic)
        .get(network::web_url(&url)?)
        .timeout(std::time::Duration::from_secs(20));
    if let Some((start, end)) = range {
        request = request.header(
            "Range",
            format!(
                "bytes={start}-{}",
                end.map(|n| n.to_string()).unwrap_or_default()
            ),
        );
    }
    let response = request
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let final_url = response.url().to_string();
    let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let bytes = network::bytes(response, 32 << 20).await?;
    let bytes = match (range, partial) {
        (Some((start, end)), false) => {
            let start = usize::try_from(start).map_err(|_| "无效媒体范围")?;
            let end = end
                .and_then(|v| v.checked_add(1))
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(bytes.len())
                .min(bytes.len());
            bytes.get(start..end).ok_or("无效媒体范围")?
        }
        _ => bytes.as_slice(),
    };
    let mut data = Vec::with_capacity(4 + final_url.len() + bytes.len());
    data.extend_from_slice(&(final_url.len() as u32).to_le_bytes());
    data.extend_from_slice(final_url.as_bytes());
    data.extend_from_slice(bytes);
    Ok(tauri::ipc::Response::new(data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_radio::init());
    builder
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("proxy.json");
            let settings = match std::fs::read(&path) {
                Ok(data) => serde_json::from_slice(&data)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProxySettings::default(),
                Err(e) => return Err(e.into()),
            };
            app.manage(Engine {
                routing: Arc::new(RwLock::new(Routing::new(settings)?)),
                path,
                relay: OnceCell::new(),
                probes: Semaphore::new(6),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            deep_check::deep_check_backend,
            #[cfg(desktop)]
            deep_check::choose_ffmpeg,
            #[cfg(desktop)]
            deep_check::decode_route,
            radio_stations,
            native_radio,
            playback_url,
            proxy_settings,
            save_proxy,
            subscription,
            probe_route,
            media
        ])
        .run(tauri::generate_context!())
        .expect("FreeTV runtime failed");
}
