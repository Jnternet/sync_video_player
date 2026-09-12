'use strict';

/* sync_video_player 前端：本地文件播放 + 控制信息同步
 *
 * 关键点：
 *  - 视频永远是本机 blob: 播放，服务器不保存也不转发任何视频字节。
 *  - 哈希由 Rust 编译出的 WebAssembly 在本机计算，文件字节不经过网络。
 *  - 同步的只有：哈希/大小/时长、播放开关、基准时间戳、位置、倍速。
 *  - 音量、静音只在本机生效，协议里没有这些字段。
 */

const $ = (id) => document.getElementById(id);
const video = $('video');
// 界面版本标记：加 ?debug=1 会显示出来，用来确认浏览器里跑的到底是哪一版前端
const UI_REV = 'v0.1.1';

const fmtTime = (ms) => {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (h > 0 ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
};

const fmtBytes = (n) => {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
};

const shortHash = (h) =>
  (h && h.length === 64) ? h.slice(0, 10) + '…' + h.slice(-6) : (h || '—');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const params = new URLSearchParams(location.search);
const cleanRoom = (params.get('room') || 'main').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32) || 'main';

const S = {
  room: cleanRoom,
  client: localStorage.getItem('sync_video_player.client') || (() => {
    const v = randomHex(8);
    localStorage.setItem('sync_video_player.client', v);
    return v;
  })(),
  name: localStorage.getItem('sync_video_player.name') || ('用户' + Math.floor(Math.random() * 900 + 100)),
  state: null,
  connected: false,
  offset: 0,
  rttMin: Infinity,
  file: null,
  fileUrl: null,
  localHash: null,
  localSize: null,
  localMode: null,
  localName: null,
  localDurationMs: null,
  matches: null,
  buffering: false,
  stallSince: 0,
  suppressUntil: 0,
  drift: null,
  lastSignature: null,
  autoTrim: false,
  scrubbing: false,
  ctlIdleTimer: 0,
  // 按住 D/→ 的快进：holdKey = 正按着哪个键，holdRate = 临时倍速（0 = 没按），
  // holdBaseRate = 按住之前房间的倍速（松手要还回去的那个值）
  holdKey: null,
  holdRate: 0,
  holdBaseRate: 1,
  holdTimer: 0,
  keysOpen: false,   // 快捷键提示面板是否打开
  // float = 叠在画面底部（默认：不占位置、画面不动，bilibili 那种）；
  // slide = 贴着画面下方滑出（占一条高度，但任何环境都画得出来，浮层失效时的退路）
  barMode: localStorage.getItem('sync_video_player.bar_mode') === 'slide' ? 'slide' : 'float',
  debugBox: null,
  hashing: false,
  hashCancel: false,
  wasm: null,
  stagePtr: 0,
  es: null,
};

/* ---------------------------------------------------------------- 网络 */

async function postJSON(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (_) { return { ok: false, message: text || ('HTTP ' + r.status) }; }
  } catch (e) {
    return { ok: false, message: '网络错误: ' + e.message };
  }
}

function op(name, extra) {
  return postJSON('/api/control', Object.assign({
    room: S.room, client: S.client, name: S.name, op: name,
  }, extra || {}));
}

function heartbeat() {
  op('heartbeat', {
    hash: S.localHash,
    size: S.localSize,
    duration_ms: S.localDurationMs,
    ready: video.readyState >= 2,
    buffering: !!S.buffering,
  });
}

async function syncClock() {
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    let r = null;
    try { r = await (await fetch('/api/hello', { cache: 'no-store' })).json(); } catch (_) { break; }
    const t1 = Date.now();
    const rtt = t1 - t0;
    const cand = r.srv_ms - (t0 + t1) / 2;
    if (rtt <= S.rttMin) { S.rttMin = rtt; S.offset = cand; }
  }
  render();
}

function connectStream() {
  if (S.es) { try { S.es.close(); } catch (_) {} }
  const url = '/api/events?room=' + encodeURIComponent(S.room) +
    '&client=' + S.client + '&name=' + encodeURIComponent(S.name);
  const es = new EventSource(url);
  S.es = es;
  es.onopen = () => {
    S.connected = true;
    S.lastSignature = null;   // 重连后按最新控制信息重新对齐一次
    render();
  };
  es.onerror = () => { S.connected = false; render(); };
  es.onmessage = (ev) => {
    try { onState(JSON.parse(ev.data)); } catch (_) {}
  };
}

function onState(st) {
  S.state = st;
  if (S.localHash && st.media) {
    S.matches = st.media.hash.toLowerCase() === S.localHash.toLowerCase();
  } else if (!st.media) {
    S.matches = null;
  }
  // 只有"新的控制信息"才触发一次对齐；每秒的心跳快照（状态签名不变）不碰播放器。
  const sig = stateSignature(st);
  if (sig !== S.lastSignature) {
    S.lastSignature = sig;
    applyControlState(st);
  }
  render();
}

/* -------------------------------------------------------------- 同步核心 */

function targetPos(st) {
  const srvNow = Date.now() + S.offset;
  let pos = st.base_pos_ms;
  if (st.playing) pos += (srvNow - st.base_srv_ms) * st.rate;
  return Math.max(0, pos);
}

// 目标位置按片长夹一下（结尾留 40ms，别正好落在最后一帧上）
function clampPosition(ms) {
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : null;
  let target = Math.max(0, ms);
  if (dur) target = Math.min(target, Math.max(0, dur - 40));
  return target;
}

function hardSeek(ms) {
  const target = clampPosition(ms);
  try { video.currentTime = target / 1000; } catch (_) {}
  S.suppressUntil = Date.now() + 500;
  S.stallSince = 0;
  if (S.buffering) { S.buffering = false; heartbeat(); }
}

async function playLocal() {
  try {
    await video.play();
    $('gestureOverlay').classList.add('hidden');
    return true;
  } catch (_) {
    $('gestureOverlay').classList.remove('hidden');
    return false;
  }
}

/* 一次对齐只在"收到新的控制信息"时发生：播放/暂停/跳转/倍速/缓冲等待等操作。
 * 平时（大家各自播放中）客户端不会为了追平偏差去做任何动作——不跳转、不变速、
 * 也不额外发请求，偏差就这么留着，直到下一次有人操作。 */
const ALIGN_MS = 100;

function stateSignature(st) {
  if (!st || !st.media) return 'none';
  return [st.media.hash, st.playing ? 1 : 0, st.base_pos_ms, st.base_srv_ms, st.rate].join('|');
}

function applyControlState(st) {
  const v = video;
  if (!st || !st.media || S.matches !== true || !S.file) { renderPlayerInfo(); return; }

  // 倍速属于控制信息，按新的控制信息设置（按住 D/→ 的临时倍速优先，松手才让位）
  v.playbackRate = S.holdRate || st.rate;
  syncRateSelect(st.rate);   // 倍速框跟着房间走：按住快进时框里也得是 2 倍
  // 按住快进期间别人改了房间倍速：松手时按新的值还回去，别把别人的选择覆盖掉
  if (S.holdRate && st.rate !== S.holdRate) S.holdBaseRate = st.rate;
  if (v.readyState < 1) { renderPlayerInfo(); return; }

  const target = targetPos(st);
  const diff = v.currentTime * 1000 - target;
  S.drift = diff;

  if (st.playing) {
    if (Math.abs(diff) > ALIGN_MS) hardSeek(target);
    if (v.paused) playLocal();
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(diff) > ALIGN_MS) hardSeek(target);
  }
  renderPlayerInfo();
}

/* 本地心跳：只做两件事——上报缓冲状态、刷新界面。绝不调整播放位置。 */
function tickLocal() {
  const st = S.state;
  const now = Date.now();

  // 只读地刷新“本地偏差”显示（不做任何修正动作）
  if (st && st.media && S.matches === true && video.readyState >= 1) {
    S.drift = video.currentTime * 1000 - targetPos(st);
  }

  const active = st && st.media && st.playing && S.matches === true && !video.paused;
  if (active && video.readyState < 3) {
    if (!S.stallSince) S.stallSince = now;
  } else {
    S.stallSince = 0;
  }
  const stalled = active && S.stallSince > 0 && (now - S.stallSince > 600) && now > S.suppressUntil;
  if (stalled !== S.buffering) {
    S.buffering = stalled;
    heartbeat();
  }

  // 可选的本地微调：默认关闭。开启后只用变速慢慢磨平偏差（不跳转、不联网）。
  // 正按住 D/→ 快进时不插手，否则微调会把 2 倍速拽回去。
  if (S.autoTrim && active && !S.holdRate) {
    const d = S.drift || 0;
    video.playbackRate = Math.abs(d) > 120 ? st.rate * (d > 0 ? 0.96 : 1.04) : st.rate;
  }
  renderPlayerInfo();
}

/* ------------------------------------------------------------- 哈希流程 */

function setProgress(ratio, text) {
  $('hashBar').style.width = Math.max(0, Math.min(1, ratio || 0)) * 100 + '%';
  if (text) $('hashMsg').textContent = text;
}

function setHashMsg(text, kind) {
  const el = $('hashMsg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* 浏览器本地哈希：把 Rust 编译成的 WebAssembly 下载到本机执行。
 * 文件字节只在这台设备的 File API 与 wasm 线性内存之间流动，不经过任何网络。 */

const STAGE_BYTES = 4 * 1024 * 1024;   // 分批读文件的粒度
const WASM_ABI = 2;

async function loadHasher() {
  if (S.wasm) return S.wasm;
  const resp = await fetch('/sync_video_player_hash.wasm');
  if (!resp.ok) throw new Error('无法获取本地哈希模块（HTTP ' + resp.status + '）');
  let mod;
  try {
    mod = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
  } catch (e) {
    throw new Error('哈希模块无法加载：' + e.message);
  }
  const ex = mod.instance.exports;
  const abi = ex.sync_video_player_version();
  if (abi !== WASM_ABI) {
    throw new Error('哈希模块版本不匹配（期望 ' + WASM_ABI + '，实际 ' + abi + '），请重新构建');
  }
  S.wasm = ex;
  S.stagePtr = ex.sync_video_player_alloc(STAGE_BYTES);
  return ex;
}

/** 把文件的一段字节喂给 wasm（按 STAGE_BYTES 分批拷贝进线性内存） */
async function feedRange(ex, file, offset, length, onBytes) {
  for (let done = 0; done < length; done += STAGE_BYTES) {
    if (S.hashCancel) throw new Error('已取消');
    const from = offset + done;
    const to = Math.min(from + STAGE_BYTES, offset + length);
    const bytes = new Uint8Array(await file.slice(from, to).arrayBuffer());
    // 每次重建视图：wasm 内存增长会让旧视图失效
    new Uint8Array(ex.memory.buffer, S.stagePtr, bytes.length).set(bytes);
    ex.sync_video_player_update(S.stagePtr, bytes.length);
    onBytes(bytes.length);
  }
}

function readSamplePlan(ex) {
  const n = ex.sync_video_player_sample_count();
  const plan = [];
  for (let i = 0; i < n; i++) {
    const p = ex.sync_video_player_sample_at(i);
    const dv = new DataView(ex.memory.buffer, p, 16);
    plan.push({
      offset: Number(dv.getBigUint64(0, true)),
      len: Number(dv.getBigUint64(8, true)),
    });
  }
  return plan;
}

function digestHex(ex) {
  const p = ex.sync_video_player_finish();
  return Array.from(new Uint8Array(ex.memory.buffer, p, 32), (b) =>
    b.toString(16).padStart(2, '0')).join('');
}

async function startHash() {
  if (!S.file) { setHashMsg('请先选择本地视频文件', 'bad'); return; }
  if (S.hashing) return;

  const mode = $('hashMode').value;
  const f = S.file;
  S.hashing = true;
  S.hashCancel = false;
  $('hashBtn').disabled = true;
  $('hashCancelBtn').classList.remove('hidden');
  setProgress(0, '正在加载本机哈希模块…');

  try {
    const ex = await loadHasher();
    const label = mode === 'sample' ? '抽样指纹' : '完整 SHA-256';
    const t0 = performance.now();
    let processed = 0;
    let total = f.size;

    const tick = () => {
      const done = total > 0 ? processed / total : 1;
      const secs = (performance.now() - t0) / 1000;
      const speed = secs > 0 ? processed / secs : 0;
      const eta = speed > 0 ? (total - processed) / speed : 0;
      setProgress(done, label + '（本机 Rust/WASM）' + fmtBytes(processed) + ' / ' + fmtBytes(total) +
        ' · ' + (done * 100).toFixed(1) + '% · ' + fmtBytes(speed) + '/s' +
        (eta > 1 ? ' · 约 ' + fmtTime(eta * 1000) : ''));
    };

    if (mode === 'sample') {
      ex.sync_video_player_begin_sample(BigInt(f.size));
      const plan = readSamplePlan(ex);
      total = plan.reduce((a, s) => a + s.len, 0);
      for (const sp of plan) {
        await feedRange(ex, f, sp.offset, sp.len, (n) => { processed += n; });
        tick();
        await new Promise((r) => setTimeout(r, 0));
      }
    } else {
      let lastTick = 0;
      const maybeTick = () => {
        const now = performance.now();
        if (now - lastTick >= 100) { lastTick = now; tick(); }
      };
      ex.sync_video_player_begin_full();
      await feedRange(ex, f, 0, f.size, (n) => { processed += n; maybeTick(); });
      processed = f.size;
    }

    tick();
    const hash = digestHex(ex);
    const elapsed = performance.now() - t0;
    S.localHash = hash;
    S.localSize = f.size;
    S.localMode = mode;
    S.localName = f.name;
    setProgress(1, '完成：本机读取 ' + fmtBytes(total) + '，用时 ' + (elapsed / 1000).toFixed(2) +
      's（' + fmtBytes(total / (elapsed / 1000)) + '/s，全程未联网）');
    setHashMsg('SHA-256 ' + hash, 'ok');
    await setMedia();
  } catch (e) {
    setHashMsg(e.message || '哈希中断', 'bad');
    setProgress(0, '');
  } finally {
    S.hashing = false;
    $('hashBtn').disabled = false;
    $('hashCancelBtn').classList.add('hidden');
    render();
  }
}

async function setMedia() {
  if (!S.localHash) return;
  const res = await op('set_media', {
    hash: S.localHash,
    size: S.localSize,
    name: S.localName || (S.file ? S.file.name : '未命名'),
    mode: S.localMode,
    duration_ms: S.localDurationMs || undefined,
  });
  if (res && res.ok) {
    S.matches = true;
    setHashMsg('已加入房间，哈希匹配 ✔', 'ok');
  } else if (res) {
    if (res.error === 'hash_mismatch') {
      S.matches = false;
      setHashMsg('哈希与房间不一致：' + shortHash(res.expected && res.expected.hash), 'bad');
    } else {
      setHashMsg(res.message || '加入失败', 'bad');
    }
  }
  render();
}

function useManualHash() {
  const raw = $('manualInput').value.trim();
  if (!raw) { msgBox('manualMsg', '先粘贴哈希或 sync_video_player hash --json 的输出', 'bad'); return; }

  let hash = null, size = null, name = null, mode = 'manual';
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      hash = j.hash;
      size = j.size;
      name = j.name;
      mode = j.mode || 'manual';
    } catch (e) {
      msgBox('manualMsg', 'JSON 解析失败: ' + e.message, 'bad');
      return;
    }
  } else {
    const m = raw.match(/[0-9a-fA-F]{64}/);
    if (m) hash = m[0];
  }
  if (!hash || hash.length !== 64) {
    msgBox('manualMsg', '没找到 64 位十六进制 SHA-256', 'bad');
    return;
  }
  S.localHash = hash.toLowerCase();
  S.localSize = size || (S.file ? S.file.size : 0);
  S.localMode = mode;
  S.localName = name || (S.file ? S.file.name : '手动');
  msgBox('manualMsg', '已记录哈希，注意：手动模式不做字节校验', '');
  setMedia();
}

async function hashByPath() {
  const path = $('pathInput').value.trim();
  if (!path) { msgBox('pathMsg', '请输入服务器上的文件路径', 'bad'); return; }
  if (!S.file) { msgBox('pathMsg', '请先在上方选中同一个文件（用于本地播放）', 'bad'); return; }
  msgBox('pathMsg', '正在由 Rust 直接读取磁盘计算…', '');
  const res = await postJSON('/api/hash/path', {
    path,
    room: S.room,
    size: S.file.size,
    last_modified_ms: S.file.lastModified,
  });
  if (!res.ok) { msgBox('pathMsg', res.message || '失败', 'bad'); return; }
  S.localHash = res.hash;
  S.localSize = res.size;
  S.localMode = 'full';
  S.localName = S.file.name;
  msgBox('pathMsg', 'SHA-256 ' + res.hash.slice(0, 20) + '…', 'ok');
  await setMedia();
}

function msgBox(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* ----------------------------------------------------------- 文件与播放 */

function pickFile(file) {
  if (!file) return;
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.file = file;
  S.fileUrl = URL.createObjectURL(file);
  S.localHash = null;
  S.localSize = null;
  S.localMode = null;
  S.localName = file.name;
  S.localDurationMs = null;
  S.matches = null;
  video.src = S.fileUrl;
  video.load();
  setHashMsg('已选择：' + file.name, '');
  msgBox('manualMsg', '', '');
  render();
}

/* -------------------------------------------------------------- 渲染 */

function renderConnection() {
  const pill = $('connPill');
  pill.dataset.state = S.connected ? 'on' : 'off';
  pill.textContent = S.connected ? '已连接' : '连接中…';
}

function renderFileInfo() {
  $('fileLine').textContent = S.file ? S.file.name : '未选择';
  $('fileSize').textContent = S.file ? fmtBytes(S.file.size) : '—';
  $('fileDur').textContent = S.localDurationMs ? fmtTime(S.localDurationMs) : '—';
}

function renderRoom() {
  const st = S.state;
  $('roomCode').textContent = S.room;
  const m = st && st.media;
  $('roomMediaName').textContent = m ? m.name : '—';
  $('roomMediaSize').textContent = m ? fmtBytes(m.size) : '—';
  $('roomMediaHash').textContent = m ? shortHash(m.hash) : '—';
  $('roomMediaMode').textContent = m ? ({
    full: '完整 SHA-256', sample: '抽样指纹', manual: '手动填入',
  }[m.mode] || m.mode) : '—';
  if (!m) {
    $('roomMediaState').textContent = '等待第一个用户提供文件';
  } else if (st.paused_by_wait) {
    $('roomMediaState').textContent = '等待缓冲：' + (st.waiting_for || []).join('、');
  } else {
    $('roomMediaState').textContent = (st.playing ? '播放中' : '已暂停') +
      ' @ ' + fmtTime(st.pos_ms);
  }
  if (st && document.activeElement !== $('waitBuf')) $('waitBuf').checked = !!st.wait_for_buffer;
}

function renderClients() {
  const st = S.state;
  const ul = $('clients');
  if (!st) { ul.innerHTML = '<li>等待状态…</li>'; return; }
  const list = (st.clients || []).map((c) => {
    const tags = [];
    if (c.id === S.client) tags.push('<span class="tag me">你</span>');
    if (c.owner) tags.push('<span class="tag">房主</span>');
    if (c.matches === true) tags.push('<span class="tag ok">哈希一致</span>');
    else if (c.matches === false) tags.push('<span class="tag bad">哈希不一致</span>');
    else tags.push('<span class="tag">未校验</span>');
    if (c.buffering) tags.push('<span class="tag warn">缓冲中</span>');
    if (!c.online) tags.push('<span class="tag warn">离线</span>');
    return '<li><span class="who">' + esc(c.name || '匿名') + '</span>' + tags.join('') + '</li>';
  });
  ul.innerHTML = list.length ? list.join('') : '<li>暂无参与者</li>';
}

function renderGate() {
  const gate = $('gateOverlay');
  const title = $('gateTitle');
  const text = $('gateText');
  const hashes = $('gateHashes');
  const actions = $('gateActions');
  const st = S.state;
  const rm = st && st.media;

  // 遮罩开着的时候（还在选文件）别让控制条压在它上面
  const open = !(S.file && S.matches === true && rm);
  gate.classList.toggle('hidden', !open);
  const stage = stageEl();
  if (stage) stage.classList.toggle('ctl-blocked', open);
  if (!open) return;
  actions.innerHTML = '';

  if (!S.file) {
    title.textContent = '先选择你的本地视频文件';
    text.textContent = '视频永远不会上传或下载；网络里只有哈希与控制信息。';
    hashes.innerHTML = rm
      ? '房间当前的媒体：<b>' + esc(rm.name) + '</b> · ' + fmtBytes(rm.size) +
        '<br>期望 SHA-256 ' + shortHash(rm.hash)
      : '房间还没有媒体，你的文件会成为基准。';
    return;
  }

  if (!rm) {
    title.textContent = '正在把你的文件设为房间媒体';
    text.textContent = '房间还没有媒体。计算出哈希后，其他人只要文件一致就能加入。';
    hashes.innerHTML = '本机文件：<b>' + esc(S.file.name) + '</b> · ' + fmtBytes(S.file.size);
    return;
  }

  if (S.matches === false) {
    title.textContent = '⚠ 哈希不匹配：不是同一个文件';
    text.textContent = '同步已阻止。请换成与房间一致的文件，或由你重新定义房间媒体。';
    hashes.innerHTML =
      '房间期望 <span class="ok">' + shortHash(rm.hash) + '</span> · ' + fmtBytes(rm.size) + ' · ' + esc(rm.name) +
      '<br>你的文件 <span class="bad">' + shortHash(S.localHash) + '</span> · ' + fmtBytes(S.localSize) + ' · ' + esc(S.file.name);
    actions.innerHTML =
      '<button data-action="reset" class="danger" style="width:auto">以我的文件为准（重置房间）</button>' +
      '<button data-action="pick">重新选择文件</button>';
    return;
  }

  title.textContent = '还没校验本机文件的哈希';
  text.textContent = '点右侧「在本机计算并加入房间」，Rust(WASM) 会在你这台机器上读取文件算 SHA-256，字节不出本机。';
  hashes.innerHTML =
    '房间期望 <span class="ok">' + shortHash(rm.hash) + '</span> · ' + fmtBytes(rm.size) + ' · ' + esc(rm.name) +
    '<br>本机文件 ' + esc(S.file.name) + ' · ' + fmtBytes(S.file.size) + '（尚未计算）';
}

function renderPlayerInfo() {
  const st = S.state;
  const cur = video.currentTime * 1000;
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : (S.localDurationMs || 0);
  $('timeLabel').textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
  if (!S.scrubbing && dur > 0) $('seek').value = String(Math.round((cur / dur) * 1000));
  $('offsetVal').textContent = S.rttMin === Infinity ? '—' : ('±' + Math.round(S.rttMin / 2) + 'ms');
  $('driftVal').textContent = S.drift === null ? '—' : (S.drift > 0 ? '+' : '') + Math.round(S.drift) + 'ms';
  if (st) {
    $('playBtn').disabled = !!st.playing;
    $('pauseBtn').disabled = !st.playing;
  }
}

function render() {
  renderConnection();
  renderFileInfo();
  renderRoom();
  renderClients();
  renderGate();
  renderPlayerInfo();
  renderFullscreenBtn();
  applyBarMode();
}

/* ------------------------------------------- 控制条的浮现 / 淡出 / 全屏 */

// 控制条贴着画面底部浮在上面，不占画面位置：鼠标不动一会儿就淡出（连指针一起隐藏），
// 动一下鼠标、碰一下屏幕或按一下键再浮回来；暂停时一直留着，方便点播放、拖进度。
const CTRL_IDLE_MS = 2600;

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function stageEl() {
  return document.querySelector('.stage');
}

// 亮出控制条并停住计时器（鼠标正停在控制条上、刚进全屏、或者刚恢复播放）
function holdControls() {
  clearTimeout(S.ctlIdleTimer);
  const stage = stageEl();
  if (stage) stage.classList.remove('ctl-idle');
  updateBarState();
}

// 有动静（移动鼠标 / 触摸 / 按键）就浮现控制条，然后重新开始倒计时
function pokeControls() {
  holdControls();
  S.ctlIdleTimer = setTimeout(hideControls, CTRL_IDLE_MS);
}

function hideControls() {
  const stage = stageEl();
  if (!stage) return;
  // 暂停时一直留着：这时候本来就要能点播放、拖进度
  if (video.paused) return;
  // 快捷键提示面板开着时也别藏（面板是 .stage 的子节点，藏了连指针一起消失）
  if (S.keysOpen) return;
  // 正在拖进度条就别淡出，松开手再数 2.6 秒
  if (S.scrubbing) { S.ctlIdleTimer = setTimeout(hideControls, 500); return; }
  stage.classList.add('ctl-idle');
  updateBarState();
}

// 只要有指针动静就浮现：不判断坐标、不看事件目标。
// （视频会自成合成层，事件目标不可靠；漏判一次的表现就是「鼠标晃了但控制条不出现」，
//   宁可鼠标在侧栏上晃也把控制条亮出来，也不能漏。）
function onPointerActivity() {
  pokeControls();
}

// 顶栏那枚状态胶囊：随时告诉用户控制条现在到底是显示还是藏着，
// 不用打开诊断面板也能一眼看出问题出在「没浮现」还是「画不出来」。
function updateBarState() {
  const pill = $('barStatePill');
  const stage = stageEl();
  if (!pill || !stage) return;
  const hidden = stage.classList.contains('ctl-idle');
  const text = hidden
    ? (S.barMode === 'float' ? '控制条 已隐藏' : '控制条 已收起')
    : '控制条 显示中';
  if (pill.textContent !== text) pill.textContent = text;
  pill.dataset.state = hidden ? 'off' : 'on';
}

// 控制条显示方式：slide = 贴着画面下方滑出（默认）；float = 叠在画面底部（bilibili 那种）
function applyBarMode() {
  const stage = stageEl();
  if (stage) stage.classList.toggle('ctl-float', S.barMode === 'float');
  const btn = $('barModeBtn');
  if (btn) {
    btn.textContent = S.barMode === 'float' ? '控制条：浮层' : '控制条：滑出';
    btn.title = S.barMode === 'float'
      ? '当前：控制条叠在画面底部（bilibili 那种）；如果看不到它，点一下换回「滑出」'
      : '当前：控制条从画面下方滑出，不叠在画面上（最保险）；点一下改成浮层';
  }
  updateBarState();
}

function toggleFullscreen() {
  const stage = stageEl();
  if (!stage) return;
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;   // 老 Safari 只有带前缀的
    if (exit) exit.call(document);
    return;
  }
  const enter = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (enter) enter.call(stage);
}

function renderFullscreenBtn() {
  const btn = $('fsBtn');
  const on = !!fullscreenElement();
  btn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
  btn.title = on ? '退出全屏（Esc）' : '全屏（进度、倍速、音量浮在画面上）';
}

function onFullscreenChange() {
  const stage = stageEl();
  const on = !!fullscreenElement();
  // 全屏布局靠这个类，而不是 :fullscreen 伪类（原因见 app.css 里的说明）
  if (stage) stage.classList.toggle('is-fs', on);
  renderFullscreenBtn();
  pokeControls();   // 刚切完全屏先把控制条亮出来
}

/* --------------------------------------------------------- 键盘快捷键 */
/* Q 面板 / F 全屏 / M 静音 / W S ↑ ↓ 音量 / A D ← → 跳转 5 秒 / 按住 D → 2 倍速快进。
 * 输入框、下拉框、滑块里都不抢键：那些控件里的方向键有原生含义（移动光标、换选项、拖滑块）。 */

const SEEK_STEP_MS = 5000;     // A/D 或 ←/→ 一次移动的时长
const VOL_STEP = 10;           // 音量常规档位：10%
const VOL_FINE_STEP = 2;       // 音量 ≤10% 时改用 2% 细调
const VOL_FINE_MAX = 10;
const HOLD_SCAN_MS = 200;      // 按住超过 0.2 秒才算长按（不到就是单击：跳 5 秒）
const HOLD_SCAN_RATE = 2;      // 长按时的临时倍速（只在本机，不写进协议）

// 正在打字/拖滑块时不吃快捷键：那些控件里的字母、方向键有原生含义（移动光标、换选项、调值）。
// 复选框和按钮里只有空格/回车有意义，字母与方向键照常走快捷键——不然点完「静音」，
// 焦点留在复选框上，音量键会突然失灵。
function typingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = String(t.tagName).toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = String(t.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return t.isContentEditable === true;
}

// 倍速下拉框反映房间当前的倍速：别人改了倍速、或正按住 D/→ 快进时，框里跟着一起走。
// 倍速不在选项里时（协议允许 0.25~4，别处可能设成 3 倍）保持原样，免得变成一个空框。
function syncRateSelect(rate) {
  const sel = $('rateSel');
  if (!sel || !sel.options) return;
  const want = String(rate);
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === want) { sel.value = want; return; }
  }
}

// 房间倍速（协议字段 rate）；还没进房间就按 1 倍算
function roomRate() {
  return S.state ? S.state.rate : 1;
}

// 本机实际倍速 = 房间倍速；按住 D/→ 期间临时用 2 倍，松手回到房间倍速
function applyLocalRate() {
  video.playbackRate = S.holdRate || roomRate();
}

// 跳转会同步给房间里所有人，所以只在"本机文件已经对上房间"时才响应：
// 条件跟控制条出现的条件一致，免得哈希还对不上的人用键盘把全场带跑。
function canControlRoom() {
  return !!(S.file && S.state && S.state.media && S.matches === true);
}

// 音量档位：常规 10% 一档；音量 ≤10% 时用 2% 细调，从 10% 再往上接回 10% 那一档。
function nextVolume(cur, dir) {
  if (cur <= VOL_FINE_MAX) {
    const fine = cur + dir * VOL_FINE_STEP;
    return dir > 0 && fine > VOL_FINE_MAX ? VOL_FINE_MAX + VOL_STEP : fine;
  }
  return cur + dir * VOL_STEP;
}

// 音量只在本机生效（协议里没有这个字段），顺手把控制条上的音量条拨到同一格
function bumpVolume(dir) {
  const next = Math.max(0, Math.min(100, nextVolume(Math.round(video.volume * 100), dir)));
  video.volume = next / 100;
  $('vol').value = String(next);
  return next;
}

// 静音同样只在本机生效；顶栏那枚复选框跟着一起翻，两边不会各说各话
function toggleMute() {
  video.muted = !video.muted;
  $('muteChk').checked = video.muted;
  return video.muted;
}

// 跳转是控制信息：跟拖进度条一样操作房间（所有人一起跳）。本机先跳一下立刻响应，不等回声。
function seekBy(ms) {
  if (!canControlRoom()) return;
  const target = clampPosition(video.currentTime * 1000 + ms);
  hardSeek(target);
  op('seek', { value: Math.round(target) });
}

// 按住 D/→：先等 0.2 秒。不到就是单击（松手时前进 5 秒）；超过就进 2 倍速快进，
// 松手恢复原来的倍速。快进属于控制信息，跟播放/暂停一样发给房间——房间里所有人一起快进。
function startHoldScan(key) {
  if (S.holdKey || !canControlRoom()) return;
  S.holdKey = key;
  S.holdTimer = setTimeout(enterHoldScan, HOLD_SCAN_MS);
}

// 长按过线：本机先立刻 2 倍速（不等服务端回声），再把倍速发给房间
function enterHoldScan() {
  S.holdTimer = 0;
  S.holdBaseRate = roomRate();     // 松手要还回去的那个值
  S.holdRate = HOLD_SCAN_RATE;
  applyLocalRate();
  op('rate', { value: HOLD_SCAN_RATE });
}

// 结束长按（松手 / 失焦 / 关页面）：把临时倍速收回去。
// 本机立刻恢复，房间那边也发一次——不然全场会一直停在 2 倍速。
function stopHoldScan() {
  clearTimeout(S.holdTimer);
  S.holdTimer = 0;
  S.holdKey = null;
  if (!S.holdRate) return false;
  S.holdRate = 0;
  const rate = S.holdBaseRate || 1;
  video.playbackRate = rate;
  op('rate', { value: rate });
  return true;
}

function endHoldScan(key) {
  if (S.holdKey !== key) return;   // 不是我们记下的那一次按键（比如在输入框里按的 D）
  if (!S.holdRate) {               // 没到 0.2 秒：算单击，前进 5 秒
    clearTimeout(S.holdTimer);
    S.holdTimer = 0;
    S.holdKey = null;
    seekBy(SEEK_STEP_MS);
    return;
  }
  stopHoldScan();                  // 长按结束：把倍速还回房间
}

// 页面要关了还按着快进：unload 阶段 fetch 会被浏览器掐掉，用 sendBeacon 再兜一次，
// 否则房间里所有人得一直 2 倍速跑下去
function onPageUnload() {
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  if (!S.holdRate) return;
  const rate = S.holdBaseRate || 1;
  stopHoldScan();
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/control', JSON.stringify({
      room: S.room, client: S.client, name: S.name, op: 'rate', value: rate,
    }));
  }
}

// 认这几个键，返回规范化后的小写名字；其它键返回 null，原样交给浏览器
function shortcutKey(e) {
  const k = e && e.key ? String(e.key).toLowerCase() : '';
  if (k === 'q' || k === 'f' || k === 'm' || k === 'w' || k === 's' || k === 'a' || k === 'd' || k === 'escape') return k;
  if (k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') return k;
  return null;
}

function onShortcutDown(e) {
  if (typingTarget(e.target)) return;
  const k = shortcutKey(e);
  if (!k) return;
  // Esc 不拦：全屏时浏览器还要用它退出全屏，我们只顺手把提示面板关掉
  if (k === 'escape') { toggleKeysPanel(false); return; }
  if (e.preventDefault) e.preventDefault();   // 方向键别去滚页面、别去动焦点上的滑块
  if (e.repeat) return;                       // 长按产生的自动重复不算新的一次按键
  if (k === 'q') { toggleKeysPanel(); return; }
  if (k === 'f') { toggleFullscreen(); return; }
  if (k === 'm') { toggleMute(); return; }
  if (k === 'w' || k === 'arrowup') { bumpVolume(1); return; }
  if (k === 's' || k === 'arrowdown') { bumpVolume(-1); return; }
  if (k === 'a' || k === 'arrowleft') { seekBy(-SEEK_STEP_MS); return; }
  if (k === 'd' || k === 'arrowright') startHoldScan(k);
}

function onShortcutUp(e) {
  const k = shortcutKey(e);
  if (k === 'd' || k === 'arrowright') endHoldScan(k);
}

/* 快捷键提示面板（Q 或顶栏「⌨ 快捷键」开关）。它在 DOM 里是 .stage 的子节点，
 * 所以全屏时也跟着进全屏——否则全屏下按 Q 会什么都看不到。 */
function toggleKeysPanel(show) {
  const open = show === undefined ? !S.keysOpen : !!show;
  S.keysOpen = open;
  const el = $('keysOverlay');
  if (el) el.classList.toggle('hidden', !open);
  pokeControls();
}

/* -------------------------------------------------------------- 事件绑定 */

function bind() {
  $('fileInput').addEventListener('change', (e) => pickFile(e.target.files[0]));

  const drop = $('dropZone');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); drop.style.borderColor = '#4c8dff';
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); drop.style.borderColor = '';
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickFile(f);
  });

  $('gateActions').addEventListener('click', async (e) => {
    const act = e.target && e.target.dataset ? e.target.dataset.action : null;
    if (act === 'pick') $('fileInput').click();
    if (act === 'reset') {
      if (!confirm('重置房间媒体？所有人的同步会被清空，然后以你的文件为准。')) return;
      await op('reset_media');
      S.matches = null;
      await setMedia();
    }
  });

  $('playBtn').addEventListener('click', async () => {
    await op('play');
    await playLocal();
  });
  $('pauseBtn').addEventListener('click', () => op('pause'));
  $('startBtn').addEventListener('click', () => op('seek', { value: 0 }));
  $('syncBtn').addEventListener('click', () => {
    const st = S.state;
    if (!st) return;
    hardSeek(targetPos(st));
  });
  $('seek').addEventListener('input', () => { S.scrubbing = true; });
  $('seek').addEventListener('change', () => {
    S.scrubbing = false;
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const ms = (Number($('seek').value) / 1000) * dur * 1000;
    op('seek', { value: Math.round(ms) });
  });
  $('rateSel').addEventListener('change', () => op('rate', { value: Number($('rateSel').value) }));
  $('fsBtn').addEventListener('click', toggleFullscreen);
  // 按 Esc 或浏览器自己的手势退出全屏时，按钮文案和全屏布局都要跟着恢复
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) =>
    document.addEventListener(ev, onFullscreenChange));
  // 浮现控制条：在 window 上用捕获阶段接指针事件，再按坐标判断是不是在画面上。
  // 这样不依赖事件目标，视频/合成层怎么折腾都能收到。
  ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'wheel', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, onPointerActivity, { capture: true, passive: true }));
  const stack = document.querySelector('.ctl-stack');
  if (stack) {
    stack.addEventListener('mouseenter', holdControls);   // 鼠标停在控制条上不淡出
    stack.addEventListener('mouseleave', pokeControls);
  }
  document.addEventListener('keydown', pokeControls, { passive: true });
  // 快捷键统一在窗口捕获阶段处理（输入框/滑块里的按键由 typingTarget() 放行）
  window.addEventListener('keydown', onShortcutDown, { capture: true });
  window.addEventListener('keyup', onShortcutUp, { capture: true });
  // 按住时窗口失焦（切标签、Alt+Tab）收不到 keyup，兜底把倍速还回房间
  window.addEventListener('blur', stopHoldScan);
  $('helpBtn').addEventListener('click', () => toggleKeysPanel());
  $('keysCloseBtn').addEventListener('click', () => toggleKeysPanel(false));
  $('keysOverlay').addEventListener('click', (e) => {
    if (e.target === $('keysOverlay')) toggleKeysPanel(false);   // 点面板外那层暗背景也关掉
  });
  video.addEventListener('play', pokeControls);   // 暂停时留着控制条，恢复播放后重新计时

  // 控制条显示方式：浮层 <-> 停靠常显（后者是浮层画不出来时的兜底），选择记在 localStorage
  $('barModeBtn').addEventListener('click', () => {
    S.barMode = S.barMode === 'float' ? 'slide' : 'float';
    try { localStorage.setItem('sync_video_player.bar_mode', S.barMode); } catch (_) {}
    applyBarMode();
    pokeControls();
  });
  $('diagBtn').addEventListener('click', () => {
    if (S.debugBox) S.debugBox.hidden = !S.debugBox.hidden;
  });
  applyBarMode();   // 启动时就把按钮文案/模式类摆正
  $('gestureBtn').addEventListener('click', async () => {
    await playLocal();
    const st = S.state;
    if (st && !st.playing) await op('play');
  });

  $('vol').addEventListener('input', () => { video.volume = Number($('vol').value) / 100; });
  $('muteChk').addEventListener('change', () => { video.muted = $('muteChk').checked; });
  $('autoTrimChk').addEventListener('change', () => {
    S.autoTrim = $('autoTrimChk').checked;
    // 关掉时立刻恢复房间倍速，避免停在 0.96×/1.04×
    if (!S.autoTrim) applyLocalRate();
  });

  $('hashBtn').addEventListener('click', startHash);
  $('hashCancelBtn').addEventListener('click', async () => {
    S.hashCancel = true;
    setHashMsg('正在取消…', '');
  });
  $('manualBtn').addEventListener('click', useManualHash);
  $('pathBtn').addEventListener('click', hashByPath);

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('pane-local').classList.toggle('hidden', t.dataset.tab !== 'local');
    $('pane-manual').classList.toggle('hidden', t.dataset.tab !== 'manual');
  }));

  $('waitBuf').addEventListener('change', () => op('set_options', { wait_for_buffer: $('waitBuf').checked }));
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('重置房间媒体？所有人需要重新校验文件。')) return;
    await op('reset_media');
    S.matches = null;
    render();
  });
  $('copyLinkBtn').addEventListener('click', async () => {
    const url = location.origin + '/?room=' + encodeURIComponent(S.room);
    try {
      await navigator.clipboard.writeText(url);
      $('copyLinkBtn').textContent = '已复制 ✔';
    } catch (_) {
      window.prompt('复制这个链接分享给其他人：', url);
    }
    setTimeout(() => { $('copyLinkBtn').textContent = '复制邀请链接'; }, 1800);
  });

  video.addEventListener('loadedmetadata', () => {
    S.localDurationMs = isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
    renderFileInfo();
    if (S.localHash) setMedia();
    if (S.state) applyControlState(S.state);   // 元数据就绪后按当前控制信息对齐一次
    render();
  });
  video.addEventListener('error', () => {
    setHashMsg('浏览器无法解码这个文件（常见于 MKV/H.265/AC3）。文件本身没问题，只是浏览器不支持该编码。', 'bad');
  });
  video.addEventListener('click', async () => {
    const st = S.state;
    if (!st || !st.media || S.matches !== true) return;
    if (st.playing) await op('pause'); else { await op('play'); await playLocal(); }
  });

  window.addEventListener('beforeunload', onPageUnload);
}

/* ---------------------------------------------------------------- 启动 */

/* ------------------------------------------------------------ 调试面板 */

// 右下角的诊断面板：显示「控制条为什么看不见」需要的那几个量。
// 默认隐藏，点顶栏「诊断」或加 ?debug=1 打开。
function initDebugPanel() {
  const box = document.createElement('pre');
  box.id = 'debugBox';
  box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;max-width:52ch;margin:0;' +
    'padding:8px 10px;background:rgba(6,8,12,.88);color:#9fe1ff;border:1px solid #2b3a4a;' +
    'border-radius:8px;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none';
  box.hidden = params.get('debug') !== '1';
  document.body.appendChild(box);
  S.debugBox = box;

  let pointerEvents = 0;
  window.addEventListener('pointermove', () => { pointerEvents++; }, { capture: true, passive: true });

  setInterval(() => {
    if (box.hidden) return;
    const stage = stageEl();
    const stack = document.querySelector('.ctl-stack');
    const wrap = document.querySelector('.video-wrap');
    const cs = stack ? getComputedStyle(stack) : null;
    const wr = wrap ? wrap.getBoundingClientRect() : null;
    const sr = stack ? stack.getBoundingClientRect() : null;
    const fs = fullscreenElement();
    const rect = (r) => (r ? Math.round(r.top) + '~' + Math.round(r.bottom) : '—');
    // 命中测试：控制条中心点最上层是哪个元素。它是 video 就说明浮层被压在下面了。
    let hit = '—';
    if (sr && sr.width > 0 && typeof document.elementFromPoint === 'function') {
      const el = document.elementFromPoint(Math.round((sr.left + sr.right) / 2), Math.round((sr.top + sr.bottom) / 2));
      hit = !el ? '（无）' : el.id ? '#' + el.id
        : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
    }
    box.textContent = [
      'UI ' + UI_REV + '　（这一行告诉你浏览器跑的是哪一版界面）',
      '控制条模式 ' + S.barMode + '　（浮层画不出来时点顶栏「控制条」切到停靠）',
      '指针事件 ' + pointerEvents + ' 次　视口 ' + window.innerWidth + '×' + window.innerHeight,
      '全屏元素 ' + (fs ? (fs.className || fs.tagName) : '（无）'),
      'stage class = "' + (stage ? stage.className : '?') + '"',
      '控制条 opacity=' + (cs ? cs.opacity : '—') + ' visibility=' + (cs ? cs.visibility : '—') +
        ' pointer-events=' + (cs ? cs.pointerEvents : '—'),
      '控制条 y ' + rect(sr) + '　画面 y ' + rect(wr) + '　（数值应落在画面里）',
      '控制条中心命中 ' + hit + '　（是 video 就说明浮层被压在视频下面了）',
      'video paused=' + video.paused + ' readyState=' + video.readyState,
    ].join('\n');
  }, 500);
}

function boot() {
  bind();
  initDebugPanel();
  video.volume = 1;
  render();
  syncClock().then(connectStream);
  setInterval(heartbeat, 3000);
  setInterval(tickLocal, 250);
  setInterval(updateBarState, 1000);   // 兜底：状态胶囊始终反映实际状态
  setInterval(() => { syncClock(); }, 30000);
  fetch('/api/state?room=' + encodeURIComponent(S.room) + '&client=' + S.client + '&name=' + encodeURIComponent(S.name))
    .then((r) => r.json()).then(onState).catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
