use crate::network::{self, web_url};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MIRRORS: [&str; 3] = [
    "de1.api.radio-browser.info",
    "nl1.api.radio-browser.info",
    "at1.api.radio-browser.info",
];
#[derive(Deserialize, Serialize)]
pub struct Station {
    pub stationuuid: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub url_resolved: String,
    #[serde(default)]
    pub countrycode: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub codec: String,
    #[serde(default)]
    pub hls: u8,
}

#[derive(Serialize)]
pub struct Page {
    pub stations: Vec<Station>,
    pub next: Option<u32>,
}

pub async fn search(
    client: &Client,
    name: &str,
    country: &str,
    language: &str,
    tag: &str,
    offset: u32,
) -> Result<Page, String> {
    for host in MIRRORS {
        let mut url = Url::parse(&format!("https://{host}/json/stations/search")).unwrap();
        url.query_pairs_mut().extend_pairs([
            ("hidebroken", "true"),
            ("order", "clickcount"),
            ("reverse", "true"),
            ("limit", "50"),
            ("offset", &offset.to_string()),
        ]);
        for (key, value) in [
            ("name", name),
            ("countrycode", country),
            ("language", language),
            ("tag", tag),
        ] {
            if !value.trim().is_empty() {
                url.query_pairs_mut().append_pair(key, value.trim());
            }
        }
        let Ok(response) = client.get(url).timeout(Duration::from_secs(7)).send().await else {
            continue;
        };
        let Ok(data) = network::bytes(response, 2 << 20).await else {
            continue;
        };
        if let Ok(mut stations) = serde_json::from_slice::<Vec<Station>>(&data) {
            let next = (stations.len() == 50).then(|| offset.saturating_add(50));
            stations.retain(|s| {
                !s.stationuuid.is_empty()
                    && (web_url(&s.url_resolved).is_ok() || web_url(&s.url).is_ok())
            });
            return Ok(Page { stations, next });
        }
    }
    Err("无法连接电台目录，请稍后重试或打开收藏".into())
}
