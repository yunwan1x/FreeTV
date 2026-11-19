use reqwest::{Client, Response, Url};
use std::time::Duration;

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Traffic {
    TvList,
    TvPlay,
    RadioList,
    RadioPlay,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxySettings {
    pub address: String,
    pub tv_list: bool,
    pub tv_play: bool,
    pub radio_list: bool,
    pub radio_play: bool,
}

#[derive(Clone)]
pub struct Routing {
    pub settings: ProxySettings,
    direct: Client,
    proxy: Option<Client>,
}

impl Routing {
    pub fn new(settings: ProxySettings) -> Result<Self, String> {
        let builder = || {
            Client::builder()
                .user_agent(concat!("FreeTV/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(7))
                .read_timeout(Duration::from_secs(30))
                .no_proxy()
        };
        let direct = builder().build().map_err(|_| "无法初始化网络")?;
        let proxy = if settings.address.is_empty() {
            if settings.tv_list || settings.tv_play || settings.radio_list || settings.radio_play {
                return Err("请先填写代理地址".into());
            }
            None
        } else {
            let url = Url::parse(&settings.address).map_err(|_| "代理地址格式无效")?;
            if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
                || url.host().is_none()
                || url.port_or_known_default().is_none()
                || !matches!(url.path(), "" | "/")
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("请输入 HTTP 或 SOCKS5 代理地址和端口".into());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("当前支持无需用户名和密码的代理".into());
            }
            Some(
                builder()
                    .proxy(reqwest::Proxy::all(url).map_err(|_| "代理地址无效")?)
                    .build()
                    .map_err(|_| "无法初始化代理")?,
            )
        };
        Ok(Self {
            settings,
            direct,
            proxy,
        })
    }
    pub fn client(&self, traffic: Traffic) -> Client {
        let s = &self.settings;
        let enabled = match traffic {
            Traffic::TvList => s.tv_list,
            Traffic::TvPlay => s.tv_play,
            Traffic::RadioList => s.radio_list,
            Traffic::RadioPlay => s.radio_play,
        };
        if enabled {
            self.proxy.as_ref().expect("validated proxy")
        } else {
            &self.direct
        }
        .clone()
    }
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
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    bytes(response, limit).await
}
