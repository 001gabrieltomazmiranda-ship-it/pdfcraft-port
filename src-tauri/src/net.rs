//! Pedidos HTTP simples feitos pelo próprio app (só biblioteca padrão do Rust).
//!
//! Serve para falar com os servidores de carimbo de tempo (TSA, RFC 3161) e para
//! buscar certificados intermediários. Esses servidores atendem em `http://` e não
//! liberam CORS, então o WebView não consegue chamá-los direto; o app chama por aqui.
//! A resposta de uma TSA é assinada por ela mesma, então não precisa de TLS para
//! ser confiável.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_HEADER: usize = 64 * 1024;
const MAX_REDIRECTS: usize = 3;

pub struct HttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

struct Target {
    host: String,
    port: u16,
    authority: String,
    path: String,
}

struct RawResponse {
    status: u16,
    content_type: String,
    location: Option<String>,
    body: Vec<u8>,
}

fn parse_url(url: &str) -> Result<Target, String> {
    let rest = if let Some(r) = url.strip_prefix("http://") {
        r
    } else if url.starts_with("https://") {
        return Err(format!("https-not-supported: {}", url));
    } else {
        return Err(format!("invalid url: {}", url));
    };
    let cut = rest.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let authority_full = &rest[..cut];
    let mut path = rest[cut..].to_string();
    if let Some(i) = path.find('#') {
        path.truncate(i);
    }
    if path.is_empty() {
        path = "/".to_string();
    } else if path.starts_with('?') {
        path = format!("/{}", path);
    }
    // tira "usuario:senha@"
    let authority = match authority_full.rfind('@') {
        Some(i) => &authority_full[i + 1..],
        None => authority_full,
    };
    if authority.is_empty() {
        return Err(format!("invalid url (no host): {}", url));
    }
    let (host, port) = if authority.starts_with('[') {
        let end = match authority.find(']') {
            Some(e) => e,
            None => return Err(format!("invalid url: {}", url)),
        };
        let host = authority[1..end].to_string();
        let after = &authority[end + 1..];
        let port = if let Some(p) = after.strip_prefix(':') {
            p.parse::<u16>().map_err(|_| format!("invalid port: {}", url))?
        } else {
            80
        };
        (host, port)
    } else {
        match authority.rfind(':') {
            Some(i) => {
                let p = &authority[i + 1..];
                let port = if p.is_empty() {
                    80
                } else {
                    p.parse::<u16>().map_err(|_| format!("invalid port: {}", url))?
                };
                (authority[..i].to_string(), port)
            }
            None => (authority.to_string(), 80),
        }
    };
    if host.is_empty() {
        return Err(format!("invalid url (no host): {}", url));
    }
    Ok(Target {
        host,
        port,
        authority: authority.to_string(),
        path,
    })
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let now = Instant::now();
    if now >= deadline {
        return Err("timeout".to_string());
    }
    let left = deadline - now;
    if left < Duration::from_millis(1) {
        return Err("timeout".to_string());
    }
    Ok(left)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Desmonta "Transfer-Encoding: chunked". Ok(None) = ainda faltam bytes.
fn decode_chunked(data: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0usize;
    loop {
        let line_end = match find(&data[i..], b"\r\n") {
            Some(p) => i + p,
            None => return Ok(None),
        };
        let line = std::str::from_utf8(&data[i..line_end]).map_err(|_| "bad chunk header".to_string())?;
        let size_txt = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_txt, 16).map_err(|_| format!("bad chunk size: {}", size_txt))?;
        i = line_end + 2;
        if size == 0 {
            // trailers opcionais até a linha vazia
            loop {
                let le = match find(&data[i..], b"\r\n") {
                    Some(p) => i + p,
                    None => return Ok(None),
                };
                if le == i {
                    return Ok(Some(out));
                }
                i = le + 2;
            }
        }
        if out.len() + size > MAX_BODY {
            return Err("response too large".to_string());
        }
        if data.len() < i + size + 2 {
            return Ok(None);
        }
        out.extend_from_slice(&data[i..i + size]);
        i += size;
        if &data[i..i + 2] != b"\r\n" {
            return Err("bad chunk terminator".to_string());
        }
        i += 2;
    }
}

struct Head {
    status: u16,
    content_type: String,
    location: Option<String>,
    content_length: Option<usize>,
    chunked: bool,
}

fn parse_head(raw: &[u8]) -> Result<Head, String> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.split_whitespace();
    let proto = parts.next().unwrap_or("");
    if !proto.starts_with("HTTP/") {
        return Err(format!("bad response: {}", status_line.chars().take(60).collect::<String>()));
    }
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("bad status line: {}", status_line))?;
    let mut head = Head {
        status,
        content_type: String::new(),
        location: None,
        content_length: None,
        chunked: false,
    };
    for line in lines {
        let (name, value) = match line.find(':') {
            Some(i) => (line[..i].trim().to_ascii_lowercase(), line[i + 1..].trim().to_string()),
            None => continue,
        };
        match name.as_str() {
            "content-type" => head.content_type = value,
            "location" => head.location = Some(value),
            "content-length" => head.content_length = value.parse::<usize>().ok(),
            "transfer-encoding" => {
                if value.to_ascii_lowercase().contains("chunked") {
                    head.chunked = true;
                }
            }
            _ => {}
        }
    }
    Ok(head)
}

fn connect(t: &Target, deadline: Instant) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = (t.host.as_str(), t.port)
        .to_socket_addrs()
        .map_err(|e| format!("dns {}: {}", t.host, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("dns {}: no address", t.host));
    }
    let mut last = String::new();
    for addr in &addrs {
        let left = remaining(deadline)?;
        let wait = if left > Duration::from_secs(10) { Duration::from_secs(10) } else { left };
        match TcpStream::connect_timeout(addr, wait) {
            Ok(s) => return Ok(s),
            Err(e) => last = format!("connect {}: {}", addr, e),
        }
    }
    Err(last)
}

fn send_once(method: &str, t: &Target, headers: &[(String, String)], body: &[u8], deadline: Instant) -> Result<RawResponse, String> {
    let mut stream = connect(t, deadline)?;
    let _ = stream.set_nodelay(true);
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|e| e.to_string())?;

    let mut req = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: PDFCraft/1.0\r\nAccept: */*\r\nConnection: close\r\n",
        method, t.path, t.authority
    );
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if lk == "host" || lk == "content-length" || lk == "connection" || lk == "transfer-encoding" {
            continue;
        }
        if k.contains('\r') || k.contains('\n') || v.contains('\r') || v.contains('\n') || k.contains(':') {
            return Err("invalid header".to_string());
        }
        req.push_str(k);
        req.push_str(": ");
        req.push_str(v);
        req.push_str("\r\n");
    }
    if !body.is_empty() || method == "POST" || method == "PUT" {
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| format!("send: {}", e))?;
    if !body.is_empty() {
        stream.write_all(body).map_err(|e| format!("send: {}", e))?;
    }
    stream.flush().map_err(|e| format!("send: {}", e))?;

    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut eof = false;
    let mut head: Option<(Head, usize)> = None;
    loop {
        // cabeçalho
        if head.is_none() {
            if let Some(p) = find(&data, b"\r\n\r\n") {
                let h = parse_head(&data[..p])?;
                let start = p + 4;
                if h.status >= 100 && h.status < 200 {
                    // "100 Continue" e parecidos: descarta e espera o próximo
                    data.drain(..start);
                    continue;
                }
                head = Some((h, start));
            } else if data.len() > MAX_HEADER {
                return Err("response header too large".to_string());
            }
        }
        // corpo
        if let Some((h, start)) = &head {
            let rest = &data[*start..];
            let no_body = method == "HEAD" || h.status == 204 || h.status == 304;
            let done: Option<Vec<u8>> = if no_body {
                Some(Vec::new())
            } else if h.chunked {
                match decode_chunked(rest)? {
                    Some(b) => Some(b),
                    None if eof => return Err("response truncated".to_string()),
                    None => None,
                }
            } else if let Some(len) = h.content_length {
                if len > MAX_BODY {
                    return Err("response too large".to_string());
                }
                if rest.len() >= len {
                    Some(rest[..len].to_vec())
                } else if eof {
                    return Err("response truncated".to_string());
                } else {
                    None
                }
            } else if eof {
                Some(rest.to_vec())
            } else {
                None
            };
            if let Some(b) = done {
                return Ok(RawResponse {
                    status: h.status,
                    content_type: h.content_type.clone(),
                    location: h.location.clone(),
                    body: b,
                });
            }
        } else if eof {
            return Err("connection closed before response".to_string());
        }
        if data.len() > MAX_BODY + MAX_HEADER {
            return Err("response too large".to_string());
        }
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut chunk) {
            Ok(0) => eof = true,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                return Err("timeout".to_string())
            }
            Err(e) => return Err(format!("receive: {}", e)),
        }
    }
}

fn resolve_location(base: &Target, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    if let Some(rest) = location.strip_prefix("//") {
        return format!("http://{}", rest);
    }
    if location.starts_with('/') {
        return format!("http://{}{}", base.authority, location);
    }
    let dir = match base.path.split('?').next().unwrap_or("/").rfind('/') {
        Some(i) => base.path[..i + 1].to_string(),
        None => "/".to_string(),
    };
    format!("http://{}{}{}", base.authority, dir, location)
}

/// Faz um pedido HTTP (só `http://`). Segue até 3 redirecionamentos para `http://`.
pub fn request(method: &str, url: &str, headers: &[(String, String)], body: &[u8], timeout: Duration) -> Result<HttpResponse, String> {
    let deadline = Instant::now() + timeout;
    let mut method = method.trim().to_ascii_uppercase();
    if method.is_empty() {
        method = "GET".to_string();
    }
    if !method.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("invalid method".to_string());
    }
    let mut url = url.trim().to_string();
    let mut body: Vec<u8> = body.to_vec();
    for _ in 0..=MAX_REDIRECTS {
        let target = parse_url(&url)?;
        let resp = send_once(&method, &target, headers, &body, deadline)?;
        let redirect = matches!(resp.status, 301 | 302 | 303 | 307 | 308);
        if redirect {
            if let Some(loc) = &resp.location {
                url = resolve_location(&target, loc);
                if resp.status == 303 {
                    method = "GET".to_string();
                    body.clear();
                }
                continue;
            }
        }
        return Ok(HttpResponse {
            status: resp.status,
            content_type: resp.content_type,
            body: resp.body,
        });
    }
    Err("too many redirects".to_string())
}
