//! 前端资源在编译期内嵌进可执行文件，运行时不需要任何外部文件。

pub const INDEX_HTML: &str = include_str!("../web/index.html");
pub const APP_JS: &str = include_str!("../web/app.js");
pub const APP_CSS: &str = include_str!("../web/app.css");
/// 浏览器本地运行的 Rust 哈希器。由 scripts/build-wasm.sh 生成。
pub const HASH_WASM: &[u8] = include_bytes!("../web/sync_video_player_hash.wasm");
