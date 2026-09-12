#!/usr/bin/env bash
# 构建并打包发布产物：Linux 静态(musl) + Windows(x86_64-pc-windows-gnu)
#
#   bash scripts/package-release.sh                       # 构建 + 打包到 dist/
#   bash scripts/package-release.sh --publish             # 再上传到 GitHub Release
#   bash scripts/package-release.sh --notes-file <文件> --publish
#                                                         # 顺便把发布说明写进 Release
#   bash scripts/package-release.sh --notes "一句话说明" --publish
#
# 依赖：
#   * Linux 产物：  rustup target add x86_64-unknown-linux-musl
#   * Windows 产物：rustup target add x86_64-pc-windows-gnu
#                   zig（https://ziglang.org/download/）+ cargo install cargo-zigbuild --locked
#                   用 ZIG_BIN=/path/to/zig 指定 zig 位置（默认从 PATH 找）
#   * 上传需要 token：环境变量 GITHUB_TOKEN，或 ~/.git-credentials 里的 GitHub 凭据
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLISH=0
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --notes) NOTES="${2:-}"; shift ;;
    --notes-file)
      [ -n "${2:-}" ] && [ -f "$2" ] || { echo "读不到发布说明文件：${2:-（缺参数）}" >&2; exit 2; }
      NOTES="$(cat "$2")"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（可用：--publish / --notes / --notes-file）" >&2; exit 2 ;;
  esac
  shift
done

NAME="sync_video_player"
VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' Cargo.toml | head -1)"
[ -n "$VERSION" ] || { echo "读不到 Cargo.toml 里的版本号" >&2; exit 1; }
TAG="v$VERSION"
LINUX_TARGET="x86_64-unknown-linux-musl"
WINDOWS_TARGET="x86_64-pc-windows-gnu"
DIST="$ROOT/dist"

# zig 需要可写的缓存目录；容器里 $HOME/.cache 常常是只读的，统一放进 target/
export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$ROOT/target/zig-cache}"
export ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$ROOT/target/zig-local-cache}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/target/xdg-cache}"
mkdir -p "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR" "$XDG_CACHE_HOME"

if [ ! -f "web/${NAME}_hash.wasm" ]; then
  echo "缺少 web/${NAME}_hash.wasm，先跑 bash scripts/build-wasm.sh" >&2
  exit 1
fi

echo "== 构建 Linux（$LINUX_TARGET，静态链接）=="
cargo build --release --target "$LINUX_TARGET"

echo
echo "== 构建 Windows（$WINDOWS_TARGET，zig 交叉编译）=="
ZIG_BIN="${ZIG_BIN:-$(command -v zig || true)}"
if [ -z "$ZIG_BIN" ]; then
  echo "找不到 zig。装一个（https://ziglang.org/download/），或设 ZIG_BIN=/path/to/zig" >&2
  exit 1
fi
command -v cargo-zigbuild >/dev/null 2>&1 || {
  echo "找不到 cargo-zigbuild，先跑 cargo install cargo-zigbuild --locked" >&2
  exit 1
}
CARGO_ZIGBUILD_ZIG_PATH="$ZIG_BIN" cargo zigbuild --release --target "$WINDOWS_TARGET"

echo
echo "== 打包 =="
rm -rf "$DIST"
mkdir -p "$DIST"

linux_stage="$DIST/${NAME}-${TAG}-${LINUX_TARGET}"
mkdir -p "$linux_stage"
install -m 755 "target/$LINUX_TARGET/release/$NAME" "$linux_stage/$NAME"
cp README.md "$linux_stage/"
tar -czf "$linux_stage.tar.gz" -C "$DIST" "$(basename "$linux_stage")"
rm -rf "$linux_stage"

windows_stage="$DIST/${NAME}-${TAG}-${WINDOWS_TARGET}"
mkdir -p "$windows_stage"
cp "target/$WINDOWS_TARGET/release/$NAME.exe" "$windows_stage/"
cp README.md "$windows_stage/"
(cd "$DIST" && zip -qr "$(basename "$windows_stage").zip" "$(basename "$windows_stage")")
rm -rf "$windows_stage"

for f in "$DIST"/*.tar.gz "$DIST"/*.zip; do
  printf '  %-58s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done

if [ "$PUBLISH" = 0 ]; then
  echo
  echo "产物在 $DIST/；加 --publish 可上传到 GitHub Release $TAG"
  exit 0
fi

echo
echo "== 上传到 GitHub Release $TAG =="
SLUG="$(git config --get remote.origin.url | sed -E 's#(git@|https://)github\.com[:/]##; s#\.git$##')"
[ -n "$SLUG" ] || { echo "从 git remote 读不到 GitHub 仓库地址" >&2; exit 1; }

if [ -n "${GITHUB_TOKEN:-}" ]; then
  TOKEN="$GITHUB_TOKEN"
else
  TOKEN="$(sed -n 's#https://[^:]*:\([^@]*\)@github\.com#\1#p' "$HOME/.git-credentials" 2>/dev/null | head -1)"
fi
[ -n "${TOKEN:-}" ] || { echo "没有 token：设 GITHUB_TOKEN，或写进 ~/.git-credentials" >&2; exit 1; }

PROXY="$(git config --get http.proxy || true)"
CURL=(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
[ -n "$PROXY" ] && CURL+=(-x "$PROXY")
API="https://api.github.com/repos/$SLUG"

# 按 tag 查询；刚建好的 release 有时会 404（索引延迟），退回列表匹配
find_release() {
  local id
  id="$("${CURL[@]}" "$API/releases/tags/$TAG" | jq -r '.id // empty')"
  if [ -z "$id" ]; then
    id="$("${CURL[@]}" "$API/releases?per_page=100" |
      jq -r --arg t "$TAG" '.[] | select(.tag_name == $t) | .id' | head -1)"
  fi
  printf '%s' "$id"
}

ID="$(find_release)"
if [ -z "$ID" ]; then
  echo "  Release $TAG 不存在，创建一个"
  RESULT="$("${CURL[@]}" -X POST -H 'Content-Type: application/json' "$API/releases" \
    -d "$(jq -nc --arg t "$TAG" --arg b "$NOTES" '{tag_name:$t,name:$t,draft:false,prerelease:false,body:$b}')")"
  ID="$(printf '%s' "$RESULT" | jq -r '.id // empty')"
  if [ -z "$ID" ]; then
    # 并发/延迟导致的 already_exists：再查一次
    ID="$(find_release)"
    [ -n "$ID" ] || { echo "创建 Release 失败：$RESULT" >&2; exit 1; }
  fi
fi

if [ -n "$NOTES" ]; then
  echo "  写入发布说明（$(printf '%s' "$NOTES" | wc -l) 行）"
  "${CURL[@]}" -X PATCH -H 'Content-Type: application/json' "$API/releases/$ID" \
    -d "$(jq -nc --arg b "$NOTES" '{body:$b}')" > /dev/null
fi

for f in "$DIST"/*.tar.gz "$DIST"/*.zip; do
  asset="$(basename "$f")"
  old="$("${CURL[@]}" "$API/releases/$ID/assets" | jq -r --arg n "$asset" '.[] | select(.name==$n) | .id' | head -1)"
  [ -n "$old" ] && "${CURL[@]}" -X DELETE "$API/releases/assets/$old" >/dev/null
  echo "  上传 $asset"
  "${CURL[@]}" -H 'Content-Type: application/octet-stream' --data-binary "@$f" \
    "https://uploads.github.com/repos/$SLUG/releases/$ID/assets?name=$asset" | jq -r '"     → " + (.name // .message)'
done

echo
echo "完成：https://github.com/$SLUG/releases/tag/$TAG"
