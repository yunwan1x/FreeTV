//! Apple CMS catalogs, LibreTV source lists and MediathekView public broadcaster search.
use crate::network::{bytes, web_url};
use reqwest::{Client, RequestBuilder, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

pub const MEDIATHEK: &str = "https://mediathekviewweb.de/api/query";
const UA: &str = "Mozilla/5.0 (compatible; FreeTV)";

async fn json_response(request: RequestBuilder) -> Result<Value, String> {
    let response = request
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(18))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let raw = bytes(response, 8 << 20).await?;
    serde_json::from_slice(raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw))
        .map_err(|_| "上游未返回有效 JSON".into())
}
fn field(row: &Value, name: &str) -> String {
    match &row[name] {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn media_url(url: &str) -> Option<String> {
    web_url(url).ok().map(|u| u.to_string())
}

#[derive(Serialize)]
pub struct Episode {
    name: String,
    url: String,
}
#[derive(Serialize)]
pub struct Line {
    name: String,
    episodes: Vec<Episode>,
}
#[derive(Serialize)]
pub struct Film {
    id: String,
    title: String,
    year: String,
    category: String,
    note: String,
    poster: Option<String>,
    lines: Vec<Line>,
}
#[derive(Serialize)]
pub struct Page {
    films: Vec<Film>,
    more: bool,
}

fn lines(row: &Value) -> Vec<Line> {
    let names = row["vod_play_from"]
        .as_str()
        .unwrap_or("")
        .split("$$$")
        .collect::<Vec<_>>();
    row["vod_play_url"]
        .as_str()
        .unwrap_or("")
        .split("$$$")
        .enumerate()
        .filter_map(|(i, group)| {
            let episodes = group
                .split('#')
                .filter_map(|entry| {
                    let (label, raw) = entry
                        .trim()
                        .split_once('$')
                        .unwrap_or(("正片", entry.trim()));
                    Some(Episode {
                        name: if label.trim().is_empty() {
                            "正片".into()
                        } else {
                            label.trim().into()
                        },
                        url: media_url(raw.trim())?,
                    })
                })
                .collect::<Vec<_>>();
            (!episodes.is_empty()).then(|| Line {
                name: names
                    .get(i)
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| format!("线路 {}", i + 1), |s| s.to_string()),
                episodes,
            })
        })
        .collect()
}
fn apple_film(row: &Value, detail: bool) -> Option<Film> {
    let id = field(row, "vod_id");
    let title = field(row, "vod_name");
    if id.is_empty() || title.is_empty() {
        return None;
    }
    Some(Film {
        id,
        title,
        year: field(row, "vod_year"),
        category: field(row, "type_name"),
        note: field(row, "vod_remarks"),
        poster: media_url(&field(row, "vod_pic")),
        lines: if detail { lines(row) } else { vec![] },
    })
}
fn cms_url(api: &str) -> Result<Url, String> {
    let mut url = web_url(api)?;
    let extra = url
        .query_pairs()
        .filter(|(k, _)| !matches!(&**k, "ac" | "pg" | "wd" | "ids"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(extra)
        .append_pair("ac", "detail");
    Ok(url)
}
pub async fn catalog(client: &Client, api: &str, query: &str, page: u32) -> Result<Page, String> {
    let page = page.clamp(1, 10000);
    if api == MEDIATHEK {
        let search = if query.trim().is_empty() {
            json!([])
        } else {
            json!([{"fields":["topic","title"],"query":query.trim()}])
        };
        let payload = json!({"queries":search,"sortBy":"timestamp","sortOrder":"desc","future":false,"offset":(page-1)*18,"size":18});
        let data = json_response(
            client
                .post(MEDIATHEK)
                .header("Content-Type", "application/json")
                .body(payload.to_string()),
        )
        .await?;
        let rows = data["result"]["results"]
            .as_array()
            .ok_or("节目目录格式无效")?;
        let films = rows
            .iter()
            .filter_map(|r| {
                let mut episodes = vec![];
                for (key, label) in [
                    ("url_video", "标准"),
                    ("url_video_hd", "高清"),
                    ("url_video_low", "流畅"),
                ] {
                    if let Some(url) = media_url(&field(r, key)) {
                        episodes.push(Line {
                            name: label.into(),
                            episodes: vec![Episode {
                                name: "正片".into(),
                                url,
                            }],
                        });
                    }
                }
                let title = field(r, "title");
                let id = field(r, "id");
                (!episodes.is_empty() && !title.is_empty() && !id.is_empty()).then(|| Film {
                    id,
                    title,
                    year: String::new(),
                    category: field(r, "channel"),
                    note: field(r, "topic"),
                    poster: None,
                    lines: episodes,
                })
            })
            .collect();
        return Ok(Page {
            films,
            more: rows.len() == 18,
        });
    }
    let mut url = cms_url(api)?;
    if !query.trim().is_empty() {
        url.query_pairs_mut().append_pair("wd", query.trim());
    }
    url.query_pairs_mut().append_pair("pg", &page.to_string());
    let data = json_response(client.get(url)).await?;
    let rows = data["list"].as_array();
    if rows.is_none() && !(data.get("list") == Some(&Value::Null) && field(&data, "code") == "1") {
        return Err("点播目录格式无效".into());
    }
    Ok(Page {
        films: rows
            .into_iter()
            .flatten()
            .filter_map(|v| apple_film(v, false))
            .collect(),
        more: field(&data, "pagecount").parse::<u32>().unwrap_or(0) > page,
    })
}
pub async fn detail(client: &Client, api: &str, id: &str) -> Result<Film, String> {
    let mut url = cms_url(api)?;
    url.query_pairs_mut().append_pair("ids", id);
    let data = json_response(client.get(url)).await?;
    data["list"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| field(r, "vod_id") == id))
        .and_then(|v| apple_film(v, true))
        .ok_or_else(|| "影片已下架或详情不可读".into())
}
#[derive(Serialize)]
pub struct Source {
    key: String,
    name: String,
    api: String,
}
pub async fn sources(client: &Client, address: &str) -> Result<Vec<Source>, String> {
    let data = json_response(client.get(web_url(address)?)).await?;
    let mut sources = Vec::new();
    let mut add = |key: String, name: String, api: String| {
        if let Some(url) = media_url(&api) {
            if !sources.iter().any(|s: &Source| s.api == url) {
                sources.push(Source {
                    key: if key.is_empty() { url.clone() } else { key },
                    name: if name.is_empty() { url.clone() } else { name },
                    api: url,
                })
            }
        }
    };
    if let Some(sites) = data["api_site"].as_object() {
        for (key, site) in sites.iter().take(300) {
            add(key.clone(), field(site, "name"), field(site, "api"));
        }
    } else if let Some(sites) = data["sources"].as_array().or_else(|| data.as_array()) {
        for site in sites.iter().take(300) {
            add(field(site, "id"), field(site, "name"), field(site, "url"));
        }
    } else if let Some(sites) = data["sites"].as_array() {
        for site in sites.iter().take(300).filter(|x| field(x, "type") == "1") {
            add(field(site, "key"), field(site, "name"), field(site, "api"));
        }
    }
    if sources.is_empty() {
        Err("没有可导入的 JSON 点播接口，插件站点需要 TVBox".into())
    } else {
        Ok(sources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn groups_and_invalid_episodes() {
        let v = json!({"vod_play_from":"一$$$二","vod_play_url":"1$https://cdn.test/1#失效$javascript:x#2$https://cdn.test/2?key=x$y$$$正片$https://cdn.test/3"});
        let groups = lines(&v);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].episodes.len(), 2);
        assert_eq!(groups[0].episodes[1].url, "https://cdn.test/2?key=x$y");
        assert_eq!(groups[1].name, "二");
        assert_eq!(
            cms_url("https://a.example/api?k=2&ac=list&wd=old")
                .unwrap()
                .query(),
            Some("k=2&ac=detail")
        );
    }
}
