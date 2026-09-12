# sync_video_player 设计文档

## 1. 目标与约束

**目标**：局域网内多人一起看同一个视频，播放/暂停/跳转/倍速保持一致；视频文件各人自带。

**硬约束**：

1. 后端用 Rust；
2. 交付单个可运行文件；
3. 只同步控制信息（文件哈希、时间戳等），音量不参与同步；
4. 启动后通过浏览器访问，不需要安装客户端、不需要下载内容；
5. 用户在网页上选择本地视频文件；
6. 哈希必须由 **Rust** 计算；
7. 必须能判定多个用户用的是同一个视频文件；
8. **绝不传输整个文件**：不能为了算哈希把文件传出去，那既浪费网络，又比"本地算"慢得离谱。

**环境约束**（首次实现时）：构建机无法访问 crates.io，本地缓存只有 `tokio` / `serde` / `serde_json`，
没有 `axum`、`hyper`、`tungstenite`、`sha2`。因此 HTTP 服务、服务端推送、SHA-256 全部手写，
最终二进制约 1.0 MB，运行时只依赖 libc。

## 2. 关键取舍

### 2.1 用 WebAssembly 把 Rust 送进浏览器，而不是把文件送到服务器

约束 8 直接排除了"浏览器把文件分片上传给服务端算哈希"的做法。但浏览器出于安全考虑
**不会把本地文件的真实路径暴露给网页**，所以"让 Rust 读本地文件"只剩一条可行路径：
把 Rust 本身送到浏览器里执行。

于是把 `src/sha256.rs`（纯 Rust 增量 SHA-256）编译成 `wasm32-unknown-unknown`，
用几十行 C ABI 暴露 `sync_video_player_begin_full / sync_video_player_update / sync_video_player_finish`，
由网页端把文件按 4 MiB 一批喂进 wasm 线性内存。结果：

- 文件字节的旅程是「磁盘 → 浏览器 File API → wasm 内存 → 摘要」，**全程不出本机**；
- 哈希代码仍然是 Rust，而且是和命令行**同一份源码**；
- 一次性下载量从"整个视频"降到 18 KB 的 wasm 模块（还是从本机服务取的）。

代价与权衡：

| 项 | 说明 |
| --- | --- |
| 速度 | wasm 里 213 MiB/s，原生 CLI 264 MiB/s（约慢 20%）——完全不影响体验，因为省掉了整个网络传输 |
| 兼容性 | 需要浏览器支持 WebAssembly（2017 年后的主流浏览器都支持） |
| 构建复杂度 | 多一步 `scripts/build-wasm.sh`；用 ABI 版本号 + `check-wasm.mjs` 两道护栏防止前后端算法漂移 |
| 兜底 | 浏览器不支持时，仍可用 `sync_video_player hash` 在本地算好后把哈希粘进网页 |

### 2.2 同步走 SSE 而不是 WebSocket

控制消息是"服务器 → 多客户端"的广播 + "客户端 → 服务器"的少量指令。SSE 正好匹配这个形状：
服务端只需写 `data: {...}\n\n`，实现比 WebSocket 帧（掩码、分片、控制帧）简单一个数量级；
断线由浏览器 `EventSource` 自动重连；客户端指令用普通 POST 即可。代价是每条长连接占一个 TCP 连接，
局域网内几十个客户端完全没问题。

### 2.3 服务端只认控制信息：1 MiB 体积闸门

文件通道被删除之后，服务端就不该有任何接收大请求体的能力。`src/http.rs` 里
`MAX_BODY_BYTES = 1 MiB`，超过就返回 **413** 并关闭连接；所有旧的上传接口
（`/api/hash/begin|chunk|sample|finish|cancel`）已经从路由表里彻底移除，冒烟测试会断言它们返回 404。
这样即使有人误接旧客户端，也不可能通过这个服务传文件。

### 2.4 抽样指纹：省的是本地读盘时间，不是网络

抽样模式读头 1 MiB、尾 1 MiB 和 8 个均匀采样点（64 KiB），总计约 3 MB。
它在"绝不传输文件"的前提下依然有用：50 GB 的 remux 完整哈希要读盘约 4 分钟，抽样指纹几秒就出结果。
为了让抽样结果不产生歧义：

- 摘要前先写入域分隔前缀 `RTEST-SAMPLE-V1\n`、文件长度、以及每个采样点的 `offset/len`；
- 采样计划与编码写在一个共享模块 `src/hashspec.rs` 里，**主程序与 wasm 模块通过 `#[path]` 引用同一份源码**，
  从根上避免"两边各写一版、结果对不上"（这个 bug 在第一次实现时真的出现过，现在有测试兜底）。

抽样模式发现不了未采样区域的差异，属于"防拿错文件"而不是"防篡改"，UI 上已明确标注。

## 3. 架构

```
   浏览器 A（本机文件从不外发）                              浏览器 B
 ┌────────────────────────────────┐           ┌────────────────────────────────┐
 │ <video> ── blob: 本地文件      │           │ <video> ── blob: 本地文件      │
 │ app.js                         │           │ app.js                         │
 │ sync_video_player_hash.wasm    │           │ sync_video_player_hash.wasm    │
 │ ↑ 只读本机文件字节·Rust 哈希器 │           │ ↑ 只读本机文件字节·Rust 哈希器 │
 └────────────────┬───────────────┘           └────────────────┬───────────────┘
                 │  仅控制信息：SSE 状态下行 / POST 指令上行  │
                 ▼                                            ▼
    ┌──────────────────────────────────────────────────────────────────────┐
    │              sync_video_player（单个 Rust 可执行文件）               │
    │  http.rs      手写 HTTP/1.1：路由、keep-alive、SSE、1 MiB 体积闸门   │
    │  rooms.rs     房间状态机：位置/倍速/缓冲等待/参与者                  │
    │  hashspec.rs  采样计划与抽样编码（与 wasm 共用）                     │
    │  sha256.rs    纯 Rust 增量 SHA-256（同一份源码也编进 wasm）          │
    │  assets.rs    内嵌 index.html / app.js / app.css / wasm              │
    └──────────────────────────────────────────────────────────────────────┘
```

注意：图中**没有任何一条从浏览器指向服务器的文件数据流**。

## 4. WASM 哈希器接口

模块零依赖、导出简单 C ABI，前端用 `WebAssembly.instantiate` 直接实例化（不需要 wasm-bindgen 工具链）。

| 导出 | 说明 |
| --- | --- |
| `sync_video_player_version() -> u32` | ABI 版本，前端校验不匹配就拒绝使用 |
| `sync_video_player_alloc(len) -> *mut u8` | 在线性内存里申请暂存缓冲（前端只在加载时调用一次） |
| `sync_video_player_begin_full()` | 开始整文件 SHA-256 |
| `sync_video_player_begin_sample(size: u64)` | 开始抽样指纹：内部按共享的 `sample_plan` 写入域前缀与采样点表 |
| `sync_video_player_sample_count() -> u32` | 采样点数量 |
| `sync_video_player_sample_at(i) -> *const u8` | 第 i 个采样点的 `[offset(8B LE), len(8B LE)]` |
| `sync_video_player_update(ptr, len)` | 追加一段字节做增量哈希 |
| `sync_video_player_finish() -> *const u8` | 返回 32 字节摘要，前端转小写十六进制 |

前端按 4 MiB 一批读文件（`File.slice(...).arrayBuffer()`），拷进线性内存后调用 `sync_video_player_update`。
每批都重建 `Uint8Array` 视图，因为 wasm 内存增长会让旧视图失效。

## 5. 同步协议

### 5.1 房间状态

```rust
struct RoomState {
    media: Option<MediaInfo>,   // hash, size, name, duration_ms, mode
    owner: Option<String>,
    playing: bool,
    base_pos_ms: f64,           // 基准位置
    base_srv_ms: u64,           // 基准位置对应的服务器时间戳
    rate: f64,
    wait_for_buffer: bool,
    paused_by_wait: bool,
    clients: BTreeMap<String, ClientInfo>,
}
```

任意服务器时刻 `t` 的有效位置：`pos(t) = playing ? base_pos_ms + (t - base_srv_ms) × rate : base_pos_ms`。

### 5.2 时钟对齐与校正

**时钟对齐**：客户端启动时打 4 次 `GET /api/hello`，取 RTT 最小的样本
`offset = srv_ms - (t0 + t1) / 2`，之后每 30 秒重采样。

**校正策略：偏差不做持续修正，只在"新的控制信息"到达时对齐一次。**

- "新的控制信息"用状态签名判定：`媒体哈希 | playing | base_pos_ms | base_srv_ms | rate`。
  有人操作（播放/暂停/跳转/倍速/设定媒体/重置）或缓冲等待触发暂停续播时，签名才会变。
- 服务端每秒发一次心跳快照用于保活；签名不变，客户端只刷新界面，**不碰播放器**。
- 收到新控制信息时：偏差 > 100 ms 就跳转一次，否则不动；倍速无条件按控制信息设置。
- 平时播放完全不动，偏差自然留存并显示在界面上，直到下一次有人操作。
- 两个额外的一次性对齐点：SSE 重连成功、视频元数据就绪。
- 可选本地开关「本地自动微调」（默认关闭）：只用变速慢慢磨平偏差，不跳转、不联网。

这样设计的原因：持续追平意味着长期占用网络与播放器（频繁 seek 会打断解码），而局域网内人耳对
100 ms 以内的差异并不敏感。把修正收敛到"操作时刻"，行为可预测，也不会在没人操作时突然跳帧。
下发指令后仍保留 500 ms 抑制窗口，避免自己触发的 `waiting` 事件被误判成"我在缓冲"而引发全场暂停。

### 5.3 缓冲自动等待

客户端连续 600 ms 处于 `readyState < 3` 且不在抑制窗口内才上报 `buffering: true`；
服务器暂停全场并记录 `resume_intent`，等所有哈希一致的在线客户端都不再缓冲时自动续播；
超过 90 秒放弃等待，避免一个掉线客户端卡住全场。可被任意参与者关闭。

### 5.4 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/`、`/app.js`、`/app.css` | 内嵌前端资源 |
| GET | `/sync_video_player_hash.wasm` | 内嵌的 Rust 哈希器（`application/wasm`） |
| GET | `/api/hello` | 服务器时间（时钟对齐）+ wasm ABI 版本 |
| GET | `/api/state?room=&client=&name=` | 完整房间快照 |
| GET | `/api/events?room=&client=&name=` | SSE 状态流（事件 + 每秒心跳） |
| POST | `/api/control` | `play` / `pause` / `seek` / `rate` / `set_media` / `reset_media` / `heartbeat` / `set_options` / `ping` |
| POST | `/api/hash/path` | 服务端读自己的磁盘算整文件哈希（**仅回环地址**，用于视频就在服务器上的场景） |

`set_media` 是"同一文件"的唯一入口：房间为空时确立基准；已有基准且哈希相同则放行（并补齐时长）；
哈希不同返回 409 `hash_mismatch` 与期望值，前端据此锁住播放，并提供"以我的文件为准（重置房间）"的出口。

请求体一律是 JSON 且 ≤1 MiB，超过即 413。

## 6. 安全模型

- 信任边界是"同一个局域网"。没有账号体系，房间号即入口，**不应暴露到公网**。
- 服务端没有任何接收文件字节的接口，1 MiB 体积闸门是代码层兜底；上传接口已被删除并有测试断言。
- `/api/hash/path` 只接受回环地址请求，且要求 `size`、`last_modified` 与浏览器选中的文件一致，
  防止把它当作任意文件读取器。
- 前端不引任何 CDN 资源，wasm 与静态资源都由本机服务提供，离线可用。
- 服务端不持久化任何东西：没有磁盘写入，房间状态都在内存里。

## 7. 验证方式

| 层次 | 手段 |
| --- | --- |
| 哈希正确性 | `sha256.rs` 自带 NIST 向量（空串、`abc`、448/896 位、100 万个 `a`）与分块等价性测试 |
| 抽样规范 | 采样计划排序/越界/读取量测试；抽样摘要稳定性与敏感性测试 |
| 状态机 | 位置/倍速计算、哈希冲突拒绝、跳转钳制、缓冲等待、离线回收的单元测试 |
| **wasm 与 CLI 一致性** | `scripts/check-wasm.mjs`：直接实例化 wasm，与 Node `crypto`、`sync_video_player hash`、`sync_video_player hash --sample` 三向比对 |
| 端到端 | `scripts/smoke.sh`：真实起服务，41 项断言覆盖静态资源→wasm 提供→上传接口 404→体积闸门→房间→同步→SSE→重置 |
| 前端接线 | `scripts/check-ui.mjs`：校验 `app.js` 引用的 id/class 在 HTML 中存在，且 HTML id 不重复 |

未能自动验证的部分：真实浏览器里 `<video>` 的解码与渲染行为（本环境的无头浏览器无法驱动文件选择、也无法播放视频）。
wasm 的哈希正确性已用 Node 直接实例化验证（同一份字节码、同一套调用序列），UI 接线有静态检查兜底，
但"点开网页选文件、看到画面同步"这一步仍建议真机跑一遍。

## 8. 后续可做

- 用 WebCodecs + MSE 在客户端转封装，支持 MKV/H.265 等浏览器不原生支持的容器。
- 房间口令/令牌鉴权，减少"知道房间号即可加入"的暴露面。
- 把房间状态落盘，支持服务重启后恢复。
- 播放列表与"下一集"队列。
- 把 wasm 构建接进 `build.rs`（当前依赖开发者记得跑 `scripts/build-wasm.sh`，由 ABI 校验与冒烟测试兜底）。
