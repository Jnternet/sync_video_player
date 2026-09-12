#!/usr/bin/env bash
# 构建浏览器内使用的 Rust 哈希器（WebAssembly），产物复制到 web/rtest_hash.wasm。
# 需要 wasm32-unknown-unknown 目标：rustup target add wasm32-unknown-unknown
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  echo "缺少 wasm32-unknown-unknown 目标，正在安装…"
  rustup target add wasm32-unknown-unknown
fi

echo "== 编译 wasm 哈希器 =="
cargo build --release --manifest-path wasm/Cargo.toml --target wasm32-unknown-unknown

ARTIFACT="wasm/target/wasm32-unknown-unknown/release/rtest_hash_wasm.wasm"
cp "$ARTIFACT" web/rtest_hash.wasm

SIZE=$(stat -c %s web/rtest_hash.wasm)
echo "== 完成：web/rtest_hash.wasm（${SIZE} 字节）=="
echo "接下来重新构建主程序，让新产物被内嵌进可执行文件：cargo build --release"

