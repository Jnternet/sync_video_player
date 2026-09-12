//! 房间与同步状态机。
//!
//! 只同步“控制信息”：媒体身份（哈希/大小/时长）、播放开关、基准时间戳、播放位置、倍速。
//! 音量/静音属于本地状态，协议里根本不存在这些字段。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// 超过这个时间没收到心跳的客户端视为离线
pub const CLIENT_TIMEOUT_MS: u64 = 15_000;
/// 缓冲等待的最长时间，避免一个人卡住整个房间
pub const WAIT_TIMEOUT_MS: u64 = 90_000;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Serialize)]
pub struct MediaInfo {
    pub hash: String,
    pub size: u64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// full = 整文件 SHA-256；sample = 抽样指纹；manual = 用户手动填入
    pub mode: String,
    pub set_at_ms: u64,
}

#[derive(Clone)]
pub struct ClientInfo {
    pub id: String,
    pub name: String,
    pub hash: Option<String>,
    pub size: Option<u64>,
    pub duration_ms: Option<u64>,
    pub ready: bool,
    pub buffering: bool,
    pub last_seen_ms: u64,
}

pub struct RoomState {
    pub media: Option<MediaInfo>,
    pub owner: Option<String>,
    pub playing: bool,
    /// 基准位置（毫秒，浮点以便倍速下累积误差更小）
    pub base_pos_ms: f64,
    /// 基准位置对应的服务器时间戳
    pub base_srv_ms: u64,
    pub rate: f64,
    pub wait_for_buffer: bool,
    pub resume_intent: bool,
    pub paused_by_wait: bool,
    pub clients: BTreeMap<String, ClientInfo>,
    pub version: u64,
}

impl Default for RoomState {
    fn default() -> Self {
        RoomState {
            media: None,
            owner: None,
            playing: false,
            base_pos_ms: 0.0,
            base_srv_ms: now_ms(),
            rate: 1.0,
            wait_for_buffer: true,
            resume_intent: false,
            paused_by_wait: false,
            clients: BTreeMap::new(),
            version: 0,
        }
    }
}

impl RoomState {
    /// 服务器时间 `at` 时的有效播放位置
    pub fn pos_at(&self, at: u64) -> f64 {
        if self.playing {
            let dt = at.saturating_sub(self.base_srv_ms) as f64;
            self.base_pos_ms + dt * self.rate
        } else {
            self.base_pos_ms
        }
    }

    fn duration_ms(&self) -> Option<u64> {
        self.media.as_ref().and_then(|m| m.duration_ms)
    }

    fn clamp(&self, pos_ms: f64) -> f64 {
        let pos = pos_ms.max(0.0);
        match self.duration_ms() {
            Some(dur) if dur > 0 => pos.min(dur as f64),
            _ => pos,
        }
    }

    fn touch(&mut self, id: &str, name: &str, now: u64) -> &mut ClientInfo {
        let entry = self
            .clients
            .entry(id.to_string())
            .or_insert_with(|| ClientInfo {
                id: id.to_string(),
                name: name.to_string(),
                hash: None,
                size: None,
                duration_ms: None,
                ready: false,
                buffering: false,
                last_seen_ms: now,
            });
        if !name.is_empty() {
            entry.name = name.to_string();
        }
        entry.last_seen_ms = now;
        entry
    }

    pub fn play(&mut self, now: u64) {
        let pos = self.pos_at(now);
        self.base_pos_ms = self.clamp(pos);
        self.base_srv_ms = now;
        self.playing = true;
        self.resume_intent = false;
        self.paused_by_wait = false;
        self.version += 1;
    }

    pub fn pause(&mut self, now: u64) {
        let pos = self.pos_at(now);
        self.base_pos_ms = self.clamp(pos);
        self.base_srv_ms = now;
        self.playing = false;
        self.resume_intent = false;
        self.paused_by_wait = false;
        self.version += 1;
    }

    pub fn seek(&mut self, pos_ms: f64, now: u64) {
        if self.playing {
            self.base_srv_ms = now;
        }
        self.base_pos_ms = self.clamp(pos_ms);
        self.version += 1;
    }

    pub fn set_rate(&mut self, rate: f64, now: u64) {
        let pos = self.pos_at(now);
        self.base_pos_ms = self.clamp(pos);
        self.base_srv_ms = now;
        self.rate = rate.clamp(0.25, 4.0);
        self.version += 1;
    }

    /// 重新评估“等待缓冲”：有人缓冲就暂停全场，全部就绪后自动续播。
    /// 返回状态是否发生变化。
    pub fn evaluate_wait(&mut self, now: u64) -> bool {
        if !self.wait_for_buffer {
            if self.paused_by_wait {
                self.paused_by_wait = false;
                self.resume_intent = false;
                return true;
            }
            return false;
        }

        let hash = match self.media.as_ref() {
            Some(m) => m.hash.clone(),
            None => return false,
        };
        let stalled: Vec<String> = self
            .clients
            .values()
            .filter(|c| {
                now.saturating_sub(c.last_seen_ms) < CLIENT_TIMEOUT_MS
                    && c.buffering
                    && c.hash
                        .as_deref()
                        .map(|h| h.eq_ignore_ascii_case(&hash))
                        .unwrap_or(false)
            })
            .map(|c| c.name.clone())
            .collect();

        if !stalled.is_empty() && self.playing {
            let pos = self.pos_at(now);
            self.base_pos_ms = self.clamp(pos);
            self.base_srv_ms = now;
            self.playing = false;
            self.paused_by_wait = true;
            self.resume_intent = true;
            self.version += 1;
            return true;
        }

        if self.paused_by_wait && stalled.is_empty() {
            self.paused_by_wait = false;
            if self.resume_intent && now.saturating_sub(self.base_srv_ms) <= WAIT_TIMEOUT_MS {
                self.base_srv_ms = now;
                self.playing = true;
                self.resume_intent = false;
            } else {
                self.resume_intent = false;
            }
            self.version += 1;
            return true;
        }

        // 等待超时后放弃自动续播
        if self.paused_by_wait
            && self.resume_intent
            && now.saturating_sub(self.base_srv_ms) > WAIT_TIMEOUT_MS
        {
            self.resume_intent = false;
            self.version += 1;
            return true;
        }
        false
    }

    /// 清理离线客户端并复评缓冲等待。返回是否有变化。
    pub fn reap(&mut self, now: u64) -> bool {
        let before = self.clients.len();
        self.clients
            .retain(|_, c| now.saturating_sub(c.last_seen_ms) < CLIENT_TIMEOUT_MS);
        let mut changed = before != self.clients.len();
        if changed {
            self.version += 1;
        }
        if self.evaluate_wait(now) {
            changed = true;
        }
        changed
    }

    pub fn waiters(&self) -> Vec<String> {
        let hash = match self.media.as_ref() {
            Some(m) => m.hash.clone(),
            None => return Vec::new(),
        };
        self.clients
            .values()
            .filter(|c| {
                c.buffering
                    && c.hash
                        .as_deref()
                        .map(|h| h.eq_ignore_ascii_case(&hash))
                        .unwrap_or(false)
            })
            .map(|c| c.name.clone())
            .collect()
    }

    pub fn snapshot(&self, now: u64) -> Value {
        let pos = self.pos_at(now);
        let media_hash = self.media.as_ref().map(|m| m.hash.clone());
        let clients: Vec<Value> = self
            .clients
            .values()
            .map(|c| {
                let matches = match (&media_hash, &c.hash) {
                    (Some(m), Some(h)) => Some(m.eq_ignore_ascii_case(h)),
                    _ => None,
                };
                json!({
                    "id": c.id,
                    "name": c.name,
                    "hash": c.hash,
                    "size": c.size,
                    "duration_ms": c.duration_ms,
                    "ready": c.ready,
                    "buffering": c.buffering,
                    "online": now.saturating_sub(c.last_seen_ms) < CLIENT_TIMEOUT_MS,
                    "matches": matches,
                    "owner": self.owner.as_deref() == Some(c.id.as_str()),
                })
            })
            .collect();

        json!({
            "srv_ms": now,
            "version": self.version,
            "media": self.media,
            "owner": self.owner,
            "playing": self.playing,
            "rate": self.rate,
            "base_pos_ms": self.base_pos_ms.round() as i64,
            "base_srv_ms": self.base_srv_ms,
            "pos_ms": pos.max(0.0).round() as i64,
            "wait_for_buffer": self.wait_for_buffer,
            "paused_by_wait": self.paused_by_wait,
            "waiting_for": self.waiters(),
            "clients": clients,
        })
    }
}

pub struct Room {
    pub id: String,
    pub state: Mutex<RoomState>,
    pub tx: broadcast::Sender<()>,
}

impl Room {
    pub fn new(id: &str) -> Arc<Room> {
        let (tx, _rx) = broadcast::channel(64);
        Arc::new(Room {
            id: id.to_string(),
            state: Mutex::new(RoomState::default()),
            tx,
        })
    }

    pub fn notify(&self) {
        let _ = self.tx.send(());
    }

    pub fn snapshot(&self, now: u64) -> Value {
        let st = self.state.lock().unwrap();
        st.snapshot(now)
    }
}

pub struct Registry {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            rooms: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_or_create(&self, id: &str) -> Arc<Room> {
        let key = normalize_room(id);
        let mut map = self.rooms.lock().unwrap();
        map.entry(key.clone())
            .or_insert_with(|| Room::new(&key))
            .clone()
    }

    pub fn all(&self) -> Vec<Arc<Room>> {
        let map = self.rooms.lock().unwrap();
        map.values().cloned().collect()
    }
}

pub fn normalize_room(id: &str) -> String {
    let cleaned: String = id
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if cleaned.is_empty() {
        "main".to_string()
    } else {
        cleaned
    }
}

#[derive(Debug)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
    pub expected: Option<Value>,
}

impl OpError {
    fn bad(code: &'static str, message: impl Into<String>) -> Self {
        OpError {
            code,
            message: message.into(),
            expected: None,
        }
    }
}

fn as_u64(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| match x {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    })
}

fn as_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| match x {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    })
}

fn as_bool(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(|x| x.as_bool())
}

fn as_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 应用一条控制指令。Ok(()) 表示状态可能已变化，调用方应广播。
pub fn apply_control(
    room: &Room,
    client: &str,
    name: &str,
    op: &str,
    body: &Value,
    now: u64,
) -> Result<(), OpError> {
    let mut st = room.state.lock().unwrap();

    // 除 ping 外的指令都会刷新在线状态
    if !client.is_empty() && op != "ping" {
        st.touch(client, name, now);
    }

    match op {
        "ping" => {}
        "heartbeat" => {
            if client.is_empty() {
                return Err(OpError::bad("bad_request", "缺少 client"));
            }
            let entry = st.touch(client, name, now);
            if body.get("hash").is_some() {
                entry.hash = match body.get("hash") {
                    Some(Value::String(s)) if !s.is_empty() => Some(s.to_ascii_lowercase()),
                    _ => None,
                };
            }
            if let Some(v) = as_u64(body, "size") {
                entry.size = Some(v);
            }
            if let Some(v) = as_u64(body, "duration_ms") {
                entry.duration_ms = Some(v);
            }
            if let Some(v) = as_bool(body, "ready") {
                entry.ready = v;
            }
            if let Some(v) = as_bool(body, "buffering") {
                entry.buffering = v;
            }
            st.evaluate_wait(now);
        }
        "play" => st.play(now),
        "pause" => st.pause(now),
        "seek" => {
            let pos = as_f64(body, "value")
                .ok_or_else(|| OpError::bad("bad_request", "seek 需要 value（毫秒）"))?;
            st.seek(pos, now);
        }
        "rate" => {
            let rate = as_f64(body, "value")
                .ok_or_else(|| OpError::bad("bad_request", "rate 需要 value"))?;
            st.set_rate(rate, now);
        }
        "set_media" => {
            let hash = as_str(body, "hash")
                .ok_or_else(|| OpError::bad("bad_request", "缺少 hash"))?
                .trim()
                .to_ascii_lowercase();
            if !crate::sha256::is_valid_sha256_hex(&hash) {
                return Err(OpError::bad("bad_request", "hash 必须是 64 位十六进制"));
            }
            let size = as_u64(body, "size").unwrap_or(0);
            let media_name = as_str(body, "name").unwrap_or_else(|| "未命名".into());
            let duration_ms = as_u64(body, "duration_ms");
            let mode = as_str(body, "mode").unwrap_or_else(|| "full".into());

            match st.media.as_ref() {
                Some(existing) => {
                    if existing.hash.eq_ignore_ascii_case(&hash) {
                        // 同一个文件：补齐缺失的时长信息
                        if existing.duration_ms.is_none() && duration_ms.is_some() {
                            if let Some(m) = st.media.as_mut() {
                                m.duration_ms = duration_ms;
                            }
                            st.version += 1;
                        }
                    } else {
                        let short = &existing.hash[..12.min(existing.hash.len())];
                        return Err(OpError {
                            code: "hash_mismatch",
                            message: format!(
                                "房间当前媒体哈希是 {}…（{} 字节），与你的文件不一致",
                                short, existing.size
                            ),
                            expected: Some(json!({
                                "hash": existing.hash,
                                "size": existing.size,
                                "name": existing.name,
                                "duration_ms": existing.duration_ms,
                                "mode": existing.mode,
                            })),
                        });
                    }
                }
                None => {
                    st.media = Some(MediaInfo {
                        hash,
                        size,
                        name: media_name,
                        duration_ms,
                        mode,
                        set_at_ms: now,
                    });
                    st.owner = Some(client.to_string());
                    st.base_pos_ms = 0.0;
                    st.base_srv_ms = now;
                    st.playing = false;
                    st.version += 1;
                }
            }
        }
        "reset_media" => {
            st.media = None;
            st.owner = None;
            st.playing = false;
            st.base_pos_ms = 0.0;
            st.base_srv_ms = now;
            st.resume_intent = false;
            st.paused_by_wait = false;
            st.version += 1;
        }
        "set_options" => {
            if let Some(v) = as_bool(body, "wait_for_buffer") {
                if st.wait_for_buffer != v {
                    st.wait_for_buffer = v;
                    st.version += 1;
                    st.evaluate_wait(now);
                }
            }
        }
        other => {
            return Err(OpError::bad("unknown_op", format!("未知指令 {other}")));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_body(hash_byte: char) -> Value {
        json!({
            "hash": hash_byte.to_string().repeat(64),
            "size": 10u64,
            "name": "x.mkv",
            "duration_ms": 60_000u64,
        })
    }

    #[test]
    fn position_math() {
        let mut st = RoomState::default();
        st.base_srv_ms = 1_000;
        st.base_pos_ms = 5_000.0;
        st.playing = true;
        assert_eq!(st.pos_at(1_000), 5_000.0);
        assert_eq!(st.pos_at(2_000), 6_000.0);
        st.pause(2_000);
        assert!(!st.playing);
        assert_eq!(st.base_pos_ms, 6_000.0);
        assert_eq!(st.pos_at(9_999), 6_000.0);
    }

    #[test]
    fn rate_scales_position() {
        let mut st = RoomState::default();
        st.media = Some(MediaInfo {
            hash: "a".repeat(64),
            size: 1,
            name: "x".into(),
            duration_ms: Some(600_000),
            mode: "full".into(),
            set_at_ms: 0,
        });
        st.base_srv_ms = 0;
        st.playing = true;
        st.rate = 2.0;
        assert_eq!(st.pos_at(1_000), 2_000.0);
    }

    #[test]
    fn room_normalization() {
        assert_eq!(normalize_room("  "), "main");
        assert_eq!(normalize_room("abc-123_x"), "abc-123_x");
        assert_eq!(normalize_room("坏字符"), "main");
    }

    #[test]
    fn refuses_different_hash() {
        let room = Room::new("main");
        let now = now_ms();
        apply_control(&room, "c1", "甲", "set_media", &media_body('a'), now).unwrap();
        let err = apply_control(&room, "c2", "乙", "set_media", &media_body('b'), now)
            .expect_err("不同哈希必须被拒绝");
        assert_eq!(err.code, "hash_mismatch");
        // 相同哈希可以加入
        apply_control(&room, "c2", "乙", "set_media", &media_body('a'), now).unwrap();
    }

    #[test]
    fn play_pause_seek() {
        let room = Room::new("main");
        let now = now_ms();
        apply_control(&room, "c1", "甲", "set_media", &media_body('a'), now).unwrap();
        apply_control(&room, "c1", "甲", "play", &json!({}), now).unwrap();
        {
            let st = room.state.lock().unwrap();
            assert!(st.playing);
        }
        apply_control(&room, "c2", "乙", "seek", &json!({"value": 30_000}), now + 100).unwrap();
        {
            let st = room.state.lock().unwrap();
            assert!((st.pos_at(now + 100) - 30_000.0).abs() < 1.0);
        }
        apply_control(&room, "c2", "乙", "pause", &json!({}), now + 200).unwrap();
        {
            let st = room.state.lock().unwrap();
            assert!(!st.playing);
            // seek 之后仍在播放，100ms 后暂停 → 位置是 30s + 100ms
            assert!((st.base_pos_ms - 30_100.0).abs() < 1.0);
        }
    }

    #[test]
    fn seek_is_clamped_to_duration() {
        let room = Room::new("main");
        let now = now_ms();
        apply_control(&room, "c1", "甲", "set_media", &media_body('a'), now).unwrap();
        apply_control(&room, "c1", "甲", "seek", &json!({"value": 999_999}), now).unwrap();
        let st = room.state.lock().unwrap();
        assert_eq!(st.base_pos_ms, 60_000.0);
    }

    #[test]
    fn buffer_wait_pauses_and_resumes() {
        let room = Room::new("main");
        let now = now_ms();
        apply_control(&room, "c1", "甲", "set_media", &media_body('a'), now).unwrap();
        apply_control(
            &room,
            "c1",
            "甲",
            "heartbeat",
            &json!({"hash": "a".repeat(64), "size": 10, "ready": true, "buffering": false}),
            now,
        )
        .unwrap();
        apply_control(&room, "c1", "甲", "play", &json!({}), now).unwrap();

        let hb_buffering = json!({"hash": "a".repeat(64), "size": 10, "ready": true, "buffering": true});
        apply_control(&room, "c2", "乙", "heartbeat", &hb_buffering, now + 500).unwrap();
        {
            let st = room.state.lock().unwrap();
            assert!(!st.playing, "有人缓冲时应暂停全场");
            assert!(st.paused_by_wait);
        }

        let hb_ok = json!({"hash": "a".repeat(64), "size": 10, "ready": true, "buffering": false});
        apply_control(&room, "c2", "乙", "heartbeat", &hb_ok, now + 1_500).unwrap();
        {
            let st = room.state.lock().unwrap();
            assert!(st.playing, "缓冲结束后应自动续播");
            assert!(!st.paused_by_wait);
        }
    }

    #[test]
    fn offline_clients_are_reaped() {
        let room = Room::new("main");
        let now = now_ms();
        apply_control(
            &room,
            "c9",
            "幽灵",
            "heartbeat",
            &json!({"ready": true}),
            now,
        )
        .unwrap();
        {
            let mut st = room.state.lock().unwrap();
            assert_eq!(st.clients.len(), 1);
            let changed = st.reap(now + CLIENT_TIMEOUT_MS + 1);
            assert!(changed);
            assert!(st.clients.is_empty());
        }
    }
}
