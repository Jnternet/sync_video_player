#!/usr/bin/env bash
# 一键跑完这个项目的全部测试。
#
#   bash scripts/test.sh            # 全量：Rust 测试 + 前端检查 + wasm 一致性 + 端到端冒烟
#   bash scripts/test.sh --quick    # 只跑不需要 release 产物、不起服务的部分（提交前够用）
#
# 退出码非 0 表示有步骤失败，适合直接挂到 CI / pre-push 钩子上。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：--quick）" >&2; exit 2 ;;
  esac
done

BIN="$ROOT/target/release/sync_video_player"
pass=0
fail=0
skip=0

step() { # step <名字> <命令...>
  local name="$1"
  shift
  echo
  echo "== $name =="
  if "$@"; then
    echo "  ✅ $name"
    pass=$((pass + 1))
  else
    echo "  ❌ $name"
    fail=$((fail + 1))
  fi
}

skipping() {
  echo
  echo "== 跳过：$1 =="
  echo "  （$2）"
  skip=$((skip + 1))
}

has() { command -v "$1" > /dev/null 2>&1; }

echo "===== sync_video_player 测试 ====="
echo "模式：$([ "$QUICK" -eq 1 ] && echo 快速 || echo 全量)"

# ---------------------------------------------------------------- Rust
# 单元测试（src/）+ 端到端集成测试（tests/e2e.rs，会真的起服务）
step "Rust 测试（单元 + 集成）" cargo test

# wasm 哈希器自己也是一个 crate，共用 src/sha256.rs 与 src/hashspec.rs
step "wasm 哈希器测试" cargo test --manifest-path wasm/Cargo.toml

# ---------------------------------------------------------------- 前端（node 静态检查）
if has node; then
  step "前端 DOM 接线检查" node scripts/check-ui.mjs
  step "客户端同步策略检查" node scripts/check-sync-policy.mjs
  step "全屏控制条浮现/淡出检查" node scripts/check-fullscreen.mjs
  step "键盘快捷键检查" node scripts/check-shortcuts.mjs
else
  skipping "前端检查" "没装 node"
fi

if [ "$QUICK" -eq 1 ]; then
  skipping "wasm 产物同步 / release 构建 / 冒烟测试" "快速模式（--quick）"
else
  # ---------------------------------------------------------- release 产物
  # 下面的 wasm 比对要用 CLI 算同一份文件的摘要，所以先构建主程序
  step "构建 release 产物" cargo build --release

  # ------------------------------------------------ wasm 产物是否跟着源码走
  # 注意：不同 rustc 版本编出的 wasm 字节数可能差很多（实测 18089 vs 22347），
  # 所以这里比的是"摘要是否一致"，不是字节是否一致。
  if ! has node; then
    skipping "wasm 产物一致性与哈希一致性" "没装 node"
  elif rustup target list --installed 2> /dev/null | grep -q wasm32-unknown-unknown; then
    # 重编译产物写到 target/，不覆盖仓库里那份（否则后面冒烟测试会比到两份不同的文件）
    fresh="$ROOT/target/wasm-rebuilt.wasm"
    step "重新编译 wasm 哈希器" env WASM_OUT="$fresh" bash scripts/build-wasm.sh
    step "wasm 产物一致 + wasm/CLI/Node 三方一致" \
      env WASM_PATH="$fresh" WASM_COMPARE="$ROOT/web/sync_video_player_hash.wasm" \
      node scripts/check-wasm.mjs "$BIN"
    if ! cmp -s "$fresh" web/sync_video_player_hash.wasm; then
      echo
      echo "  ℹ️  两份 wasm 字节不同（本地 rustc 与产出仓库产物的那份版本不同）；"
      echo "      摘要已比对一致，所以不影响运行，也不用重新提交产物。"
    fi
  else
    skipping "wasm 产物同步检查" "没装 wasm32-unknown-unknown 目标（只验仓库里那份）"
    step "wasm 与 CLI 的哈希一致性" node scripts/check-wasm.mjs "$BIN"
  fi

  if has curl && has jq; then
    step "端到端冒烟测试" bash scripts/smoke.sh "$BIN"
  else
    skipping "端到端冒烟测试" "缺 curl 或 jq"
  fi
fi

echo
echo "=========================================="
echo "  通过 $pass 步，失败 $fail 步，跳过 $skip 步"
echo "=========================================="
[ "$fail" -eq 0 ]
