use reqwest::{Client, Response, Url};
use std::time::Duration;

pub fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .user_agent("FreeTV/0.1")
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(20))
        .build()
}

pub fn web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持 HTTP(S) 媒体地址".into());
    }
    Ok(url)
}

pub async fn bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let mut result = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if chunk.len() > limit - result.len() {
            return Err("响应超过大小限制".into());
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

pub async fn get(client: &Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = client
        .get(web_url(url)?)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    bytes(response, limit).await
}
