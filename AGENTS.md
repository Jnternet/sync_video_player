# 项目工作约定

## Git 版本管理（重要）

这个项目**必须用 Git 管理代码，改动要小步提交、随时可回退**。别攒一大堆改动最后一把梭。

- **每完成一个独立改动就提交一次**，不要等"全部做完"再提交。一次提交只做一件事。
- **提交前先跑验证**：`cargo test` 必跑；改了前端或协议再加 `bash scripts/smoke.sh`。
  测试没过就不要提交，更不要推送。
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
