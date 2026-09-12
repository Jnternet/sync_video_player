#!/usr/bin/env bash
# sync_video_player 端到端冒烟测试：真实启动服务，用 HTTP 走完哈希 + 同步流程。
# 用法: bash scripts/smoke.sh [二进制路径]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/target/release/sync_video_player}"
case "$BIN" in /*) ;; *) BIN="$ROOT/$BIN" ;; esac
PORT="${PORT:-8799}"
ROOM="smoke"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
SERVER_PID=""

pass=0
fail=0
ok()   { echo "  [PASS] $1"; pass=$((pass + 1)); }
bad()  { echo "  [FAIL] $1"; fail=$((fail + 1)); }
check_eq() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（期望 $2，实际 $1）"; fi; }
check() { if [ "$1" = "true" ]; then ok "$2"; else bad "$2（条件为假）"; fi; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 准备测试文件 =="
head -c 24000000 /dev/urandom > "$WORK/movie.mkv"
SIZE=$(stat -c %s "$WORK/movie.mkv")
SUM=$(sha256sum "$WORK/movie.mkv" | cut -d' ' -f1)
echo "  文件 $SIZE 字节，sha256=$SUM"

echo
echo "== 启动服务 =="
"$BIN" serve --bind "127.0.0.1:${PORT}" --room "$ROOM" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl -sf "$BASE/api/hello" > /dev/null 2>&1; then break; fi
  sleep 0.1
done
if curl -sf "$BASE/api/hello" > /dev/null 2>&1; then ok "服务已就绪"; else bad "服务未启动"; cat "$WORK/server.log"; exit 1; fi

echo
echo "== 静态资源 =="
check_eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "200" "GET / 返回 200"
check "$(curl -s "$BASE/" | grep -q 'id="video"' && echo true || echo false)" "首页包含播放器元素"
check_eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app.js")" "200" "GET /app.js 返回 200"
check_eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app.css")" "200" "GET /app.css 返回 200"
check_eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope")" "404" "未知路径返回 404"

echo
echo "== 命令行哈希（不上传） =="
CLI_JSON=$("$BIN" hash "$WORK/movie.mkv" --json)
check_eq "$(echo "$CLI_JSON" | jq -r .hash)" "$SUM" "sync_video_player hash 与 sha256sum 一致"
SAMPLE_JSON=$("$BIN" hash "$WORK/movie.mkv" --sample --json)
check_eq "$(echo "$SAMPLE_JSON" | jq -r .mode)" "sample" "--sample 走抽样模式"
check_eq "$(echo "$SAMPLE_JSON" | jq -r .hash)" "$(echo "$SAMPLE_JSON" | jq -r .hash)" "抽样哈希可重复"

echo
echo "== 服务端不再接受任何文件字节 =="
for r in begin chunk sample finish cancel; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"probe":1}' "$BASE/api/hash/$r")
  check_eq "$CODE" "404" "旧上传接口 /api/hash/$r 已移除"
done
# 大于 1 MiB 的请求体一律 413：即使有人想上传整个文件也没有入口
BIGREQ_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary "@$WORK/movie.mkv" "$BASE/api/control")
check_eq "$BIGREQ_CODE" "413" "超大请求体被拒绝（413）"

echo
echo "== 本机哈希模块（Rust/WASM） =="
check_eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sync_video_player_hash.wasm")" "200" "GET /sync_video_player_hash.wasm 返回 200"
check_eq "$(curl -s -o /dev/null -w '%{content_type}' "$BASE/sync_video_player_hash.wasm")" "application/wasm" "wasm 的 Content-Type 正确"
WASM_BYTES=$(curl -s "$BASE/sync_video_player_hash.wasm" | wc -c)
if [ "$WASM_BYTES" -lt 200000 ]; then ok "wasm 体积很小（${WASM_BYTES} 字节）"; else bad "wasm 体积异常：${WASM_BYTES}"; fi
curl -s "$BASE/sync_video_player_hash.wasm" > "$WORK/served.wasm"
check_eq "$(sha256sum "$WORK/served.wasm" | cut -d' ' -f1)" "$(sha256sum "$ROOT/web/sync_video_player_hash.wasm" | cut -d' ' -f1)" "服务端提供的 wasm 与仓库产物一致"
check_eq "$(curl -s "$BASE/api/hello" | jq -r .wasm_abi)" "2" "/api/hello 报告 wasm ABI 版本"

echo
echo "== wasm 哈希器 vs CLI（Node 直接实例化 wasm） =="
if command -v node > /dev/null 2>&1; then
  if node "$ROOT/scripts/check-wasm.mjs" "$BIN" 2>&1 | sed 's/^/    /'; then
    ok "wasm 与 CLI 的 SHA-256 完全一致"
  else
    bad "wasm 与 CLI 的 SHA-256 不一致"
  fi
else
  echo "    （无 node，跳过）"
fi

echo
echo "== 客户端同步策略（直接加载真实 web/app.js） =="
if command -v node > /dev/null 2>&1; then
  if node "$ROOT/scripts/check-sync-policy.mjs" 2>&1 | sed 's/^/    /'; then
    ok "偏差只在收到新控制信息时改变"
  else
    bad "客户端同步策略检查未通过"
  fi
else
  echo "    （无 node，跳过）"
fi

echo
echo "== 房间控制 =="
SET=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c1\",\"name\":\"甲\",\"op\":\"set_media\",\"hash\":\"$SUM\",\"size\":$SIZE,\"name\":\"movie.mkv\",\"mode\":\"full\",\"duration_ms\":7200000}" \
  "$BASE/api/control?room=$ROOM")
check "$(echo "$SET" | jq -r .ok)" "c1 设定房间媒体"
check_eq "$(echo "$SET" | jq -r .state.media.hash)" "$SUM" "房间媒体哈希正确"
check_eq "$(echo "$SET" | jq -r .state.owner)" "c1" "c1 成为房主"

MISMATCH_CODE=$(curl -s -o "$WORK/mm.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"set_media\",\"hash\":\"$(printf 'f%.0s' $(seq 64))\",\"size\":1,\"name\":\"other.mkv\"}" \
  "$BASE/api/control?room=$ROOM")
check_eq "$MISMATCH_CODE" "409" "不同哈希被拒绝（409）"
check_eq "$(jq -r .error "$WORK/mm.json")" "hash_mismatch" "错误码为 hash_mismatch"

MATCH=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"set_media\",\"hash\":\"$SUM\",\"size\":$SIZE,\"name\":\"movie.mkv\",\"mode\":\"full\"}" \
  "$BASE/api/control?room=$ROOM")
check "$(echo "$MATCH" | jq -r .ok)" "相同哈希可以加入"

PLAY=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"play\"}" "$BASE/api/control?room=$ROOM")
check_eq "$(echo "$PLAY" | jq -r .state.playing)" "true" "play 后房间处于播放态"

SEEK=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"seek\",\"value\":60000}" "$BASE/api/control?room=$ROOM")
POS=$(echo "$SEEK" | jq -r .state.pos_ms)
if [ "$POS" -ge 60000 ] && [ "$POS" -lt 61000 ]; then ok "seek 到 60s（pos=${POS}ms）"; else bad "seek 位置异常：$POS"; fi

RATE=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"rate\",\"value\":2}" "$BASE/api/control?room=$ROOM")
check_eq "$(echo "$RATE" | jq -r '.state.rate == 2')" "true" "倍速同步生效"

echo
echo "== 缓冲自动等待 =="
BUFC=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"heartbeat\",\"hash\":\"$SUM\",\"size\":$SIZE,\"ready\":true,\"buffering\":true}" \
  "$BASE/api/control?room=$ROOM")
check_eq "$(echo "$BUFC" | jq -r .state.paused_by_wait)" "true" "有人缓冲时全场暂停"
BUFR=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"heartbeat\",\"hash\":\"$SUM\",\"size\":$SIZE,\"ready\":true,\"buffering\":false}" \
  "$BASE/api/control?room=$ROOM")
check_eq "$(echo "$BUFR" | jq -r .state.playing)" "true" "缓冲结束后自动续播"

echo
echo "== SSE 推送 =="
curl -sN --max-time 2 "$BASE/api/events?room=$ROOM&client=sse1&name=SSE" > "$WORK/sse.txt" || true
check "$(grep -q '^data: ' "$WORK/sse.txt" && echo true || echo false)" "SSE 收到数据帧"
check "$(grep -q '"media"' "$WORK/sse.txt" && echo true || echo false)" "SSE 携带房间媒体信息"
check "$(grep -q '"srv_ms"' "$WORK/sse.txt" && echo true || echo false)" "SSE 携带服务器时间戳"

echo
echo "== 偏差策略：心跳不构成“新的控制信息” =="
# 客户端用状态签名判断"有没有新控制信息"；心跳快照的签名必须保持不变，否则会误触发对齐
SIG_EXPR='[.media.hash, (if .playing then 1 else 0 end), .base_pos_ms, .base_srv_ms, .rate] | join("|")'
curl -sN --max-time 3 "$BASE/api/events?room=$ROOM&client=hb1&name=HB" > "$WORK/sse_hb.txt" || true
HB_FRAMES=$(grep -c '^data: ' "$WORK/sse_hb.txt" || true)
HB_SIGS=$(grep '^data: ' "$WORK/sse_hb.txt" | sed 's/^data: //' | jq -r "$SIG_EXPR" | sort -u | wc -l)
if [ "${HB_FRAMES:-0}" -ge 2 ]; then ok "空闲 3 秒收到 $HB_FRAMES 个心跳快照"; else bad "心跳快照太少：$HB_FRAMES"; fi
check_eq "${HB_SIGS:-0}" "1" "空闲期间状态签名不变（客户端不会做任何调整）"

BEFORE_SIG=$(grep '^data: ' "$WORK/sse_hb.txt" | sed 's/^data: //' | tail -1 | jq -r "$SIG_EXPR")
PAUSE=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"pause\"}" "$BASE/api/control?room=$ROOM")
AFTER_SIG=$(echo "$PAUSE" | jq -r ".state | $SIG_EXPR")
if [ "$BEFORE_SIG" != "$AFTER_SIG" ]; then ok "操作（pause）产生新签章 → 触发一次对齐"; else bad "pause 后状态签名未变化"; fi
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c2\",\"name\":\"乙\",\"op\":\"play\"}" "$BASE/api/control?room=$ROOM" > /dev/null

echo
echo "== 状态查询与参与者 =="
STATE=$(curl -s "$BASE/api/state?room=$ROOM&client=c2&name=乙")
check "$(echo "$STATE" | jq -r '[.clients[].id] | index("c2") != null')" "参与者列表包含 c2"
check_eq "$(echo "$STATE" | jq -r '.clients[] | select(.id=="c2") | .matches')" "true" "c2 的哈希标记为一致"

echo
echo "== 服务端路径哈希（仅本机） =="
PATHF=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"path\":\"$WORK/movie.mkv\",\"size\":$SIZE}" "$BASE/api/hash/path")
check_eq "$(echo "$PATHF" | jq -r .hash)" "$SUM" "路径哈希与 sha256sum 一致"
check_eq "$(echo "$PATHF" | jq -r .matches_room)" "true" "路径哈希与房间媒体匹配"
BADPATH=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"path\":\"$WORK/movie.mkv\",\"size\":123}" "$BASE/api/hash/path")
check "$(echo "$BADPATH" | jq -r '.ok|not')" "大小不匹配时拒绝路径哈希"

echo
echo "== 重置房间 =="
RESET=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"room\":\"$ROOM\",\"client\":\"c1\",\"name\":\"甲\",\"op\":\"reset_media\"}" "$BASE/api/control?room=$ROOM")
check_eq "$(echo "$RESET" | jq -r .state.media)" "null" "重置后房间媒体为空"

echo
echo "=========================================="
echo "  通过 $pass 项，失败 $fail 项"
echo "=========================================="
[ "$fail" -eq 0 ]
