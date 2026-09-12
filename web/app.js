'use strict';

/* rtest 前端：本地文件播放 + 控制信息同步
 *
 * 关键点：
 *  - 视频永远是本机 blob: 播放，服务器不保存也不转发任何视频字节。
 *  - 哈希由 Rust 编译出的 WebAssembly 在本机计算，文件字节不经过网络。
 *  - 同步的只有：哈希/大小/时长、播放开关、基准时间戳、位置、倍速。
 *  - 音量、静音只在本机生效，协议里没有这些字段。
 */

const $ = (id) => document.getElementById(id);
const video = $('video');

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
  client: localStorage.getItem('rtest.client') || (() => {
    const v = randomHex(8);
    localStorage.setItem('rtest.client', v);
    return v;
  })(),
  name: localStorage.getItem('rtest.name') || ('用户' + Math.floor(Math.random() * 900 + 100)),
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

function hardSeek(ms) {
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : null;
  let target = Math.max(0, ms);
  if (dur) target = Math.min(target, Math.max(0, dur - 40));
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

  // 倍速属于控制信息，按新的控制信息设置
  v.playbackRate = st.rate;
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
  if (S.autoTrim && active) {
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
  const resp = await fetch('/rtest_hash.wasm');
  if (!resp.ok) throw new Error('无法获取本地哈希模块（HTTP ' + resp.status + '）');
  let mod;
  try {
    mod = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
  } catch (e) {
    throw new Error('哈希模块无法加载：' + e.message);
  }
  const ex = mod.instance.exports;
  const abi = ex.rtest_version();
  if (abi !== WASM_ABI) {
    throw new Error('哈希模块版本不匹配（期望 ' + WASM_ABI + '，实际 ' + abi + '），请重新构建');
  }
  S.wasm = ex;
  S.stagePtr = ex.rtest_alloc(STAGE_BYTES);
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
    ex.rtest_update(S.stagePtr, bytes.length);
    onBytes(bytes.length);
  }
}

function readSamplePlan(ex) {
  const n = ex.rtest_sample_count();
  const plan = [];
  for (let i = 0; i < n; i++) {
    const p = ex.rtest_sample_at(i);
    const dv = new DataView(ex.memory.buffer, p, 16);
    plan.push({
      offset: Number(dv.getBigUint64(0, true)),
      len: Number(dv.getBigUint64(8, true)),
    });
  }
  return plan;
}

function digestHex(ex) {
  const p = ex.rtest_finish();
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
      ex.rtest_begin_sample(BigInt(f.size));
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
      ex.rtest_begin_full();
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
  if (!raw) { msgBox('manualMsg', '先粘贴哈希或 rtest hash --json 的输出', 'bad'); return; }

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

  if (S.file && S.matches === true && rm) {
    gate.classList.add('hidden');
    return;
  }
  gate.classList.remove('hidden');
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
  $('fsBtn').addEventListener('click', () => {
    const wrap = document.querySelector('.video-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
  });
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
    if (!S.autoTrim && S.state) video.playbackRate = S.state.rate;
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

  window.addEventListener('beforeunload', () => { if (S.fileUrl) URL.revokeObjectURL(S.fileUrl); });
}

/* ---------------------------------------------------------------- 启动 */

function boot() {
  bind();
  video.volume = 1;
  render();
  syncClock().then(connectStream);
  setInterval(heartbeat, 3000);
  setInterval(tickLocal, 250);
  setInterval(() => { syncClock(); }, 30000);
  fetch('/api/state?room=' + encodeURIComponent(S.room) + '&client=' + S.client + '&name=' + encodeURIComponent(S.name))
    .then((r) => r.json()).then(onState).catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
