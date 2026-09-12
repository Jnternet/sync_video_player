//! 端到端集成测试：真的把编译出来的二进制拉起来，用 HTTP 走完整流程。
//!
//! 这些测试不依赖 curl / jq / node，`cargo test` 一条命令就能跑完，
//! 覆盖「内嵌资源 → 路由 → 房间协议 → SSE → 命令行哈希」整条链路。
//! 更重的多进程冒烟测试（含 wasm 与前端策略）仍然由 scripts/smoke.sh 负责。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// cargo 会把被测二进制的绝对路径塞进这个环境变量
const BIN: &str = env!("CARGO_BIN_EXE_sync_video_player");
/// 与 hashspec::ABI_VERSION 对应；前端也拿这个数字校验 wasm
const WASM_ABI: u64 = 2;
const ROOM: &str = "e2e";
/// `sync_video_player\n`（18 字节）的 SHA-256，由 node crypto（OpenSSL）独立算出
const HELLO_DIGEST: &str = "957165812c9f63d6819d675f91d5de2fe2c7284e8acd2f7593b5a0a7ccc4acef";
const HELLO_BYTES: &[u8] = b"sync_video_player\n";

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 测试用临时目录，Drop 时清理。
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "sync_video_player-e2e-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.0.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 真实跑起来的服务进程，Drop 时收尸。
struct Server {
    child: Child,
    port: u16,
    /// 只为在 Drop 时清掉日志目录
    _dir: TempDir,
}

impl Server {
    fn start(tag: &str) -> Self {
        let dir = TempDir::new(tag);
        let mut last = String::new();
        for _ in 0..3 {
            let port = free_port();
            let log_path = dir.path().join(format!("server-{port}.log"));
            let log = std::fs::File::create(&log_path).unwrap();
            let mut child = Command::new(BIN)
                .args([
                    "serve",
                    "--bind",
                    &format!("127.0.0.1:{port}"),
                    "--room",
                    ROOM,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .expect("无法启动被测二进制");
            if wait_ready(port, &mut child) {
                return Server {
                    child,
                    port,
                    _dir: dir,
                };
            }
            last = std::fs::read_to_string(&log_path).unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
        }
        panic!("服务在 3 次尝试内都没起来：\n{last}");
    }
}

/// 等 /api/hello 能通；进程提前退出视为启动失败。
fn wait_ready(port: u16, child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return false;
        }
        if probe_hello(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// 探活：连不上或还没就绪都只返回 false，不 panic。
fn probe_hello(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    let req = b"GET /api/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut status = [0u8; 12];
    stream.read_exact(&mut status).is_ok() && &status == b"HTTP/1.1 200"
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 让内核挑一个空闲端口（随后立刻释放，存在极小概率被抢占，所以外层会重试）。
fn free_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

struct Resp {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Resp {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("响应不是 JSON（{e}）：{}", self.text()))
    }

    fn content_type(&self) -> &str {
        self.headers
            .get("content-type")
            .map(|s| s.as_str())
            .unwrap_or("")
    }
}

fn connect(port: u16) -> TcpStream {
    let s = TcpStream::connect(("127.0.0.1", port)).expect("连接服务失败");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
    s
}

fn write_request(stream: &mut TcpStream, method: &str, path: &str, body: &[u8], keep_alive: bool) {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str(if keep_alive {
        "Connection: keep-alive\r\n"
    } else {
        "Connection: close\r\n"
    });
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    if !body.is_empty() {
        stream.write_all(body).unwrap();
    }
}

fn read_response(reader: &mut BufReader<TcpStream>) -> Resp {
    let mut status_line = String::new();
    reader.read_line(&mut status_line).unwrap();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_else(|| panic!("状态行异常：{status_line:?}"))
        .parse()
        .unwrap();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let len: usize = headers
        .get("content-length")
        .map(|v| v.parse().unwrap())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body).unwrap();
    }
    Resp {
        status,
        headers,
        body,
    }
}

fn request(port: u16, method: &str, path: &str, body: &[u8]) -> Resp {
    let mut stream = connect(port);
    write_request(&mut stream, method, path, body, false);
    let mut reader = BufReader::new(stream);
    read_response(&mut reader)
}

fn get(port: u16, path: &str) -> Resp {
    request(port, "GET", path, b"")
}

/// 发一条 /api/control 指令（浏览器走的就是这个接口）。
fn control(port: u16, body: Value) -> Resp {
    request(
        port,
        "POST",
        &format!("/api/control?room={ROOM}"),
        body.to_string().as_bytes(),
    )
}

fn op(port: u16, client: &str, name: &str, op: &str, extra: Value) -> Resp {
    let mut body = json!({"room": ROOM, "client": client, "name": name, "op": op});
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    control(port, body)
}

/// 收 SSE 帧：先跳过响应头，然后收集 `data: ` 行里的 JSON。
fn sse_frames(port: u16, query: &str, want: usize, timeout: Duration) -> Vec<Value> {
    let mut stream = connect(port);
    write_request(
        &mut stream,
        "GET",
        &format!("/api/events?{query}"),
        b"",
        true,
    );
    let mut reader = BufReader::new(stream);

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap();
        assert!(n > 0, "SSE 连接在响应头之前就断了");
        if line.trim_end().is_empty() {
            break;
        }
    }

    let deadline = Instant::now() + timeout;
    let mut frames = Vec::new();
    while frames.len() < want && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        reader
            .get_ref()
            .set_read_timeout(Some(remaining.max(Duration::from_millis(1))))
            .unwrap();
        let mut line = String::new();
        let n = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(_) => break, // 读超时：服务端没再发东西
        };
        if n == 0 {
            break;
        }
        if let Some(rest) = line.strip_prefix("data: ") {
            frames.push(serde_json::from_str(rest.trim_end()).expect("SSE 帧不是 JSON"));
        }
    }
    frames
}

fn run_cli(args: &[&str]) -> std::process::Output {
    Command::new(BIN).args(args).output().expect("启动 CLI 失败")
}

// ---------------------------------------------------------------- 资源与路由

#[test]
fn serves_embedded_frontend_and_wasm() {
    let s = Server::start("assets");

    let index = get(s.port, "/");
    assert_eq!(index.status, 200);
    assert_eq!(index.content_type(), "text/html; charset=utf-8");
    assert!(index.text().contains("id=\"video\""), "首页应包含播放器元素");

    let js = get(s.port, "/app.js");
    assert_eq!(js.status, 200);
    assert_eq!(js.content_type(), "application/javascript; charset=utf-8");
    assert!(js.text().contains("EventSource"), "前端应通过 SSE 接收控制信息");

    let css = get(s.port, "/app.css");
    assert_eq!(css.status, 200);
    assert_eq!(css.content_type(), "text/css; charset=utf-8");

    // wasm 哈希器是内嵌进二进制的，必须和仓库里的产物逐字节一致
    let wasm = get(s.port, "/sync_video_player_hash.wasm");
    assert_eq!(wasm.status, 200);
    assert_eq!(wasm.content_type(), "application/wasm");
    assert_eq!(&wasm.body[..4], b"\0asm", "应该是合法的 wasm 魔数");
    let on_disk = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("web/sync_video_player_hash.wasm"),
    )
    .unwrap();
    assert!(wasm.body == on_disk, "内嵌的 wasm 与仓库产物不一致");
    assert!(on_disk.len() < 200_000, "wasm 体积应该保持在几十 KB");

    assert_eq!(get(s.port, "/favicon.ico").status, 204);
}

#[test]
fn hello_reports_abi_and_uptime() {
    let s = Server::start("hello");
    let hello = get(s.port, "/api/hello");
    assert_eq!(hello.status, 200);
    let v = hello.json();
    assert_eq!(v["ok"], json!(true));
    assert_eq!(v["wasm_abi"], json!(WASM_ABI), "前端靠这个数字判断 wasm 版本");
    assert!(v["srv_ms"].as_u64().unwrap() > 0);
    assert!(v["uptime_ms"].as_u64().is_some());
}

#[test]
fn keep_alive_serves_multiple_requests_on_one_connection() {
    let s = Server::start("keepalive");
    let mut stream = connect(s.port);
    let mut reader = BufReader::new(stream.try_clone().unwrap());

    write_request(&mut stream, "GET", "/api/hello", b"", true);
    let first = read_response(&mut reader);
    write_request(&mut stream, "GET", "/app.js", b"", true);
    let second = read_response(&mut reader);

    assert_eq!(first.status, 200);
    assert_eq!(second.status, 200);
    assert_eq!(first.headers["connection"], "keep-alive");
    assert!(second.text().contains("EventSource"));
}

#[test]
fn http_layer_edges() {
    let s = Server::start("edges");

    let preflight = request(s.port, "OPTIONS", "/api/control", b"");
    assert_eq!(preflight.status, 204, "预检请求应无内容返回");
    assert_eq!(preflight.headers["access-control-allow-origin"], "*");

    assert_eq!(get(s.port, "/nope").status, 404);
    assert_eq!(request(s.port, "DELETE", "/api/hello", b"").status, 404);

    let bad = request(s.port, "POST", "/api/control", "{这不是 json".as_bytes());
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json()["error"], json!("bad_json"));

    // 只发请求头：服务端看到 Content-Length 超限就直接 413，不会去读文件字节
    let mut stream = connect(s.port);
    let head = format!(
        "POST /api/control HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        2 * 1024 * 1024
    );
    stream.write_all(head.as_bytes()).unwrap();
    let mut reader = BufReader::new(stream);
    let big = read_response(&mut reader);
    assert_eq!(big.status, 413, "超过 1 MiB 的控制请求必须被拒绝");
    assert!(big.text().contains("不接受文件字节"));
}

// ---------------------------------------------------------------- 房间协议

#[test]
fn room_control_flow() {
    let s = Server::start("control");
    let hash = "a".repeat(64);

    let set = op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash, "size": 1024, "name": "movie.mkv", "duration_ms": 60_000, "mode": "full"}),
    );
    assert_eq!(set.status, 200);
    let set = set.json();
    assert_eq!(set["state"]["media"]["hash"], json!(hash));
    assert_eq!(set["state"]["owner"], json!("c1"));
    assert_eq!(set["state"]["playing"], json!(false));

    // 第二个人拿同一份文件可以加入
    let join = op(
        s.port,
        "c2",
        "乙",
        "set_media",
        json!({"hash": hash, "size": 1024, "name": "movie.mkv", "mode": "full"}),
    );
    assert_eq!(join.status, 200);

    // 播放 → 跳转 → 倍速
    let playing = op(s.port, "c1", "甲", "play", json!({})).json();
    assert_eq!(playing["state"]["playing"], json!(true));
    let seek = op(s.port, "c2", "乙", "seek", json!({"value": 30_000})).json();
    let pos = seek["state"]["pos_ms"].as_i64().unwrap();
    assert!(
        (30_000..31_000).contains(&pos),
        "跳转后位置应在 30 秒附近，实际 {pos}ms"
    );
    let rate = op(s.port, "c2", "乙", "rate", json!({"value": 2})).json();
    assert_eq!(rate["state"]["rate"], json!(2.0));
    // 倍速会被钳制在 0.25 ~ 4
    let rate = op(s.port, "c2", "乙", "rate", json!({"value": 99})).json();
    assert_eq!(rate["state"]["rate"], json!(4.0));

    let paused = op(s.port, "c2", "乙", "pause", json!({})).json();
    assert_eq!(paused["state"]["playing"], json!(false));

    // 客户端得先上报自己的文件哈希，房间才能判断它有没有选对文件
    op(
        s.port,
        "c2",
        "乙",
        "heartbeat",
        json!({"hash": hash, "size": 1024, "ready": true, "buffering": false}),
    );

    // 状态查询：参与者列表会带上"有没有选对文件"
    let state = get(s.port, &format!("/api/state?room={ROOM}&client=c2&name=乙")).json();
    assert_eq!(state["ok"], json!(true));
    assert_eq!(state["room"], json!(ROOM));
    let clients = state["clients"].as_array().unwrap();
    let c2 = clients
        .iter()
        .find(|c| c["id"] == json!("c2"))
        .expect("c2 应在房间里");
    assert_eq!(c2["matches"], json!(true));
    assert_eq!(c2["online"], json!(true));

    // 未知指令不该静默通过
    let unknown = op(s.port, "c1", "甲", "乱来", json!({}));
    assert_eq!(unknown.status, 400);
    assert_eq!(unknown.json()["error"], json!("unknown_op"));
}

#[test]
fn different_hash_is_refused_with_409() {
    let s = Server::start("mismatch");
    let hash_a = "a".repeat(64);
    let hash_b = "b".repeat(64);

    op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash_a, "size": 1024, "name": "movie.mkv", "duration_ms": 60_000}),
    );
    let denied = op(
        s.port,
        "c2",
        "乙",
        "set_media",
        json!({"hash": hash_b, "size": 2048, "name": "other.mkv"}),
    );
    assert_eq!(denied.status, 409);
    let body = denied.json();
    assert_eq!(body["error"], json!("hash_mismatch"));
    assert_eq!(body["ok"], json!(false));
    // 前端要靠这个把房间里真正的媒体信息显示出来
    assert_eq!(body["expected"]["hash"], json!(hash_a));
    assert_eq!(body["expected"]["size"], json!(1024));
    assert_eq!(body["expected"]["name"], json!("movie.mkv"));

    // 非法哈希（位数不对）不是 409，而是 400
    let bad = op(
        s.port,
        "c2",
        "乙",
        "set_media",
        json!({"hash": "xyz", "size": 1, "name": "x"}),
    );
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json()["error"], json!("bad_request"));
}

#[test]
fn buffering_pauses_the_room_and_resumes_it() {
    let s = Server::start("buffer");
    let hash = "a".repeat(64);
    op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash, "size": 1024, "name": "movie.mkv", "duration_ms": 600_000}),
    );
    op(s.port, "c1", "甲", "play", json!({}));

    let stalled = op(
        s.port,
        "c2",
        "乙",
        "heartbeat",
        json!({"hash": hash, "size": 1024, "ready": true, "buffering": true}),
    )
    .json();
    assert_eq!(stalled["state"]["playing"], json!(false), "有人缓冲时全场暂停");
    assert_eq!(stalled["state"]["paused_by_wait"], json!(true));
    assert_eq!(stalled["state"]["waiting_for"], json!(["乙"]));

    let resumed = op(
        s.port,
        "c2",
        "乙",
        "heartbeat",
        json!({"hash": hash, "size": 1024, "ready": true, "buffering": false}),
    )
    .json();
    assert_eq!(resumed["state"]["playing"], json!(true), "缓冲结束后自动续播");
    assert_eq!(resumed["state"]["paused_by_wait"], json!(false));
    assert_eq!(resumed["state"]["waiting_for"], json!([]));

    // 关掉等待缓冲后，有人卡住也不再打断全场
    op(
        s.port,
        "c1",
        "甲",
        "set_options",
        json!({"wait_for_buffer": false}),
    );
    let stalled = op(
        s.port,
        "c2",
        "乙",
        "heartbeat",
        json!({"hash": hash, "size": 1024, "ready": true, "buffering": true}),
    )
    .json();
    assert_eq!(stalled["state"]["playing"], json!(true));
    assert_eq!(stalled["state"]["wait_for_buffer"], json!(false));
}

#[test]
fn reset_media_clears_the_room() {
    let s = Server::start("reset");
    let hash = "a".repeat(64);
    op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash, "size": 1024, "name": "movie.mkv", "duration_ms": 60_000}),
    );
    op(s.port, "c1", "甲", "play", json!({}));
    let reset = op(s.port, "c1", "甲", "reset_media", json!({})).json();
    assert_eq!(reset["state"]["media"], json!(null));
    assert_eq!(reset["state"]["owner"], json!(null));
    assert_eq!(reset["state"]["playing"], json!(false));
    assert_eq!(reset["state"]["pos_ms"], json!(0));
}

// ---------------------------------------------------------------- SSE

#[test]
fn sse_pushes_room_state() {
    let s = Server::start("sse");
    let hash = "a".repeat(64);
    op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash, "size": 1024, "name": "movie.mkv", "duration_ms": 60_000}),
    );

    // 空闲时靠心跳帧续着，客户端每秒都能收到一份快照
    let frames = sse_frames(
        s.port,
        &format!("room={ROOM}&client=sse1&name=看客"),
        2,
        Duration::from_secs(5),
    );
    assert!(
        frames.len() >= 2,
        "应至少收到 2 个快照，实际 {}",
        frames.len()
    );
    let first = &frames[0];
    assert_eq!(first["media"]["hash"], json!(hash));
    assert!(first["srv_ms"].as_u64().unwrap() > 0, "客户端用它校准时钟");
    assert_eq!(first["playing"], json!(false));

    // 空闲期间的快照签名不变：客户端因此不会做任何对齐动作
    let signature = |v: &Value| {
        json!([
            v["media"]["hash"],
            v["playing"],
            v["base_pos_ms"],
            v["base_srv_ms"],
            v["rate"]
        ])
        .to_string()
    };
    assert_eq!(signature(&frames[0]), signature(&frames[1]));

    // 带 client 参数的 SSE 连接同样会被登记进房间
    let state = get(s.port, &format!("/api/state?room={ROOM}")).json();
    assert!(
        state["clients"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == json!("sse1")),
        "SSE 连接也应出现在参与者列表里"
    );
}

// ---------------------------------------------------------------- 哈希

#[test]
fn cli_hash_matches_independent_digest() {
    let dir = TempDir::new("cli-hash");
    let file = dir.write("movie.bin", HELLO_BYTES);
    let path = file.to_str().unwrap();

    let out = run_cli(&["hash", path, "--json"]);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["hash"], json!(HELLO_DIGEST), "应与 OpenSSL 算出的摘要一致");
    assert_eq!(v["size"], json!(HELLO_BYTES.len() as u64));
    assert_eq!(v["mode"], json!("full"));
    assert_eq!(v["name"], json!("movie.bin"));

    // 人类可读输出里也要带一行可以直接粘进网页的 JSON
    let human = run_cli(&["hash", path]);
    let text = String::from_utf8_lossy(&human.stdout).into_owned();
    assert!(text.contains(HELLO_DIGEST));
    assert!(text.contains("{\"hash\":"));
}

#[test]
fn cli_sample_mode_is_stable_and_file_specific() {
    let dir = TempDir::new("cli-sample");
    // 超过抽样阈值（8 MiB），采样计划才会铺开
    let data: Vec<u8> = (0..12 * 1024 * 1024u64).map(|i| (i % 251) as u8).collect();
    let file = dir.write("big.bin", &data);
    let path = file.to_str().unwrap();

    let json_of = |args: &[&str]| -> Value {
        let out = run_cli(args);
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    };
    let a = json_of(&["hash", path, "--sample", "--json"]);
    let b = json_of(&["hash", path, "--sample", "--json"]);
    assert_eq!(a["mode"], json!("sample"));
    assert_eq!(a["hash"], b["hash"], "同一文件抽样摘要必须稳定");
    assert_eq!(a["hash"].as_str().unwrap().len(), 64);

    let full = json_of(&["hash", path, "--json"]);
    assert_eq!(full["mode"], json!("full"));
    assert_ne!(a["hash"], full["hash"], "抽样摘要与整文件摘要必须区分开");

    // 改动文件中间一个字节，整文件摘要必然变
    let mut changed = data.clone();
    let mid = changed.len() / 2;
    changed[mid] ^= 0xff;
    let file2 = dir.write("big2.bin", &changed);
    let full2 = json_of(&["hash", file2.to_str().unwrap(), "--json"]);
    assert_ne!(full["hash"], full2["hash"]);
}

#[test]
fn cli_hash_reports_failures() {
    let out = run_cli(&["hash", "/没有这个文件/也没有.mkv"]);
    assert!(!out.status.success(), "找不到文件时必须以非零码退出");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("哈希计算失败"),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // 参数错误走另一个出口（退出码 2），并打印用法
    let out = run_cli(&["hash"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("参数错误"));
}

#[test]
fn path_hash_endpoint_matches_room_media() {
    let s = Server::start("path-hash");
    let dir = TempDir::new("path-hash-file");
    let file = dir.write("movie.bin", HELLO_BYTES);
    let path = file.to_str().unwrap();
    let path_url = format!("/api/hash/path?room={ROOM}");

    // 先算一遍拿到摘要，用它建房间
    let digest: Value = serde_json::from_slice(&run_cli(&["hash", path, "--json"]).stdout).unwrap();
    let hash = digest["hash"].as_str().unwrap().to_string();
    op(
        s.port,
        "c1",
        "甲",
        "set_media",
        json!({"hash": hash, "size": HELLO_BYTES.len(), "name": "movie.bin"}),
    );

    let matched = request(
        s.port,
        "POST",
        &path_url,
        json!({"path": path, "size": HELLO_BYTES.len()})
            .to_string()
            .as_bytes(),
    );
    assert_eq!(matched.status, 200);
    let matched = matched.json();
    assert_eq!(matched["hash"], json!(hash));
    assert_eq!(matched["mode"], json!("full"));
    assert_eq!(matched["matches_room"], json!(true));
    assert_eq!(matched["room_hash"], json!(hash));

    // 大小声称得不对 → 拒绝，避免"其实不是同一个文件"
    let wrong_size = request(
        s.port,
        "POST",
        &path_url,
        json!({"path": path, "size": 1}).to_string().as_bytes(),
    );
    assert_eq!(wrong_size.status, 400);
    let wrong_size = wrong_size.json();
    assert_eq!(wrong_size["error"], json!("hash_failed"));
    assert!(wrong_size["message"]
        .as_str()
        .unwrap()
        .contains("大小不匹配"));

    // 空 body 会被当成空对象，于是缺 path
    let missing = request(s.port, "POST", &path_url, b"");
    assert_eq!(missing.status, 400);
    assert_eq!(missing.json()["error"], json!("bad_request"));

    // 路径不存在 → 也是 400 hash_failed，而不是把服务打崩
    let nowhere = request(
        s.port,
        "POST",
        &path_url,
        json!({"path": "/没有这个文件.mkv"}).to_string().as_bytes(),
    );
    assert_eq!(nowhere.status, 400);
    assert_eq!(nowhere.json()["error"], json!("hash_failed"));
}
