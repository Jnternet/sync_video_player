//! 极简 HTTP/1.1 服务器基础设施：请求解析、响应写出、SSE 头部。
//!
//! 只实现本项目需要的最小子集：GET/POST/OPTIONS、Content-Length 请求体、
//! keep-alive、服务端推送（SSE）。不依赖任何 HTTP 框架，保证单文件编译产物。

use std::collections::HashMap;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const IO_BUF: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 128 * 1024;
/// 单个请求体上限。服务端只接收控制信息（JSON），**不接受任何文件字节**，
/// 因此 1 MiB 已经远远够用；这也是"绝不传输整个文件"在代码层面的兜底。
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

pub struct Conn {
    pub stream: TcpStream,
    pub peer: SocketAddr,
    buf: Vec<u8>,
    start: usize,
    end: usize,
}

/// 读取请求时的错误分类：区分"对端断开"、"请求体过大"（应回 413）与"报文非法"。
pub enum ReadError {
    /// 对端断开或读取失败：直接关闭连接即可
    Io,
    /// 请求体超过上限（本服务只接受控制信息）
    TooLarge,
    /// 报文非法，带上给客户端的说明
    Malformed(&'static str),
}

impl From<std::io::Error> for ReadError {
    fn from(_: std::io::Error) -> Self {
        ReadError::Io
    }
}

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    #[allow(dead_code)]
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub keep_alive: bool,
}

impl Request {
    pub fn q(&self, key: &str) -> Option<String> {
        self.query.get(key).cloned()
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub extra_headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Response {
            status,
            content_type: content_type.to_string(),
            extra_headers: Vec::new(),
            body,
        }
    }

    pub fn json(status: u16, v: &serde_json::Value) -> Self {
        Response::new(
            status,
            "application/json; charset=utf-8",
            v.to_string().into_bytes(),
        )
    }

    pub fn text(status: u16, s: &str) -> Self {
        Response::new(status, "text/plain; charset=utf-8", s.as_bytes().to_vec())
    }

    pub fn html(s: &str) -> Self {
        Response::new(200, "text/html; charset=utf-8", s.as_bytes().to_vec())
    }

    pub fn js(s: &str) -> Self {
        Response::new(
            200,
            "application/javascript; charset=utf-8",
            s.as_bytes().to_vec(),
        )
    }

    pub fn css(s: &str) -> Self {
        Response::new(200, "text/css; charset=utf-8", s.as_bytes().to_vec())
    }

    pub fn empty(status: u16) -> Self {
        Response::new(status, "text/plain; charset=utf-8", Vec::new())
    }
}

impl Conn {
    pub fn new(stream: TcpStream, peer: SocketAddr) -> Self {
        Conn {
            stream,
            peer,
            buf: vec![0u8; IO_BUF],
            start: 0,
            end: 0,
        }
    }

    /// 从 socket 再读一段数据进缓冲区。返回读取字节数（0 表示对端关闭）。
    async fn fill(&mut self) -> std::io::Result<usize> {
        if self.start == self.end {
            self.start = 0;
            self.end = 0;
        }
        if self.end == self.buf.len() {
            self.buf.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
        }
        if self.end == self.buf.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "请求头过大",
            ));
        }
        let n = self.stream.read(&mut self.buf[self.end..]).await?;
        self.end += n;
        Ok(n)
    }

    /// 读取一行（以 \n 结束），返回去掉 CRLF 的内容；对端关闭且无残留时返回 None。
    async fn read_line(&mut self, budget: &mut usize) -> std::io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(pos) = self.buf[self.start..self.end]
                .iter()
                .position(|&b| b == b'\n')
            {
                let mut line = self.buf[self.start..self.start + pos].to_vec();
                self.start += pos + 1;
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                *budget = budget.saturating_sub(line.len() + 1);
                return Ok(Some(line));
            }
            if *budget == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "请求头过大",
                ));
            }
            if self.fill().await? == 0 {
                if self.start == self.end {
                    return Ok(None);
                }
                let mut line = self.buf[self.start..self.end].to_vec();
                self.start = self.end;
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
        }
    }

    async fn read_body(&mut self, len: usize) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(len);
        let avail = self.end - self.start;
        let take = avail.min(len);
        out.extend_from_slice(&self.buf[self.start..self.start + take]);
        self.start += take;
        if out.len() < len {
            out.resize(len, 0);
            self.stream.read_exact(&mut out[take..]).await?;
        }
        Ok(out)
    }

    pub async fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(data).await
    }

    /// 解析一个完整请求。Ok(None) 表示连接正常结束。
    pub async fn read_request(&mut self) -> Result<Option<Request>, ReadError> {
        let mut budget = MAX_HEADER_BYTES;

        let request_line = loop {
            match self.read_line(&mut budget).await? {
                None => return Ok(None),
                Some(l) if l.is_empty() => continue,
                Some(l) => break l,
            }
        };

        let line = String::from_utf8_lossy(&request_line).into_owned();
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_uppercase();
        let target = parts.next().unwrap_or("").to_string();
        let version = parts.next().unwrap_or("HTTP/1.1").to_string();
        if method.is_empty() || target.is_empty() {
            return Err(ReadError::Malformed("非法请求行"));
        }

        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            match self.read_line(&mut budget).await? {
                None => break,
                Some(l) if l.is_empty() => break,
                Some(l) => {
                    let s = String::from_utf8_lossy(&l).into_owned();
                    if let Some((k, v)) = s.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
            }
        }

        let (raw_path, raw_query) = match target.split_once('?') {
            Some((p, q)) => (p, q),
            None => (target.as_str(), ""),
        };
        let path = percent_decode(raw_path, false);
        let mut query = HashMap::new();
        if !raw_query.is_empty() {
            for pair in raw_query.split('&') {
                if pair.is_empty() {
                    continue;
                }
                let (k, v) = match pair.split_once('=') {
                    Some((k, v)) => (k, v),
                    None => (pair, ""),
                };
                query.insert(percent_decode(k, true), percent_decode(v, true));
            }
        }

        let body_len = headers
            .get("content-length")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        if body_len > MAX_BODY_BYTES {
            // 服务端只接受控制信息；任何"整个文件"的请求都会在这里被挡掉
            return Err(ReadError::TooLarge);
        }

        // 少数客户端（curl -H 'Expect: 100-continue'）会等待服务端放行
        if headers
            .get("expect")
            .map(|v| v.eq_ignore_ascii_case("100-continue"))
            .unwrap_or(false)
        {
            self.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
        }

        let body = if body_len > 0 {
            self.read_body(body_len).await?
        } else {
            Vec::new()
        };

        let keep_alive = match headers.get("connection").map(|s| s.as_str()) {
            Some(v) if v.eq_ignore_ascii_case("close") => false,
            Some(v) if v.eq_ignore_ascii_case("keep-alive") => true,
            _ => version != "HTTP/1.0",
        };

        Ok(Some(Request {
            method,
            path,
            query,
            headers,
            body,
            keep_alive,
        }))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

pub async fn write_response(
    conn: &mut Conn,
    resp: &Response,
    keep_alive: bool,
) -> std::io::Result<()> {
    let mut head = String::with_capacity(256);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        resp.status,
        reason(resp.status)
    ));
    head.push_str(&format!("Content-Type: {}\r\n", resp.content_type));
    head.push_str(&format!("Content-Length: {}\r\n", resp.body.len()));
    head.push_str(&format!(
        "Connection: {}\r\n",
        if keep_alive { "keep-alive" } else { "close" }
    ));
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    for (k, v) in &resp.extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");

    conn.write_all(head.as_bytes()).await?;
    if !resp.body.is_empty() {
        conn.write_all(&resp.body).await?;
    }
    Ok(())
}

/// 写出 SSE 响应头。之后调用方持续写入 `data: {...}\n\n` 帧即可。
pub async fn write_sse_headers(conn: &mut Conn) -> std::io::Result<()> {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-store\r\nX-Accel-Buffering: no\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
    conn.write_all(head.as_bytes()).await
}

fn is_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str, plus_as_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (is_hex(bytes[i + 1]), is_hex(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' if plus_as_space => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("/a%20b", false), "/a b");
        assert_eq!(percent_decode("x+y", true), "x y");
        assert_eq!(percent_decode("x+y", false), "x+y");
        assert_eq!(percent_decode("%E4%B8%AD", false), "中");
        assert_eq!(percent_decode("%zz", false), "%zz");
    }
}
