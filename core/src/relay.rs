// Native media elements and Android Media3 cannot use a reqwest client directly.
// Give them signed, loopback-only stream URLs with the correct per-player route.
use crate::network::{self, Routing, Traffic};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use bytes::Bytes;
use futures_util::{stream, StreamExt, TryStreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{
    body::{Frame, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use regex::Regex;
use reqwest::Url;
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    convert::Infallible,
    sync::{Arc, LazyLock, RwLock},
};
use tokio::net::TcpListener;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, Error>;
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\bURI="([^"]+)""#).unwrap());
pub struct Relay {
    port: u16,
    key: hmac::Key,
    routing: Arc<RwLock<Routing>>,
}
fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|x| match x {})
        .boxed_unsync()
}
impl Relay {
    pub async fn start(routing: Arc<RwLock<Routing>>) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "无法启动本机媒体转发")?;
        let mut secret = [0; 32];
        SystemRandom::new()
            .fill(&mut secret)
            .map_err(|_| "无法初始化媒体地址")?;
        let relay = Arc::new(Self {
            port: listener
                .local_addr()
                .map_err(|_| "无法获取本机端口")?
                .port(),
            key: hmac::Key::new(hmac::HMAC_SHA256, &secret),
            routing,
        });
        let worker = relay.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let worker = worker.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let worker = worker.clone();
                        async move {
                            let response = worker.serve(request).await.unwrap_or_else(|code| {
                                Response::builder()
                                    .status(code)
                                    .body(full(Bytes::new()))
                                    .unwrap()
                            });
                            Ok::<_, Infallible>(response)
                        }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(socket), service)
                        .await;
                });
            }
        });
        Ok(relay)
    }
    pub fn url(&self, url: &Url, scope: &str, playlist: bool) -> String {
        let ext = if playlist {
            "m3u8"
        } else {
            url.path()
                .rsplit('.')
                .next()
                .filter(|s| s.len() <= 6 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
                .unwrap_or("bin")
        };
        let resource = format!("{scope}/{}/media.{ext}", B64.encode(url.as_str()));
        let sig = B64.encode(hmac::sign(&self.key, resource.as_bytes()).as_ref());
        format!("http://127.0.0.1:{}/{sig}/{resource}", self.port)
    }
    fn rewrite(&self, text: &str, base: &Url, scope: &str) -> Result<String, StatusCode> {
        let link = |v: &str| {
            let target = base.join(v).map_err(|_| StatusCode::BAD_GATEWAY)?;
            network::web_url(target.as_str()).map_err(|_| StatusCode::BAD_GATEWAY)?;
            Ok::<_, StatusCode>(self.url(&target, scope, false))
        };
        let mut output = String::new();
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                let mut start = 0;
                for attr in ATTR.captures_iter(line) {
                    let value = attr.get(1).unwrap();
                    output.push_str(&line[start..value.start()]);
                    output.push_str(&link(value.as_str())?);
                    start = value.end();
                }
                output.push_str(&line[start..]);
            } else if !line.is_empty() {
                output.push_str(&link(line)?);
            }
            output.push('\n');
        }
        Ok(output)
    }
    async fn serve(&self, req: Request<Incoming>) -> Result<Response<Body>, StatusCode> {
        if !matches!(*req.method(), Method::GET | Method::HEAD) {
            return Err(StatusCode::METHOD_NOT_ALLOWED);
        }
        let (sig, payload) = req
            .uri()
            .path()
            .trim_start_matches('/')
            .split_once('/')
            .ok_or(StatusCode::NOT_FOUND)?;
        let signature = B64.decode(sig).map_err(|_| StatusCode::NOT_FOUND)?;
        hmac::verify(&self.key, payload.as_bytes(), &signature)
            .map_err(|_| StatusCode::NOT_FOUND)?;
        let mut parts = payload.split('/');
        let scope = parts.next().ok_or(StatusCode::NOT_FOUND)?;
        let raw = B64
            .decode(parts.next().ok_or(StatusCode::NOT_FOUND)?)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let target =
            network::web_url(std::str::from_utf8(&raw).map_err(|_| StatusCode::BAD_REQUEST)?)
                .map_err(|_| StatusCode::BAD_REQUEST)?;
        let traffic = match scope {
            "tv" => Traffic::TvPlay,
            "radio" => Traffic::RadioPlay,
            "vod" => Traffic::VodPlay,
            _ => return Err(StatusCode::NOT_FOUND),
        };
        let client = self.routing.read().unwrap().client(traffic);
        let mut upstream = client.request(req.method().clone(), target);
        if let Some(range) = req.headers().get(header::RANGE) {
            upstream = upstream.header(header::RANGE, range);
        }
        let mut response = upstream.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        let mut out = Response::builder().status(response.status());
        if !response.status().is_success() {
            return out
                .body(full(Bytes::new()))
                .map_err(|_| StatusCode::BAD_GATEWAY);
        }
        let headers = response.headers().clone();
        let base = response.url().clone();
        let head = req.method() == Method::HEAD;
        let mut first = Vec::new();
        if !head {
            while first.len() < 10 {
                match response
                    .chunk()
                    .await
                    .map_err(|_| StatusCode::BAD_GATEWAY)?
                {
                    Some(bytes) => first.extend_from_slice(&bytes),
                    None => break,
                }
            }
        }
        if first
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .unwrap_or(&first)
            .starts_with(b"#EXTM3U")
        {
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?
            {
                if first.len() + chunk.len() > 4 << 20 {
                    return Err(StatusCode::BAD_GATEWAY);
                }
                first.extend_from_slice(&chunk);
            }
            let manifest = std::str::from_utf8(&first)
                .map_err(|_| StatusCode::BAD_GATEWAY)?
                .trim_start_matches('\u{feff}');
            return out
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .body(full(self.rewrite(manifest, &base, scope)?))
                .map_err(|_| StatusCode::BAD_GATEWAY);
        }
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_LENGTH,
        ] {
            if let Some(value) = headers.get(&name) {
                out = out.header(name, value);
            }
        }
        let body = if head {
            full(Bytes::new())
        } else {
            let chunks = stream::iter([Ok(Bytes::from(first))])
                .chain(response.bytes_stream())
                .map_ok(Frame::data)
                .map_err(Error::from);
            BodyExt::boxed_unsync(StreamBody::new(chunks))
        };
        out.body(body).map_err(|_| StatusCode::BAD_GATEWAY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::ProxySettings;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    async fn http_server(is_proxy: bool) -> String {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((socket, _)) = server.accept().await {
                tokio::spawn(async move {
                    let mut socket = BufReader::new(socket);
                    let mut line = String::new();
                    socket.read_line(&mut line).await.unwrap();
                    let first = line.clone();
                    loop {
                        line.clear();
                        if socket.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let body = if first.contains("live.m3u8") {
                        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key\"\nsegment.ts\n"
                    } else if is_proxy {
                        "via HTTP proxy"
                    } else {
                        "direct"
                    };
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    socket.get_mut().write_all(reply.as_bytes()).await.unwrap();
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn independent_routes_and_signed_hls_children() {
        let origin = http_server(false).await;
        let http = http_server(true).await;
        let route = Routing::new(ProxySettings {
            address: http,
            tv_play: true,
            radio_list: true,
            vod_play: true,
            ..Default::default()
        })
        .unwrap();
        for (traffic, result) in [
            (Traffic::TvPlay, "via HTTP proxy"),
            (Traffic::TvList, "direct"),
            (Traffic::RadioList, "via HTTP proxy"),
            (Traffic::RadioPlay, "direct"),
            (Traffic::VodPlay, "via HTTP proxy"),
            (Traffic::VodList, "direct"),
        ] {
            assert_eq!(
                route
                    .client(traffic)
                    .get(&origin)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                result
            );
        }
        let relay = Relay::start(Arc::new(RwLock::new(route))).await.unwrap();
        let plain = reqwest::Client::builder().no_proxy().build().unwrap();
        for scope in ["tv", "vod"] {
            let manifest = relay.url(
                &Url::parse(&format!("{origin}/sub/live.m3u8")).unwrap(),
                scope,
                true,
            );
            let body = plain
                .get(&manifest)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            let key = ATTR.captures(&body).unwrap()[1].to_owned();
            for link in [key.as_str(), body.lines().last().unwrap()] {
                assert!(link.starts_with("http://127.0.0.1:"));
                assert!(link.contains(&format!("/{scope}/")));
                assert_eq!(
                    plain.get(link).send().await.unwrap().text().await.unwrap(),
                    "via HTTP proxy"
                );
                assert_eq!(
                    plain
                        .get(link.replace(&format!("/{scope}/"), "/radio/"))
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::NOT_FOUND
                );
            }
        }
    }

    #[tokio::test]
    async fn http_credentials_only_reach_the_selected_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let expected = format!(
            "proxy-authorization: Basic {}",
            base64::engine::general_purpose::STANDARD.encode("name:p@ss:%2F中")
        );
        let server = tokio::spawn(async move {
            for proxied in [true, false] {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = BufReader::new(socket);
                let mut headers = String::new();
                let mut line = String::new();
                while socket.read_line(&mut line).await.unwrap() > 0 && line != "\r\n" {
                    headers.push_str(&line);
                    line.clear();
                }
                assert_eq!(
                    headers
                        .lines()
                        .any(|line| line.eq_ignore_ascii_case(&expected)),
                    proxied
                );
                assert_eq!(
                    headers.to_lowercase().contains("proxy-authorization:"),
                    proxied
                );
                socket
                    .get_mut()
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
            }
        });
        let route = Routing::new(ProxySettings {
            address: format!("http://name:p%40ss%3A%252F%E4%B8%AD@{addr}"),
            tv_play: true,
            ..Default::default()
        })
        .unwrap();
        assert!(!route.settings.address.contains('@'));
        route
            .client(Traffic::TvPlay)
            .get("http://tv.invalid/")
            .send()
            .await
            .unwrap();
        route
            .client(Traffic::RadioPlay)
            .get(format!("http://{addr}/direct"))
            .send()
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5h_resolves_at_proxy() {
        for authenticate in [false, true] {
            verify_socks5h(authenticate).await;
        }
    }
    async fn verify_socks5h(authenticate: bool) {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("socks5h://{}", proxy.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            assert_eq!(socket.read_u8().await.unwrap(), 5);
            let n = socket.read_u8().await.unwrap();
            socket.read_exact(&mut vec![0; n as usize]).await.unwrap();
            if authenticate {
                socket.write_all(&[5, 2]).await.unwrap();
                assert_eq!(socket.read_u8().await.unwrap(), 1);
                for expected in [b"user".as_slice(), b"p@%2F:/"] {
                    let size = socket.read_u8().await.unwrap();
                    let mut received = vec![0; size as usize];
                    socket.read_exact(&mut received).await.unwrap();
                    assert_eq!(received, expected);
                }
                socket.write_all(&[1, 0]).await.unwrap();
            } else {
                socket.write_all(&[5, 0]).await.unwrap();
            }
            let mut command = [0; 4];
            socket.read_exact(&mut command).await.unwrap();
            assert_eq!(command, [5, 1, 0, 3]);
            let n = socket.read_u8().await.unwrap();
            let mut domain = vec![0; n as usize];
            socket.read_exact(&mut domain).await.unwrap();
            assert_eq!(domain, b"radio.invalid");
            assert_eq!(socket.read_u16().await.unwrap(), 80);
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut request = [0; 1024];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
        });
        let route = Routing::new(ProxySettings {
            address,
            username: if authenticate { "user" } else { "" }.into(),
            password: if authenticate { "p@%2F:/" } else { "" }.into(),
            radio_play: true,
            ..Default::default()
        })
        .unwrap();
        let response = route
            .client(Traffic::RadioPlay)
            .get("http://radio.invalid/")
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
        server.await.unwrap();
    }
}
