use super::*;

pub(super) const API: &str = "https://sepiasearch.org/api/v1/search/videos";

fn film(row: &Value) -> Option<Film> {
    let watch = web_url(row["url"].as_str()?).ok()?;
    let title = field(row, "name");
    if title.is_empty() || row["isLive"] == true || row["nsfw"] == true {
        return None;
    }
    Some(Film {
        id: watch.to_string(),
        title,
        year: field(row, "publishedAt").chars().take(4).collect(),
        category: field(&row["category"], "label"),
        note: field(&row["channel"], "displayName"),
        poster: media_url(&field(row, "thumbnailUrl")).or_else(|| {
            let url = watch.join(row["thumbnailPath"].as_str()?).ok()?;
            media_url(url.as_str())
        }),
        lines: vec![],
    })
}

pub(super) async fn catalog(client: &Client, query: &str, page: u32) -> Result<Page, String> {
    let start = (page - 1) * 18;
    let mut url = web_url(API)?;
    url.query_pairs_mut()
        .append_pair("start", &start.to_string())
        .append_pair("count", "18")
        .append_pair("nsfw", "false")
        .append_pair("isLive", "false");
    if query.trim().is_empty() {
        url.query_pairs_mut().append_pair("sort", "-publishedAt");
    } else {
        url.query_pairs_mut().append_pair("search", query.trim());
    }
    let data = json_response(client.get(url)).await?;
    let rows = data["data"].as_array().ok_or("Sepia Search 返回格式无效")?;
    Ok(Page {
        films: rows.iter().filter_map(film).collect(),
        more: !rows.is_empty()
            && u64::from(start) + (rows.len() as u64) < data["total"].as_u64().unwrap_or(0),
    })
}

pub(super) async fn detail(client: &Client, id: &str) -> Result<Film, String> {
    let watch = web_url(id)?;
    let uuid = watch
        .path()
        .strip_prefix("/videos/watch/")
        .ok_or("PeerTube 视频地址无效")?;
    if uuid.is_empty() || !uuid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("PeerTube 视频编号无效".into());
    }
    let url = watch
        .join(&format!("/api/v1/videos/{uuid}"))
        .map_err(|_| "视频地址无效")?;
    let row = json_response(client.get(url)).await?;
    let mut item = film(&row).ok_or("PeerTube 视频已下架或不可用")?;
    item.id = id.into();
    for playlist in row["streamingPlaylists"].as_array().into_iter().flatten() {
        if let Some(url) = media_url(&field(playlist, "playlistUrl")) {
            item.lines.push(Line {
                name: "自适应画质".into(),
                episodes: vec![Episode {
                    name: "正片".into(),
                    url,
                }],
            });
            break;
        }
    }
    for file in row["files"].as_array().into_iter().flatten() {
        if file["resolution"]["id"] == 0 {
            continue; // Audio-only rendition of the video.
        }
        if let Some(url) = media_url(&field(file, "fileUrl")) {
            item.lines.push(Line {
                name: field(&file["resolution"], "label"),
                episodes: vec![Episode {
                    name: "正片".into(),
                    url,
                }],
            });
        }
    }
    Ok(item)
}
