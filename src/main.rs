//! sync_video_player —— 局域网同步播放器。
//!
//! 设计要点：
//!   1. 单个可执行文件：前端 HTML/CSS/JS 用 include_str! 内嵌，HTTP 服务器自己实现。
//!   2. 视频字节永不落地、永不下载：每个用户在浏览器里用自己的本地文件播放（blob: URL）。
//!   3. 只同步控制信息：文件哈希、大小、播放/暂停、位置时间戳、倍速。音量不参与同步。
//!   4. Rust 负责哈希：浏览器把文件按 8MiB 分片送到 Rust 做增量 SHA-256，算完即丢。

mod assets;
mod hashspec;
mod http;
mod rooms;
mod sha256;

use hashspec::Mode;
use http::{Conn, Request, Response};
use rooms::{now_ms, Registry};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

struct App {
    rooms: Registry,
    started_ms: u64,
}

struct ServeOpts {
    bind: String,
    room: String,
    open: bool,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(Cmd::Serve(opts)) => {
            if let Err(e) = serve(opts).await {
                eprintln!("启动失败: {e}");
                std::process::exit(1);
            }
        }
        Ok(Cmd::Hash { path, mode, json }) => {
            if let Err(e) = run_hash(&path, mode, json) {
                eprintln!("哈希计算失败: {e}");
                std::process::exit(1);
            }
        }
        Ok(Cmd::Help) => print_help(),
        Err(e) => {
            eprintln!("参数错误: {e}\n");
            print_help();
            std::process::exit(2);
        }
    }
}

enum Cmd {
    Serve(ServeOpts),
    Hash { path: String, mode: Mode, json: bool },
    Help,
}

fn parse_args(args: &[String]) -> Result<Cmd, String> {
    if args.iter().any(|a| a == "-h" || a == "--help" || a == "help") {
        return Ok(Cmd::Help);
    }
    let mut opts = ServeOpts {
        bind: "0.0.0.0:8080".to_string(),
        room: "main".to_string(),
        open: false,
    };
    let mut i = 0;
    let mut cmd = "serve";
    if let Some(first) = args.first() {
        if !first.starts_with('-') {
            cmd = first.as_str();
            i = 1;
        }
    }

    if cmd == "hash" {
        let mut path: Option<String> = None;
        let mut mode = Mode::Full;
        let mut json = false;
        while i < args.len() {
            match args[i].as_str() {
                "--sample" | "--fast" => mode = Mode::Sample,
                "--full" => mode = Mode::Full,
                "--json" => json = true,
                other => {
                    if path.is_none() {
                        path = Some(other.to_string());
                    } else {
                        return Err(format!("多余参数 {other}"));
                    }
                }
            }
            i += 1;
        }
        let path = path
            .ok_or_else(|| "hash 需要文件路径，例如: sync_video_player hash \"D:/movie.mkv\"".to_string())?;
        return Ok(Cmd::Hash { path, mode, json });
    }

    if cmd != "serve" {
        return Err(format!("未知命令 {cmd}"));
    }

    while i < args.len() {
        match args[i].as_str() {
            "--bind" => {
                i += 1;
                opts.bind = args
                    .get(i)
                    .ok_or_else(|| "--bind 需要地址，例如 0.0.0.0:8080".to_string())?
                    .clone();
            }
            "--port" => {
                i += 1;
                let port = args
                    .get(i)
                    .ok_or_else(|| "--port 需要端口号".to_string())?
                    .clone();
                let host = opts.bind.split(':').next().unwrap_or("0.0.0.0").to_string();
                opts.bind = format!("{host}:{port}");
            }
            "--room" => {
                i += 1;
                opts.room = rooms::normalize_room(
                    args.get(i).ok_or_else(|| "--room 需要房间名".to_string())?,
                );
            }
            "--open" => opts.open = true,
            other => return Err(format!("未知参数 {other}")),
        }
        i += 1;
    }
    Ok(Cmd::Serve(opts))
}

fn print_help() {
    println!(
        "\
sync_video_player —— 局域网同步播放器（单文件可执行，浏览器访问，只同步控制信息）

用法:
  sync_video_player                          启动服务（默认 0.0.0.0:8080，房间 main）
  sync_video_player serve [选项]             启动服务并指定下面的选项
      --bind <地址:端口>                     监听地址，默认 0.0.0.0:8080
      --port <端口>                          只改端口
      --room <房间名>                        指定默认房间名
      --open                                 启动后尝试打开浏览器

  sync_video_player hash <文件路径> [选项]   本地计算文件哈希（不上传、不需要服务器）
      --sample                               抽样指纹（只读几 MB，适合超大文件）
      --json                                 输出一行 JSON，方便粘贴到网页

说明:
  * 视频文件不会上传到服务器，也不会被任何人下载，一个字都不会过网络。
  * 网页端把 Rust 编译成的 WebAssembly 下载到本机（约 18 KB），由它在浏览器里读文件算 SHA-256。
  * 也可以用 sync_video_player hash 先在本地算好，再把哈希粘进网页。"
    );
}

fn run_hash(path: &str, mode: Mode, as_json: bool) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} 不是普通文件"));
    }
    let size = meta.len();
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let started = std::time::Instant::now();
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    let mut hasher = sha256::Sha256::new();
    let mut bytes_hashed: u64 = 0;

    if mode == Mode::Full {
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            bytes_hashed += n as u64;
        }
    } else {
        use std::io::{Seek, SeekFrom};
        // 采样计划与摘要编码来自 hashspec —— 与浏览器里的 WASM 模块是同一份实现
        let plan = hashspec::sample_plan(size);
        hashspec::feed_sample_header(&mut hasher, size, &plan);
        let mut buf = vec![0u8; 1024 * 1024];
        for s in &plan {
            file.seek(SeekFrom::Start(s.offset))
                .map_err(|e| format!("定位失败: {e}"))?;
            let mut left = s.len;
            while left > 0 {
                let want = left.min(buf.len() as u64) as usize;
                let n = file
                    .read(&mut buf[..want])
                    .map_err(|e| format!("读取失败: {e}"))?;
                if n == 0 {
                    return Err("文件在读取过程中被截断".to_string());
                }
                hasher.update(&buf[..n]);
                bytes_hashed += n as u64;
                left -= n as u64;
            }
        }
    }

    let hash = sha256::hex(&hasher.finalize());
    let elapsed = started.elapsed();
    if as_json {
        println!(
            "{}",
            json!({"name": name, "size": size, "mode": mode.as_str(), "hash": hash})
        );
    } else {
        let speed = if elapsed.as_secs_f64() > 0.0 {
            bytes_hashed as f64 / elapsed.as_secs_f64() / 1_048_576.0
        } else {
            0.0
        };
        println!("文件:   {name}");
        println!("大小:   {size} 字节");
        println!(
            "模式:   {}",
            if mode == Mode::Full {
                "整文件 SHA-256"
            } else {
                "抽样指纹（只读头/尾/均匀采样点）"
            }
        );
        println!("摘要:   {hash}");
        println!(
            "耗时:   {:.2}s（处理 {:.1} MiB，{:.0} MiB/s）",
            elapsed.as_secs_f64(),
            bytes_hashed as f64 / 1_048_576.0,
            speed
        );
        println!();
        println!("把下面这行粘到网页的“手动填哈希”里即可：");
        println!(
            "{}",
            json!({"name": name, "size": size, "mode": mode.as_str(), "hash": hash})
        );
    }
    Ok(())
}

async fn serve(opts: ServeOpts) -> Result<(), String> {
    let bind_addr: SocketAddr = if opts.bind.contains(':') {
        opts.bind
            .parse()
            .map_err(|_| format!("无法解析地址 {}", opts.bind))?
    } else {
        format!("0.0.0.0:{}", opts.bind)
            .parse()
            .map_err(|_| format!("无法解析端口 {}", opts.bind))?
    };

    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("无法监听 {bind_addr}: {e}"))?;
    let local = listener.local_addr().map_err(|e| e.to_string())?;
    let port = local.port();

    let app = Arc::new(App {
        rooms: Registry::new(),
        started_ms: now_ms(),
    });

    let local_url = format!("http://127.0.0.1:{port}/?room={}", opts.room);
    let lan_url = lan_ip().map(|ip| format!("http://{ip}:{port}/?room={}", opts.room));

    println!("==============================================================");
    println!(" sync_video_player · 局域网同步播放（只同步控制信息，视频不落地）");
    println!("==============================================================");
    println!("  房间:        {}", opts.room);
    println!("  本机访问:    {local_url}");
    match &lan_url {
        Some(url) => println!("  局域网访问:  {url}"),
        None => println!("  局域网访问:  （未检测到局域网地址）"),
    }
    println!("  提示:        浏览器里选择本地视频文件后开始播放；");
    println!("               哈希由浏览器内的 Rust(WASM) 在本机计算，文件字节不经过网络。");
    println!("  退出:        Ctrl+C");
    println!();

    if opts.open {
        open_url(&local_url);
    }

    tokio::spawn(reaper(app.clone()));

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("已停止。");
                return Ok(());
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        let _ = stream.set_nodelay(true);
                        let conn = Conn::new(stream, peer);
                        let app = app.clone();
                        tokio::spawn(async move { handle_conn(conn, app).await });
                    }
                    Err(e) => {
                        eprintln!("接受连接失败: {e}");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

async fn reaper(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let now = now_ms();
        for room in app.rooms.all() {
            let changed = {
                let mut st = room.state.lock().unwrap();
                st.reap(now)
            };
            if changed {
                room.notify();
            }
        }
    }
}

async fn handle_conn(mut conn: Conn, app: Arc<App>) {
    loop {
        let req = match conn.read_request().await {
            Ok(Some(r)) => r,
            Ok(None) => return,
            Err(http::ReadError::TooLarge) => {
                // 兜底：服务端只接受控制信息，不接受文件字节
                let resp = Response::text(
                    413,
                    "请求体过大：本服务只接收控制信息（哈希/时间戳等），不接受文件字节。",
                );
                let _ = http::write_response(&mut conn, &resp, false).await;
                return;
            }
            Err(http::ReadError::Malformed(msg)) => {
                let resp = Response::text(400, msg);
                let _ = http::write_response(&mut conn, &resp, false).await;
                return;
            }
            Err(http::ReadError::Io) => return,
        };
        let keep_alive = req.keep_alive;

        if req.method == "OPTIONS" {
            let resp = Response::empty(204);
            if http::write_response(&mut conn, &resp, keep_alive)
                .await
                .is_err()
            {
                return;
            }
            if !keep_alive {
                return;
            }
            continue;
        }

        if req.method == "GET" && req.path == "/api/events" {
            let _ = serve_sse(&mut conn, &app, &req).await;
            return;
        }

        let peer = conn.peer.ip();
        let resp = route(&app, &req, peer).await;
        if http::write_response(&mut conn, &resp, keep_alive)
            .await
            .is_err()
        {
            return;
        }
        if !keep_alive {
            return;
        }
    }
}

async fn serve_sse(conn: &mut Conn, app: &Arc<App>, req: &Request) -> std::io::Result<()> {
    let room_id = req.q("room").unwrap_or_else(|| "main".into());
    let room = app.rooms.get_or_create(&room_id);
    let client = req.q("client").unwrap_or_default();
    let name = req.q("name").unwrap_or_default();

    if !client.is_empty()
        && rooms::apply_control(&room, &client, &name, "heartbeat", &json!({}), now_ms()).is_ok()
    {
        room.notify();
    }

    let mut rx = room.tx.subscribe();
    http::write_sse_headers(conn).await?;
    conn.write_all(b"retry: 1500\n\n").await?;

    let mut tick = tokio::time::interval(Duration::from_millis(1000));
    loop {
        let snapshot = room.snapshot(now_ms());
        let frame = format!("data: {}\n\n", snapshot);
        conn.write_all(frame.as_bytes()).await?;

        tokio::select! {
            _ = tick.tick() => {}
            recv = rx.recv() => {
                if recv.is_err() {
                    break;
                }
            }
        }
    }
    Ok(())
}

async fn route(app: &Arc<App>, req: &Request, peer: IpAddr) -> Response {
    let room_id = req.q("room").unwrap_or_else(|| "main".into());
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => Response::html(assets::INDEX_HTML),
        ("GET", "/app.js") => Response::js(assets::APP_JS),
        ("GET", "/app.css") => Response::css(assets::APP_CSS),
        // 浏览器本地运行的 Rust 哈希器（WebAssembly）
        ("GET", "/sync_video_player_hash.wasm") => {
            Response::new(200, "application/wasm", assets::HASH_WASM.to_vec())
        }
        ("GET", "/favicon.ico") => Response::empty(204),
        ("GET", "/api/hello") => Response::json(
            200,
            &json!({
                "ok": true,
                "srv_ms": now_ms(),
                "uptime_ms": now_ms().saturating_sub(app.started_ms),
                "wasm_abi": hashspec::ABI_VERSION,
            }),
        ),
        ("GET", "/api/state") => {
            let room = app.rooms.get_or_create(&room_id);
            let client = req.q("client").unwrap_or_default();
            let name = req.q("name").unwrap_or_default();
            if !client.is_empty() {
                let _ =
                    rooms::apply_control(&room, &client, &name, "heartbeat", &json!({}), now_ms());
                room.notify();
            }
            let mut snap = room.snapshot(now_ms());
            snap["ok"] = json!(true);
            snap["room"] = json!(room.id);
            Response::json(200, &snap)
        }
        ("POST", "/api/control") => {
            let body = match parse_json(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let room = app.rooms.get_or_create(&room_id);
            let client = body["client"].as_str().unwrap_or("").to_string();
            let name = body["name"].as_str().unwrap_or("").to_string();
            let op = body["op"].as_str().unwrap_or("").to_string();
            let now = now_ms();
            match rooms::apply_control(&room, &client, &name, &op, &body, now) {
                Ok(()) => {
                    room.notify();
                    Response::json(
                        200,
                        &json!({
                            "ok": true,
                            "srv_ms": now_ms(),
                            "state": room.snapshot(now_ms()),
                        }),
                    )
                }
                Err(e) => {
                    let status = if e.code == "hash_mismatch" { 409 } else { 400 };
                    Response::json(
                        status,
                        &json!({
                            "ok": false,
                            "error": e.code,
                            "message": e.message,
                            "expected": e.expected,
                            "srv_ms": now_ms(),
                        }),
                    )
                }
            }
        }
        ("POST", "/api/hash/path") => {
            // 只允许本机（回环地址）使用服务端路径直接计算，避免任意文件读取。
            if !peer.is_loopback() {
                return Response::json(
                    403,
                    &json!({
                        "ok": false,
                        "error": "forbidden",
                        "message": "出于安全考虑，服务端路径哈希只允许本机访问",
                    }),
                );
            }
            let body = match parse_json(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let path = body["path"].as_str().unwrap_or("").to_string();
            if path.is_empty() {
                return Response::json(
                    400,
                    &json!({"ok": false, "error": "bad_request", "message": "缺少 path"}),
                );
            }
            let claimed_size = body["size"].as_u64();
            let claimed_mtime = body["last_modified_ms"].as_u64();
            let target_room = room_from_json(req, &body);
            let room = app.rooms.get_or_create(&target_room);
            let result = tokio::task::spawn_blocking(move || {
                hash_path_blocking(&path, claimed_size, claimed_mtime)
            })
            .await;
            match result {
                Ok(Ok((hash, size, _mtime))) => {
                    let expected = { room.state.lock().unwrap().media.clone() };
                    let matches = expected
                        .as_ref()
                        .map(|m| m.hash.eq_ignore_ascii_case(&hash));
                    Response::json(
                        200,
                        &json!({
                            "ok": true,
                            "hash": hash,
                            "size": size,
                            "mode": "full",
                            "matches_room": matches,
                            "room_hash": expected.as_ref().map(|m| m.hash.clone()),
                        }),
                    )
                }
                Ok(Err(e)) => hash_error(&e),
                Err(e) => hash_error(&format!("任务失败: {e}")),
            }
        }
        _ => Response::text(404, "404 not found"),
    }
}

fn hash_error(message: &str) -> Response {
    Response::json(
        400,
        &json!({"ok": false, "error": "hash_failed", "message": message}),
    )
}

/// 哈希接口的房间归属：优先取 JSON body 里的 room，其次取查询参数，最后回落 main。
/// （分片接口只带查询参数，因为请求体是原始字节。）
fn room_from_json(req: &Request, body: &Value) -> String {
    body.get("room")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| req.q("room"))
        .unwrap_or_else(|| "main".into())
}

fn parse_json(req: &Request) -> Result<Value, Response> {
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&req.body).map_err(|e| {
        Response::json(
            400,
            &json!({"ok": false, "error": "bad_json", "message": e.to_string()}),
        )
    })
}

/// 直接读取本机文件并计算整文件 SHA-256（只允许回环地址调用）。
fn hash_path_blocking(
    path: &str,
    claimed_size: Option<u64>,
    claimed_mtime_ms: Option<u64>,
) -> Result<(String, u64, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} 不是普通文件"));
    }
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    if let Some(c) = claimed_size {
        if c != size {
            return Err(format!(
                "大小不匹配：磁盘上是 {size} 字节，浏览器选中的是 {c} 字节"
            ));
        }
    }
    if let Some(c) = claimed_mtime_ms {
        if c > 0 && mtime_ms > 0 && (mtime_ms as i64 - c as i64).abs() > 2000 {
            return Err("修改时间不匹配，可能不是同一个文件".to_string());
        }
    }

    let mut file = std::fs::File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    let mut hasher = sha256::Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok((sha256::hex(&hasher.finalize()), size, mtime_ms))
}

fn lan_ip() -> Option<IpAddr> {
    // UDP connect 不会发送任何数据，只是让内核按默认路由挑一个本机地址
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("10.255.255.255:1").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip)
    }
}

fn open_url(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(url).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_serve() {
        match parse_args(&[]).unwrap() {
            Cmd::Serve(o) => {
                assert_eq!(o.bind, "0.0.0.0:8080");
                assert_eq!(o.room, "main");
            }
            _ => panic!("默认应为 serve"),
        }
    }

    #[test]
    fn parses_bind_and_room() {
        let args = vec![
            "serve".to_string(),
            "--bind".into(),
            "127.0.0.1:9000".into(),
            "--room".into(),
            "电影".into(),
        ];
        match parse_args(&args).unwrap() {
            Cmd::Serve(o) => {
                assert_eq!(o.bind, "127.0.0.1:9000");
                assert_eq!(o.room, "main"); // 非法字符会被清空后回落到 main
            }
            _ => panic!("应为 serve"),
        }
    }

    #[test]
    fn parses_hash_command() {
        let args = vec!["hash".to_string(), "movie.mkv".into(), "--sample".into()];
        match parse_args(&args).unwrap() {
            Cmd::Hash { path, mode, json } => {
                assert_eq!(path, "movie.mkv");
                assert_eq!(mode, Mode::Sample);
                assert!(!json);
            }
            _ => panic!("应为 hash"),
        }
    }

    #[test]
    fn hash_command_requires_path() {
        let args = vec!["hash".to_string()];
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn port_option_keeps_host() {
        let args = vec![
            "--bind".into(),
            "127.0.0.1:9000".into(),
            "--port".into(),
            "9100".into(),
        ];
        match parse_args(&args).unwrap() {
            Cmd::Serve(o) => assert_eq!(o.bind, "127.0.0.1:9100"),
            _ => panic!("应为 serve"),
        }
    }

    #[test]
    fn open_flag_is_recognized() {
        match parse_args(&["serve".into(), "--open".into()]).unwrap() {
            Cmd::Serve(o) => assert!(o.open),
            _ => panic!("应为 serve"),
        }
    }

    #[test]
    fn help_wins_over_other_args() {
        for flag in ["-h", "--help", "help"] {
            let args = vec!["serve".to_string(), flag.to_string()];
            assert!(matches!(parse_args(&args).unwrap(), Cmd::Help), "{flag}");
        }
        // 没有参数时是启动服务，不是帮助
        assert!(matches!(parse_args(&[]).unwrap(), Cmd::Serve(_)));
    }

    #[test]
    fn rejects_unknown_command_and_option() {
        assert!(parse_args(&["nope".to_string()]).is_err());
        assert!(parse_args(&["serve".to_string(), "--socket".to_string()]).is_err());
        // 缺值的选项也不能静默通过
        assert!(parse_args(&["serve".to_string(), "--bind".to_string()]).is_err());
        assert!(parse_args(&["serve".to_string(), "--port".to_string()]).is_err());
        assert!(parse_args(&["serve".to_string(), "--room".to_string()]).is_err());
    }

    #[test]
    fn hash_command_parses_full_and_json() {
        let args = vec![
            "hash".to_string(),
            "movie.mkv".into(),
            "--full".into(),
            "--json".into(),
        ];
        match parse_args(&args).unwrap() {
            Cmd::Hash { path, mode, json } => {
                assert_eq!(path, "movie.mkv");
                assert_eq!(mode, Mode::Full);
                assert!(json);
            }
            _ => panic!("应为 hash"),
        }
    }

    // ---- 本机文件哈希（只读本机磁盘，绝不涉及网络） ----

    /// 建一个只在本次测试里存在的临时目录，返回（目录，文件路径助手）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        let unique = format!(
            "sync_video_player-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        dir.push(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hash_path_matches_independent_digest() {
        let dir = temp_dir("path-hash");
        let file = dir.join("movie.bin");
        std::fs::write(&file, b"sync_video_player\n").unwrap();

        let (hash, size, mtime) =
            hash_path_blocking(file.to_str().unwrap(), Some(18), None).unwrap();
        // 期望值由 node crypto（OpenSSL）独立算出，不是拿本项目自己的实现自证
        assert_eq!(
            hash,
            "957165812c9f63d6819d675f91d5de2fe2c7284e8acd2f7593b5a0a7ccc4acef"
        );
        assert_eq!(size, 18);
        assert!(mtime > 0, "应该能读到修改时间");

        // 大小对不上：说明浏览器选中的不是磁盘上这个文件
        let err = hash_path_blocking(file.to_str().unwrap(), Some(1), None).unwrap_err();
        assert!(err.contains("大小不匹配"), "实际错误：{err}");

        // 修改时间差得太多：同样拒绝
        let err = hash_path_blocking(file.to_str().unwrap(), None, Some(mtime + 60_000))
            .unwrap_err();
        assert!(err.contains("修改时间不匹配"), "实际错误：{err}");

        // 前后 2 秒内的抖动要容忍（不同文件系统的精度不同）
        assert!(hash_path_blocking(file.to_str().unwrap(), None, Some(mtime + 1_000)).is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hash_path_rejects_bad_targets() {
        let dir = temp_dir("bad-path");
        let missing = dir.join("没有这个文件");
        assert!(hash_path_blocking(missing.to_str().unwrap(), None, None).is_err());
        // 目录不是普通文件
        let err = hash_path_blocking(dir.to_str().unwrap(), None, None).unwrap_err();
        assert!(err.contains("不是普通文件"), "实际错误：{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
