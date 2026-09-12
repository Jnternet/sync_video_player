#!/usr/bin/env bash
# 构建浏览器内使用的 Rust 哈希器（WebAssembly），产物复制到 web/sync_video_player_hash.wasm。
# 需要 wasm32-unknown-unknown 目标：rustup target add wasm32-unknown-unknown
#
# 用 WASM_OUT=<路径> 可以把产物写到别处（例如只做「产物有没有跟着源码走」的检查时，
# 输出到临时文件，避免覆盖仓库里那份已经提交的产物）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  echo "缺少 wasm32-unknown-unknown 目标，正在安装…"
  rustup target add wasm32-unknown-unknown
fi

echo "== 编译 wasm 哈希器 =="
cargo build --release --manifest-path wasm/Cargo.toml --target wasm32-unknown-unknown

ARTIFACT="wasm/target/wasm32-unknown-unknown/release/sync_video_player_hash_wasm.wasm"
OUT="${WASM_OUT:-web/sync_video_player_hash.wasm}"
mkdir -p "$(dirname "$OUT")"
cp "$ARTIFACT" "$OUT"

SIZE=$(stat -c %s "$OUT")
echo "== 完成：$OUT（${SIZE} 字节）=="
if [ "$OUT" = "web/sync_video_player_hash.wasm" ]; then
  echo "接下来重新构建主程序，让新产物被内嵌进可执行文件：cargo build --release"
fi
