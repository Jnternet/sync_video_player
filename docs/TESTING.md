# 测试说明

目标是「改动之后，一条命令就能知道有没有搞坏东西」，而且**以后不用有人记得手动跑**。
所以测试分了几层，从快到慢、从局部到整体，全都能被 `scripts/test.sh` 串起来自动执行。

| 层次 | 位置 | 覆盖什么 | 前置条件 |
| --- | --- | --- | --- |
| 单元测试 | `src/*.rs` 里的 `#[cfg(test)]` | SHA-256 向量、抽样规范、HTTP 解析、房间状态机、命令行解析 | 无（不开端口） |
| 集成测试 | `tests/e2e.rs` | 真的启动编译出来的服务，走 HTTP / SSE / CLI 全链路 | 能监听 `127.0.0.1` |
| wasm 测试 | `wasm/src/lib.rs` 的 `#[cfg(test)]` | 浏览器用的 C ABI 全流程、抽样计划、与主程序摘要一致 | 无（本机跑，不需要 wasm 目标） |
| 前端检查 | `scripts/check-ui.mjs`、`scripts/check-sync-policy.mjs`、`scripts/check-fullscreen.mjs`、`scripts/check-wasm.mjs` | DOM 接线、同步策略、全屏控制条浮现/淡出（后两者都用 DOM 桩跑真实 `app.js`）、wasm vs CLI vs Node crypto | node |
| 端到端冒烟 | `scripts/smoke.sh` | 46 项真实服务检查（静态资源、房间控制、缓冲等待、SSE、路径哈希…） | curl、jq、node |

## 一条命令跑完

```bash
bash scripts/test.sh            # 全量：Rust 测试 + 前端检查 + wasm 一致性 + 冒烟测试
bash scripts/test.sh --quick    # 提交前够用：不开端口、不构建 release
bash scripts/test.sh --help
```

脚本会逐步打印 `✅ / ❌`，最后统计「通过 / 失败 / 跳过」；有失败就以非 0 退出，可以直接挂自动化。
缺 node、curl、jq 或 wasm 目标时会跳过对应步骤并说明原因，不会静默变绿。

## 以后怎么自动跑

三道自动关卡，都是这次加的：

1. **GitHub Actions CI**（`.github/workflows/ci.yml`）：push 到 `main`、开 PR 或手动触发时跑全套。
   里面还多一条**产物漂移检查**——重新编译 wasm 后，比对它与仓库里 `web/sync_video_player_hash.wasm`
   算出的摘要，不一致就直接红，防止「改了 `sha256.rs` / `hashspec.rs` 却忘了重新构建并提交 wasm」。
   比的是**摘要**而不是字节：不同 rustc 版本编出的 wasm 体积差很多（实测 18089 vs 22347 字节），
   字节比法会误报；摘要一致才说明算法真的没漂移。重编译的产物写到临时目录（`WASM_OUT=`），
   不会覆盖仓库里那份文件——冒烟测试还要靠它验证「服务端发出去的就是提交进仓库的产物」。
2. **pre-push 钩子**（`.githooks/pre-push`）：本地推送前自动跑测试，没过就拦住推送。
   已在本仓库启用（`git config core.hooksPath .githooks`）；换机器 clone 后启用一次即可：

   ```bash
   git config core.hooksPath .githooks
   ```

   急用时跳过：`SKIP_TESTS=1 git push`；只想跑快的：`QUICK_TESTS=1 git push`。
3. **发版流程**：发版脚本本身要求先跑 `cargo test && bash scripts/smoke.sh`，见 `AGENTS.md`。

## 各层都在测什么

### 单元测试（58 项，`cargo test --bin sync_video_player`）

- `src/sha256.rs`：NIST/FIPS 180-4 官方向量（空串、`abc`、448 位块、100 万个 `a`）、
  任意分片不影响摘要、`finalize_reset` 复用、`sha256_hex` 便捷函数、十六进制哈希格式校验。
- `src/hashspec.rs`：小文件退化成整文件、采样点排序且在文件内、抽样摘要可重复且对改动敏感。
  还覆盖抽样阈值边界（正好 8 MiB / 刚超 8 MiB）、模式名解析、头部把长度与采样点表绑进摘要。
  这份实现与 wasm **共用同一份源码**，所以这里的断言对两条路径都成立。
- `src/http.rs`：请求行/查询参数百分号解码、keep-alive 与管线化、HTTP/1.0 默认关闭、
  非法请求行、超过 1 MiB 的请求体（413 闸门）、超长请求头不挂起、`Expect: 100-continue`、
  响应头字段与 SSE 头。连接抽象成 `Conn<S: AsyncRead + AsyncWrite>`，
  测试用内存管道跑，不占端口也不受沙箱限制。
- `src/rooms.rs`：播放/暂停/跳转的位置数学、倍速钳制与位置连续性、暂停时基准时钟不动、
  缓冲等待（有人卡住全场暂停 → 全部就绪自动续播 → **90 秒后放弃续播，不再无限期挂起**）、
  掉线客户端被回收且不影响房间、同哈希补时长不覆盖元信息、心跳字段更新与哈希转小写、
  房主与快照字段、房间名规范化与注册表复用。
- `src/main.rs`：命令行解析（默认值、`--bind/--port/--room/--open`、缺值/未知参数、`help` 优先）、
  本机路径哈希（摘要与 OpenSSL 独立结果一致、大小/修改时间不匹配时拒绝、目录与非文件报错）。

### 集成测试（13 项，`tests/e2e.rs`）

不 mock 服务端：每个用例真的 `spawn` 编译出来的二进制，选一个空闲端口，用自己写的极简 HTTP 客户端
（只依赖标准库）发请求，用例结束回收进程。覆盖：

- 内嵌资源：首页/JS/CSS 的类型与内容、`/favicon.ico`、**内嵌 wasm 与仓库产物逐字节一致**；
- `/api/hello` 的 `wasm_abi`（前端靠它判断 ABI）、`/api/state` 的参与者列表与 `matches` 标记；
- keep-alive 上连发两个请求、`OPTIONS` 预检 204、未知路径 404、坏 JSON 400、
  `Content-Length` 超 1 MiB → **413**、`/api/hash/begin|chunk|sample|finish|cancel`
  **五个旧上传接口全部 404**（视频字节不出本机这条硬规则）；
- 房间协议：设媒体、同哈希加入、**不同哈希 409 + `hash_mismatch` + `expected` 信息**、
  播放/跳转/倍速（含钳制）、暂停、重置房间、未知指令 400；
- 缓冲等待：有人缓冲暂停全场（`waiting_for` 列出是谁）→ 就绪后自动续播 → 关掉 `wait_for_buffer` 后不再打断；
- SSE：空闲也能收到快照，**心跳快照的状态签名不变**（客户端因此不会做任何对齐）；
- 哈希：`hash --json` 与 OpenSSL 独立摘要一致、抽样摘要稳定且与整文件摘要区分、
  改动中间一个字节整文件摘要必变、缺文件退出码非 0、参数错误退出码 2；
- `/api/hash/path`：与房间媒体匹配、大小不匹配被拒、缺 `path` 与不存在的路径都返回 400。

### wasm 测试（20 项，`cargo test --manifest-path wasm/Cargo.toml`）

被测的是**导出给浏览器的那些 C 函数**，在本机（x86）上直接调用：
ABI 版本号、`alloc/free`、空输入与 `abc` 的向量值、`null`/0 长度调用被忽略、
分片更新与一次性更新等价、抽样计划来自 ABI 且排序有界、**ABI 路径与主程序 `hashspec` 路径算出的抽样摘要一致**。
这些函数共用一组 `static` 状态，所以测试内部串行执行。

### 前端检查（node）

- `check-ui.mjs`：`app.js` 用到的 id/class 必须都在 `index.html` 里，且 id 不重复
  —— 这类拼写错误在浏览器里只表现为「按钮点了没反应」。它还顺带卡住控制条的样子：
  控制条必须是 `.video-wrap` 的**兄弟节点**（不能塞进画面容器，否则会被 `overflow`/合成层吃掉）、
  默认必须是在文档流里「收起时 `max-height:0`、有活动时展开」的滑出式（**默认不能叠在画面上**：
  浮层在有些显卡/浏览器上会被画到视频层下面，表现是「点得到、看不见」，所以它只能是可选模式）、
  **全屏时必须把控制条的位置常驻预留**（高度固定、只淡入淡出，画面尺寸位置不能变——
  否则控制条一出现就把画面挤上去，调进度时画面会跳）、
  浮层模式（`.ctl-float`）必须绝对定位 + `transform: translateZ(0)`、浮层隐藏态必须有
  `opacity:0 + pointer-events:none`、全屏布局必须由 `.is-fs` 类驱动、全屏元素必须是 `.stage`，
  而且 **CSS 里不许出现 `:-webkit-full-screen` / `:-moz-full-screen`**（Firefox 不认带前缀的
  全屏伪类，选择器列表里只要有一个不认识的，整条规则会被整体丢掉——这是「全屏后控制条不浮现」
  那次问题的根因）。`app.js` 侧还要求浮现逻辑挂在 `window` 捕获阶段、按画面矩形算坐标
  且**不带任何条件判断**（漏判一次就是「晃鼠标不出现」），并保留顶栏状态胶囊、
  `?debug=1` 调试面板（含 `elementFromPoint` 命中测试）；`.stage.ctl-docked` 的停靠样式
  （浮层画不出来时的退路）和 `hideControls()` 里的停靠短路也必须留着。
- `check-sync-policy.mjs`：用最小 DOM 桩加载**真实交付的 `web/app.js`**，断言心跳不会引起任何
  跳转/播放/暂停/变速，只有出现新的控制信息才允许调整。
- `check-fullscreen.mjs`：同样加载真实的 `web/app.js`，用假定时器推进时间，断言全屏控制条
  「点全屏时给 `.stage` 加 `.is-fs` → 任何鼠标晃动都浮现（画面外也浮现，宁可多亮不能漏）→
  静止 2.6 秒淡出 → 鼠标停在控制条上或正拖进度条时不淡出 → 暂停时一直留着、续播后重新计时 →
  退出全屏摘掉 `.is-fs`，窗口模式下同样是这一套」，外加状态胶囊文案与「默认滑出、顶栏可切
  浮层、切回滑出」。
- `check-wasm.mjs`：同一个文件分别用 Node `crypto`、wasm 模块、`sync_video_player hash` 算摘要，
  整文件与抽样两种模式都必须三方一致。

### 冒烟测试（46 项，`scripts/smoke.sh`）

真实构建产物 + 真实进程 + curl，覆盖静态资源、CLI 哈希与 `sha256sum` 一致、
**旧的「上传分片」接口已返回 404**、**>1 MiB 请求体被 413 拒绝**、房间控制、缓冲等待、
SSE 推送、空闲期间签名不变、服务端路径哈希、重置房间，并在其中调用上面的 Node 检查。

## 加新测试的约定

- **新功能必须带配套测试**：新增功能、新接口或行为变更，要在**同一个提交**里补上对应测试，
  不许「先合代码、测试以后再说」。测试放在哪一层看改动本身：
  纯逻辑（哈希、协议解析、房间状态机）放单元测试；跨进程/走 HTTP、SSE、CLI 的放 `tests/e2e.rs`；
  浏览器侧逻辑放 wasm 测试或 `scripts/check-*.mjs`；只影响页面的改动至少要有前端检查兜底。
  确实没法写自动化测试的（比如纯视觉调整），要在提交信息里说明原因和人工验证方式。
- 测试与代码放在一起（`#[cfg(test)] mod tests`）或放 `tests/`，不新建独立的测试工程。
- 断言里写上**为什么**（中文），出问题时看断言信息就能定位，不用再翻代码。
- 涉及「两条硬规则」的改动必须留测试：视频字节不出本机（413 闸门、没有上传接口）、
  哈希由本机 Rust 算（wasm 与主程序摘要一致）。
- 期望值尽量来自**独立实现**（NIST 向量、OpenSSL/node crypto 结果），不要拿本项目自己的实现自证。
- 改了 `src/sha256.rs`、`src/hashspec.rs` 或 `wasm/src/lib.rs`，收尾三步：
  `bash scripts/build-wasm.sh` → `cargo build --release` → 提交 `web/sync_video_player_hash.wasm`。

## 常见问题

- **`cargo test` 里端到端测试连不上端口**：`tests/e2e.rs` 需要能监听 `127.0.0.1`（沙箱/容器里要放开回环）。
  只想跑纯内存测试：`cargo test --lib` 不适用（本项目是二进制），用 `cargo test --bin sync_video_player`。
- **提示缺 node / curl / jq**：对应步骤会被跳过并打印原因；装齐后即自动纳入。
- **提示没装 `wasm32-unknown-unknown`**：`rustup target add wasm32-unknown-unknown`，
  否则跳过「wasm 产物同步检查」。
- **端口被占用**：集成测试自动挑空闲端口并可重试；冒烟测试可用 `PORT=xxxx bash scripts/smoke.sh` 指定。
