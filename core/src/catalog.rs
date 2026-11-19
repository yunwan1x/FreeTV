use crate::network;
use regex::Regex;
use reqwest::{Client, Url};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::LazyLock,
};

pub const FEEDS: [&str; 3] = [
    "https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_cctv.m3u8",
    "https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_province.m3u8",
    "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
];
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([\w-]+)\s*=\s*"([^"]*)""#).unwrap());
static CCTV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^cctv[-\s]*(\d+)(\+|plus)?").unwrap());

pub fn key(s: &str) -> String {
    if let Some(m) = CCTV.captures(s.trim()) {
        let suffix = &s.trim()[m.get(0).unwrap().end()..];
        // Keep regional feeds such as CCTV4 Europe and America separate.
        let region = ["欧洲", "美洲", "亚洲", "欧洲版", "美洲版"]
            .iter()
            .find(|r| suffix.contains(**r))
            .copied()
            .unwrap_or("");
        return format!(
            "cctv{}{}{}",
            &m[1],
            if m.get(2).is_some() { "+" } else { "" },
            region
        );
    }
    s.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

#[derive(Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub group: String,
    pub region: String,
    pub epg_id: String,
    pub logo: String,
    pub routes: Vec<String>,
}
#[derive(Serialize)]
pub struct Catalog {
    pub channels: Vec<Channel>,
}

pub fn parse(text: &str, source: usize, base: &Url) -> Catalog {
    let mut channels = Vec::<Channel>::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut entry = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with("#EXTINF:") {
            entry = Some(line);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(info) = entry.take() else { continue };
        let Ok(url) = base.join(line) else { continue };
        if network::web_url(url.as_str()).is_err() {
            continue;
        }
        let fields: BTreeMap<_, _> = ATTR
            .captures_iter(info)
            .map(|cap| (cap[1].to_string(), cap[2].to_string()))
            .collect();
        let field = |name: &str| fields.get(name).map(String::as_str).unwrap_or("");
        let mut quoted = false;
        let name = info
            .char_indices()
            .find_map(|(i, c)| {
                if c == '"' {
                    quoted = !quoted;
                }
                (c == ',' && !quoted).then_some(i + 1)
            })
            .map(|p| info[p..].trim())
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let region = if source < 2 {
            "CN"
        } else {
            field("tvg-country")
        };
        let matching = if !field("tvg-name").is_empty() {
            field("tvg-name")
        } else {
            name
        };
        let group = match source {
            0 => "央视",
            1 => "卫视",
            _ if region == "CN" && key(matching).starts_with("cctv") => "央视",
            _ if region == "CN" && matching.contains("卫视") => "卫视",
            _ if region == "CN" => "地方",
            _ => "国际",
        };
        let code = if region != "CN" && !field("tvg-id").is_empty() {
            field("tvg-id").to_lowercase()
        } else {
            key(matching)
        };
        let id = format!("{region}/{code}");
        let pos = *positions.entry(id.clone()).or_insert_with(|| {
            channels.push(Channel {
                id,
                name: name.to_owned(),
                group: group.into(),
                region: region.into(),
                epg_id: field("tvg-id").into(),
                logo: field("tvg-logo").into(),
                routes: Vec::new(),
            });
            channels.len() - 1
        });
        let routes = &mut channels[pos].routes;
        if !routes.iter().any(|s| s == url.as_str()) {
            routes.push(url.into());
        }
    }
    Catalog { channels }
}

pub async fn subscription(client: &Client, source: usize) -> Result<Catalog, String> {
    let url = FEEDS.get(source).ok_or("未知订阅")?;
    let data = network::get(client, url, 8 << 20).await?;
    let catalog = parse(
        &String::from_utf8_lossy(&data),
        source,
        &Url::parse(url).unwrap(),
    );
    if catalog.channels.is_empty() {
        return Err("订阅中没有有效的频道条目".into());
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_alias_and_resolve_relative() {
        let raw="#EXTM3U\n#EXTINF:-1 tvg-name=\"CCTV1\" group-title=\"A,B\",CCTV-1\na.m3u8\n#EXTINF:-1,CCTV1\nb.m3u8\n#EXTINF:-1,CCTV-1\nb.m3u8";
        let r = parse(
            raw,
            0,
            &Url::parse("https://test.invalid/list/channels").unwrap(),
        );
        assert_eq!(r.channels.len(), 1);
        assert_eq!(
            r.channels[0].routes,
            [
                "https://test.invalid/list/a.m3u8",
                "https://test.invalid/list/b.m3u8"
            ]
        );
        assert_ne!(key("CCTV5+"), key("CCTV5"));
        assert_ne!(key("CCTV4美洲"), key("CCTV4欧洲"));
    }
}
