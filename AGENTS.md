# 项目工作约定

## Git 版本管理（重要）

这个项目**必须用 Git 管理代码，改动要小步提交、随时可回退**。别攒一大堆改动最后一把梭。

- **每完成一个独立改动就提交一次**，不要等"全部做完"再提交。一次提交只做一件事。
- **新功能必须带配套测试**：新增功能或行为变更时，同一个提交里就要有对应测试
  （单元 / 集成 / wasm / 前端检查按改动层次选，约定见 `docs/TESTING.md`）；
  没有测试的新功能不算做完，不许先合代码再补测试。
- **提交前先跑验证**：`bash scripts/test.sh --quick`（Rust 单元+集成、wasm 测试、前端检查）必跑；
  改了前端、协议或 wasm 再加 `bash scripts/test.sh`（含 release 构建与冒烟测试）。
  测试没过就不要提交，更不要推送。
- **测试会自动跑**：`.github/workflows/ci.yml`（push / PR）和已启用的 `.githooks/pre-push` 钩子
  （急用时 `SKIP_TESTS=1 git push` 跳过）。分层、覆盖面与加测试的约定见 `docs/TESTING.md`。
- **提交信息**用 `类型: 中文简述` 的格式，类型取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
  例如 `fix: 缓冲等待在 90 秒后不再无限期挂起`。
- **别提交构建产物**：`target/`（含 `wasm/target/`）和 `vendor/` 已在 `.gitignore` 里。
  例外是 `web/sync_video_player_hash.wasm`——它是**刻意入库**的，方便别人 clone 下来直接跑；改了 wasm 源码要连它一起提交。
- **推送**：`git push origin main`，远端是 https://github.com/Jnternet/sync_video_player 。
  需要代理时本仓库已配好 `http.proxy` / `https.proxy`。
- **发布**打附注标签：`git tag -a v0.1.0 -m "v0.1.0"`，标签要单独推：`git push origin refs/tags/v0.1.0`。
- **已推送的分支不要 force push**。只有在确认没有别人基于它工作时才允许 `--force-with-lease`。
- 动手改代码前先看一眼 `git status`，别把别人（或用户）没提交的改动一起卷进自己的提交里。

## 项目要点

- 两条硬规则不能破：**视频字节不出本机**、**哈希由 Rust 在本机算**（wasm）。任何改动都要守住这两条。
- 协议里**不含**音量/静音等纯本地状态；加字段前先想清楚它是不是该同步。
- `src/hashspec.rs` 和 `src/sha256.rs` 由主程序与 wasm **共用同一份源码**，
  改完必须重跑 `bash scripts/build-wasm.sh` 再 `cargo build --release`，否则两边算法会漂移。
- 用户可见的文案是中文，代码注释也用中文。

## 发版流程（每个版本都要做）

**每更新一个版本，都要构建 Linux 和 Windows 两个平台的产物并推到 GitHub Release**，
不要只推代码：用户是直接下载二进制来用的。

```bash
bash scripts/test.sh                         # 先确认测试全绿（单元+集成+前端+wasm+冒烟）
bash scripts/package-release.sh              # 构建 + 打包到 dist/
bash scripts/package-release.sh --publish    # 上传到 GitHub Release
```

- 产物：`sync_video_player-vX.Y.Z-x86_64-unknown-linux-musl.tar.gz`
  （musl 静态链接，任何 Linux 都能直接跑）和 `sync_video_player-vX.Y.Z-x86_64-pc-windows-gnu.zip`
  （Windows exe，只依赖系统 DLL）。两个包里都带 `README.md`。
- 版本号取自 `Cargo.toml` 的 `version`，标签同名 `vX.Y.Z`；
  **标签要单独推**：`git push origin refs/tags/vX.Y.Z`。
- Windows 产物靠 zig 交叉编译（本机没有 mingw）：需要 `rustup target add x86_64-pc-windows-gnu`
  和 `cargo-zigbuild`（`cargo install cargo-zigbuild --locked`），zig 在 `~/.local/bin/zig`。
  脚本会把 zig 的缓存目录放到 `target/` 下，容器里 `$HOME/.cache` 只读也不影响。
- 上传的 token 从 `~/.git-credentials` 读，也可以用 `GITHUB_TOKEN` 环境变量覆盖。
- 发布后验证一次真产物：`bash scripts/smoke.sh dist/.../sync_video_player`
- 这个容器里往 `$HOME` 下写常常需要提权；`target/` 和 `/tmp` 可以随便写。
