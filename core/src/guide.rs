use crate::{catalog::key, network};
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read};

#[derive(Deserialize)]
struct Station {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "display-name", default)]
    names: Vec<String>,
}
#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "@channel")]
    channel: String,
    #[serde(rename = "@start")]
    start: String,
    #[serde(rename = "@stop", default)]
    stop: String,
    #[serde(default)]
    title: Vec<String>,
}
#[derive(Clone, Serialize)]
pub struct Show {
    pub start: i64,
    pub stop: i64,
    pub title: String,
}
pub struct Guide {
    ids: HashMap<String, String>,
    shows: HashMap<String, Vec<Show>>,
}
fn stamp(s: &str) -> Option<i64> {
    DateTime::parse_from_str(s.trim(), "%Y%m%d%H%M%S %z")
        .ok()
        .map(|d| d.timestamp())
}
impl Guide {
    fn parse(raw: &[u8], now: i64) -> Result<Self, String> {
        // XMLTV feeds can contain tens of thousands of programmes. Deserialize one
        // record at a time so unrelated stations and descriptions are discarded promptly.
        use quick_xml::{events::Event, Reader};
        let mut reader = Reader::from_reader(raw);
        let mut ids = HashMap::new();
        let mut shows = HashMap::<String, Vec<Show>>::new();
        loop {
            let begin = reader.buffer_position() as usize;
            let event = reader.read_event().map_err(|e| e.to_string())?;
            let tag = match event {
                Event::Start(ref tag)
                    if matches!(tag.name().as_ref(), b"channel" | b"programme") =>
                {
                    tag
                }
                Event::Eof => break,
                _ => continue,
            };
            reader.read_to_end(tag.name()).map_err(|e| e.to_string())?;
            let record = &raw[begin..reader.buffer_position() as usize];
            if tag.name().as_ref() == b"channel" {
                let c: Station = quick_xml::de::from_reader(record).map_err(|e| e.to_string())?;
                for name in c.names {
                    ids.entry(key(&name)).or_insert_with(|| c.id.clone());
                }
            } else {
                let e: Entry = quick_xml::de::from_reader(record).map_err(|e| e.to_string())?;
                let (Some(start), Some(stop), Some(title)) =
                    (stamp(&e.start), stamp(&e.stop), e.title.into_iter().next())
                else {
                    continue;
                };
                if stop > now - 86400 && start < now + 172800 {
                    shows
                        .entry(e.channel)
                        .or_default()
                        .push(Show { start, stop, title });
                }
            }
        }
        for v in shows.values_mut() {
            v.sort_by_key(|show| show.start)
        }
        Ok(Self { ids, shows })
    }
    pub fn find(&self, name: &str, id: &str) -> Vec<Show> {
        self.shows
            .get(id)
            .or_else(|| self.ids.get(&key(name)).and_then(|s| self.shows.get(s)))
            .cloned()
            .unwrap_or_default()
    }
}

pub async fn load(client: &Client, region: &str) -> Result<Guide, String> {
    if region.len() != 2 || !region.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("该地区暂无节目单".into());
    }
    let zipped = network::get(
        client,
        &format!("https://epg.pw/xmltv/epg_{region}.xml.gz"),
        12 << 20,
    )
    .await?;
    tokio::task::spawn_blocking(move || {
        let mut xml = Vec::new();
        GzDecoder::new(zipped.as_slice())
            .take((64 << 20) + 1)
            .read_to_end(&mut xml)
            .map_err(|_| "节目单解压失败")?;
        if xml.len() > 64 << 20 {
            return Err("节目单过大".into());
        }
        Guide::parse(&xml, Utc::now().timestamp())
    })
    .await
    .map_err(|_| "节目单任务中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xmltv_timezone_and_alias() {
        let xml = r#"<tv><channel id="101"><display-name>CCTV-1 综合</display-name></channel><programme channel="101" start="20250101190000 +0800" stop="20250101193000 +0800"><title>新闻</title></programme></tv>"#;
        let t = stamp("20250101110000 +0000").unwrap();
        let g = Guide::parse(xml.as_bytes(), t).unwrap();
        assert_eq!(g.find("CCTV1", "")[0].start, t);
    }
}
