// Adapted from zhimin-dev/iptv-checker-rs src/common/check.rs and util.rs.
// The upstream MIT notice is in licenses/iptv-checker-rs.txt.
use crate::network::web_url;
use reqwest::Client;
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
pub struct Probe {
    pub url: String,
    pub ms: Option<u64>,
    pub detail: String,
}

fn url_is_m3u8(url: &str) -> bool {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase()
        .ends_with(".m3u8")
}
fn is_manifest(body: &[u8]) -> bool {
    String::from_utf8_lossy(body)
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
}

async fn sample(client: &Client, url: &str) -> Result<&'static str, String> {
    let mut response = client
        .get(web_url(url)?)
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "连接超时".into()
            } else {
                e.without_url().to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let hls = url_is_m3u8(url) || kind.contains("mpegurl");
    let mut head = Vec::with_capacity(4096);
    while head.len() < 4096 {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        else {
            break;
        };
        head.extend_from_slice(&chunk[..chunk.len().min(4096 - head.len())]);
        if is_manifest(&head) {
            return Ok("HLS 清单可达");
        }
        if !hls && head.len() >= 64 {
            break;
        }
    }
    if head.is_empty() || hls || kind.contains("text/html") || head.starts_with(b"<") {
        Err("未返回有效媒体".into())
    } else {
        Ok("地址可达")
    }
}
pub async fn probe(client: &Client, url: String) -> Probe {
    let start = Instant::now();
    match sample(client, &url).await {
        Ok(detail) => Probe {
            url,
            ms: Some(start.elapsed().as_millis() as u64),
            detail: detail.into(),
        },
        Err(detail) => Probe {
            url,
            ms: None,
            detail,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognize_hls() {
        assert!(url_is_m3u8("https://x/TV.M3U8?q=x"));
        assert!(is_manifest("\u{feff}  #EXTM3U\n".as_bytes()));
        assert!(!is_manifest(b"<html>"));
    }
}
