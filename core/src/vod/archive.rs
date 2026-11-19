use super::*;
use std::collections::BTreeMap;

pub(super) const API: &str = "https://archive.org/advancedsearch.php";

fn archive_url(prefix: &str, id: &str) -> Result<Url, String> {
    if id.is_empty() || matches!(id, "." | "..") || id.contains('/') {
        return Err("Internet Archive 条目编号无效".into());
    }
    let mut url = web_url("https://archive.org")?;
    url.path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .extend(prefix.split('/'))
        .push(id);
    Ok(url)
}

fn film(row: &Value) -> Option<Film> {
    let id = field(row, "identifier");
    let title = field(row, "title");
    let poster = archive_url("services/img", &id).ok()?.to_string();
    if title.is_empty() {
        return None;
    }
    let category = row["collection"]
        .as_array()
        .and_then(|list| {
            list.iter().find_map(|v| match v.as_str()? {
                "prelinger" | "ephemera" => Some("档案影像"),
                "animationandcartoons" => Some("动画"),
                "feature_films" | "silent_films" | "film_noir" => Some("电影"),
                "educationalfilms" => Some("教育"),
                _ => None,
            })
        })
        .unwrap_or("馆藏影像");
    Some(Film {
        id,
        title,
        year: field(row, "date").chars().take(4).collect(),
        category: category.into(),
        note: String::new(),
        poster: Some(poster),
        lines: vec![],
    })
}

pub(super) async fn catalog(client: &Client, query: &str, page: u32) -> Result<Page, String> {
    let mut q = String::from("mediatype:movies AND (format:\"h.264\" OR format:\"MPEG4\" OR format:\"512Kb MPEG4\") AND NOT access-restricted-item:true");
    let terms: Vec<_> = query
        .split_whitespace()
        .map(|word| {
            let literal = word.replace('\\', "\\\\").replace('"', "\\\"");
            format!("(title:\"{literal}\" OR subject:\"{literal}\")")
        })
        .collect();
    if terms.is_empty() {
        q.push_str(" AND (collection:prelinger OR collection:feature_films OR collection:animationandcartoons OR collection:educationalfilms)");
    } else {
        q.push_str(" AND ");
        q.push_str(&terms.join(" AND "));
    }
    let mut url = web_url(API)?;
    url.query_pairs_mut()
        .append_pair("q", &q)
        .append_pair("fl[]", "identifier,title,date,collection")
        .append_pair("rows", "18")
        .append_pair("page", &page.to_string())
        .append_pair("output", "json");
    if terms.is_empty() {
        url.query_pairs_mut()
            .append_pair("sort[]", "downloads desc")
            .append_pair("sort[]", "identifier asc");
    }
    let data = json_response(client.get(url)).await?;
    let result = &data["response"];
    let rows = result["docs"]
        .as_array()
        .ok_or("Internet Archive 返回格式无效")?;
    Ok(Page {
        films: rows.iter().filter_map(film).collect(),
        more: !rows.is_empty()
            && u64::from((page - 1) * 18) + (rows.len() as u64)
                < result["numFound"].as_u64().unwrap_or(0),
    })
}

pub(super) async fn detail(client: &Client, id: &str) -> Result<Film, String> {
    let data = json_response(client.get(archive_url("metadata", id)?)).await?;
    item_detail(&data, id)
}

fn item_detail(data: &Value, id: &str) -> Result<Film, String> {
    let mut item = film(&data["metadata"]).ok_or("Internet Archive 条目不可用")?;
    let files = data["files"].as_array().ok_or("缺少条目文件清单")?;
    // An item can contain several films and several encodes of the same original.
    let mut videos = BTreeMap::new();
    for file in files {
        let name = field(file, "name");
        if !name.to_ascii_lowercase().ends_with(".mp4")
            || file["private"] == true
            || file["private"] == "true"
        {
            continue;
        }
        let parts: Vec<_> = name.split('/').collect();
        if parts.iter().any(|p| matches!(*p, "" | "." | "..")) {
            continue;
        }
        let mut url = archive_url("download", id)?;
        url.path_segments_mut().unwrap().extend(parts);
        let original = file["original"].as_str().unwrap_or(&name);
        let rank = match file["format"].as_str() {
            Some("h.264") => 0,
            Some("512Kb MPEG4") => 2,
            _ => 1,
        };
        let entry = videos
            .entry(original.to_string())
            .or_insert((rank, url.clone()));
        if rank < entry.0 {
            *entry = (rank, url);
        }
    }
    let single = videos.len() == 1;
    let episodes: Vec<_> = videos
        .into_iter()
        .map(|(name, (_, url))| Episode {
            name: if single { "正片".into() } else { name },
            url: url.to_string(),
        })
        .collect();
    if !episodes.is_empty() {
        item.lines.push(Line {
            name: "MP4".into(),
            episodes,
        });
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_share_an_episode_and_use_safe_file_paths() {
        let data = json!({
            "metadata":{"identifier":"film","title":"Film"},
            "files":[
                {"name":"part one/low.mp4","original":"original.mov","format":"512Kb MPEG4"},
                {"name":"part one/main #1.mp4","original":"original.mov","format":"h.264"},
                {"name":"private.mp4","private":"true"},
                {"name":"../different.mp4"}
            ]
        });
        let item = item_detail(&data, "film").unwrap();
        let episodes = &item.lines[0].episodes;
        assert_eq!(episodes.len(), 1);
        assert_eq!(
            episodes[0].url,
            "https://archive.org/download/film/part%20one/main%20%231.mp4"
        );
    }
}
