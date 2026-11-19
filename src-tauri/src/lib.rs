mod deep_check;
use freetv_core::{catalog, checker, guide, network};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;
use tokio::sync::{Mutex, Semaphore};

struct Engine {
    client: reqwest::Client,
    guides: Mutex<HashMap<String, Arc<Mutex<Option<(Instant, guide::Guide)>>>>>,
    probes: Semaphore,
}

#[tauri::command]
async fn subscription(
    source: usize,
    engine: State<'_, Engine>,
) -> Result<catalog::Catalog, String> {
    catalog::subscription(&engine.client, source).await
}

#[tauri::command]
async fn probe_route(url: String, engine: State<'_, Engine>) -> Result<checker::Probe, String> {
    let _permit = engine.probes.acquire().await.map_err(|_| "检测已结束")?;
    Ok(checker::probe(&engine.client, url).await)
}

#[tauri::command]
async fn programmes(
    region: String,
    name: String,
    id: String,
    engine: State<'_, Engine>,
) -> Result<Vec<guide::Show>, String> {
    let cell = engine
        .guides
        .lock()
        .await
        .entry(region.clone())
        .or_default()
        .clone();
    let mut guide = cell.lock().await;
    if !guide
        .as_ref()
        .is_some_and(|(time, _)| time.elapsed() < Duration::from_secs(4 * 3600))
    {
        match guide::load(&engine.client, &region).await {
            Ok(fresh) => *guide = Some((Instant::now(), fresh)),
            Err(e) if guide.is_none() => return Err(e),
            Err(_) => {}
        }
    }
    Ok(guide.as_ref().unwrap().1.find(&name, &id))
}

// Prefix the binary payload with the final URL so relative HLS segments resolve after redirects.
#[tauri::command]
async fn media(
    url: String,
    range: Option<(u64, Option<u64>)>,
    engine: State<'_, Engine>,
) -> Result<tauri::ipc::Response, String> {
    let mut request = engine.client.get(network::web_url(&url)?);
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
    let client = network::client().expect("HTTP client initialization failed");
    tauri::Builder::default()
        .manage(Engine {
            client,
            guides: Mutex::default(),
            probes: Semaphore::new(6),
        })
        .invoke_handler(tauri::generate_handler![
            deep_check::deep_check_backend,
            #[cfg(desktop)]
            deep_check::choose_ffmpeg,
            #[cfg(desktop)]
            deep_check::decode_route,
            subscription,
            probe_route,
            programmes,
            media
        ])
        .run(tauri::generate_context!())
        .expect("FreeTV runtime failed");
}
