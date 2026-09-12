// 键盘快捷键：用最小 DOM 桩加载真实交付的 web/app.js，断言
//   1) Q 开关快捷键提示面板（顶栏按钮、关闭按钮、点暗背景、Esc 都能关），面板开着时控制条不淡出
//   2) F 全屏 / 退出全屏（全屏的是 .stage）
//   3) W/S/↑/↓ 音量 ±10%，音量 ≤10% 时改成 ±2%，且只在本机（不发请求）
//   4) A/D/←/→ 后退/前进 5 秒，并跟拖进度条一样把 seek 发给房间
//   5) 按住 D/→：不到 0.2 秒算单击（+5 秒）；超过 0.2 秒进 2 倍速、松开回房间倍速，全程不发请求
//   6) 输入框/滑块里不吃快捷键、复选框与按钮上照常生效；长按的自动重复不算新的一次按键
// 时间用假定时器推进，不真的等 0.2 秒；跑的是交付给浏览器的那份文件。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  [PASS] ${m}`); pass++; };
const bad = (m) => { console.log(`  [FAIL] ${m}`); fail++; };
const check = (c, m) => (c ? ok(m) : bad(m));

/* ------------------------------------------------------- 假定时器 */
// 「按住 0.2 秒才算长按」「控制条 2.6 秒淡出」都靠它推进，不真等。
let now = 0;
let seq = 0;
const timers = new Map();
const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (Number(ms) || 0) }); return id; };
const fakeClearTimeout = (id) => { timers.delete(id); };
function advance(ms) {
  const until = now + ms;
  for (;;) {
    let nextId = null;
    let nextAt = Infinity;
    for (const [id, t] of timers) if (t.at <= until && t.at < nextAt) { nextId = id; nextAt = t.at; }
    if (nextId === null) break;
    const t = timers.get(nextId);
    timers.delete(nextId);
    now = t.at;
    t.fn();
  }
  now = until;
}

/* ------------------------------------------------------- DOM 桩 */
function makeEl(id) {
  const classes = new Set();
  const handlers = new Map();
  return {
    id,
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    style: {},
    dataset: {},
    value: '0',
    checked: true,
    textContent: '',
    innerHTML: '',
    disabled: false,
    addEventListener(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    fire(ev) { (handlers.get(ev) || []).forEach((fn) => fn({ type: ev, target: this })); },
  };
}

const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

let currentTime = 0;
let playbackRate = 1;
const video = getEl('video');
video.readyState = 4;
video.duration = 3600;      // 1 小时，够长，测不到结尾
video.paused = false;
video.volume = 1;
video.muted = false;
video.play = async () => {};
video.pause = () => {};
Object.defineProperty(video, 'currentTime', {
  get: () => currentTime,
  set: (v) => { currentTime = v; },
});
Object.defineProperty(video, 'playbackRate', {
  get: () => playbackRate,
  set: (v) => { playbackRate = v; },
});

const stage = getEl('stage');
const keysOverlay = getEl('keysOverlay');

let fullscreenEl = null;
let requestedOn = null;
const docHandlers = new Map();
const fireDoc = (ev) => (docHandlers.get(ev) || []).forEach((fn) => fn({ type: ev }));
const winHandlers = new Map();
let prevented = 0;
const fireWin = (ev, props) => (winHandlers.get(ev) || []).forEach((fn) =>
  fn(Object.assign({ type: ev, preventDefault: () => { prevented++; } }, props)));
const keyDown = (key, extra) => fireWin('keydown', Object.assign({ key, repeat: false, target: null }, extra || {}));
const keyUp = (key, extra) => fireWin('keyup', Object.assign({ key, target: null }, extra || {}));

stage.requestFullscreen = function () {
  requestedOn = this;
  fullscreenEl = stage;
  fireDoc('fullscreenchange');
  return Promise.resolve();
};

const document = {
  getElementById: getEl,
  querySelector: (sel) => (sel === '.stage' ? stage : null),
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => {
    if (!docHandlers.has(ev)) docHandlers.set(ev, []);
    docHandlers.get(ev).push(fn);
  },
  get fullscreenElement() { return fullscreenEl; },
  activeElement: null,
  exitFullscreen() { fullscreenEl = null; fireDoc('fullscreenchange'); return Promise.resolve(); },
};

// 记下每一个 POST：跳转必须发给房间（跟拖进度条一条路），音量与长按快进一个请求都不该发。
const posts = [];
const sandbox = {
  document,
  window: {
    addEventListener: (ev, fn) => {
      if (!winHandlers.has(ev)) winHandlers.set(ev, []);
      winHandlers.get(ev).push(fn);
    },
    prompt: () => {},
  },
  location: { search: '?room=test', origin: 'http://127.0.0.1:8080' },
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, v); },
  },
  crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; } },
  fetch: async (url, init) => {
    if (init && init.method === 'POST') posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, srv_ms: Date.now() }), text: async () => '{"ok":true}' };
  },
  EventSource: class { constructor() { this.readyState = 0; } close() {} },
  WebAssembly: {},
  navigator: {},
  console,
  performance,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  JSON, Math, Date, Number, String, Array, Object, Boolean, isFinite, parseInt, parseFloat,
  URLSearchParams, Map, Set, Promise,
};
sandbox.globalThis = sandbox;

const exposed = src + '\n;globalThis.__api = { S, bind, CTRL_IDLE_MS };\n';
vm.createContext(sandbox);
vm.runInContext(exposed, sandbox);
const { S, bind, CTRL_IDLE_MS } = sandbox.__api;

bind();   // 真实页面里由 DOMContentLoaded 触发

// 摆成「已经进房间、本机文件也对上了」：跳转和长按快进才有意义
const file = { name: 'movie.mkv', size: 1024 };
S.file = file;
S.state = { media: { hash: 'a'.repeat(64), size: 1024 }, rate: 1, playing: true };
S.matches = true;

const seeks = () => posts.filter((p) => p.body.op === 'seek');

/* ------------------------------------------------------- 场景 */
console.log('键盘快捷键检查：');

/* ---- Q：快捷键提示面板 ---- */
keyDown('q');
check(S.keysOpen, '按 Q 打开快捷键提示面板');
check(!keysOverlay.classes.has('hidden'), '面板元素去掉 .hidden（真的显示出来）');
keyDown('q');
check(!S.keysOpen && keysOverlay.classes.has('hidden'), '再按一次 Q 关掉面板');

getEl('helpBtn').fire('click');
check(S.keysOpen, '顶栏「⌨ 快捷键」按钮也能打开面板（不然没人知道有快捷键）');
getEl('keysCloseBtn').fire('click');
check(!S.keysOpen, '面板上的「关闭」按钮能关掉');
getEl('helpBtn').fire('click');
keysOverlay.fire('click');
check(!S.keysOpen, '点面板外那层暗背景也能关掉');
keyDown('q');
keyDown('Escape');
check(!S.keysOpen, 'Esc 也能关掉面板（全屏时浏览器还会自己退出全屏）');

// 面板是 .stage 的子节点，别让控制条倒计时把指针一起藏了
keyDown('q');
advance(CTRL_IDLE_MS * 3);
check(!stage.classes.has('ctl-idle'), '面板开着时控制条不淡出（否则连指针一起消失）');
keyDown('q');

/* ---- F：全屏 / 退出全屏 ---- */
keyDown('f');
check(requestedOn === stage, '按 F 全屏的是 .stage（画面、控制条、提示面板都在里面）');
check(stage.classes.has('is-fs'), '全屏后 .stage 带上 .is-fs（布局按全屏铺开）');
keyDown('f');
check(fullscreenEl === null, '再按 F 退出全屏');
check(!stage.classes.has('is-fs'), '退出全屏后摘掉 .is-fs');

/* ---- W/S/↑/↓：音量 ---- */
video.volume = 1;
keyDown('s');
check(Math.abs(video.volume - 0.9) < 1e-9, '按 S 音量降 10%（100% → 90%）');
check(getEl('vol').value === '90', '控制条上的音量条跟着走到 90（两边不会各说各话）');
keyDown('ArrowDown');
check(Math.abs(video.volume - 0.8) < 1e-9, '↓ 和 S 一样降 10%');
keyDown('w');
keyDown('ArrowUp');
check(Math.abs(video.volume - 1) < 1e-9, 'W / ↑ 各升 10%，回到 100%');
keyDown('w');
check(video.volume === 1, '音量到顶就停住（不会超过 100%）');

video.volume = 0.1;
keyDown('s');
check(Math.abs(video.volume - 0.08) < 1e-9, '音量 10% 时按 S 只降 2%（10% → 8%）');
keyDown('w');
check(Math.abs(video.volume - 0.1) < 1e-9, '再按 W 回到 10%');
keyDown('w');
check(Math.abs(video.volume - 0.2) < 1e-9, '10% 再往上接回 10% 的档位（10% → 20%）');
video.volume = 0;
keyDown('s');
check(video.volume === 0, '音量到 0 就停住（按 S 不会变成负数）');

const postsBeforeVolume = posts.length;
video.volume = 0.5;
keyDown('ArrowUp');
check(posts.length === postsBeforeVolume, '调音量一个请求都不发（协议里本来就没有音量字段）');

/* ---- A/D/←/→：±5 秒（跳转是控制信息，要发给房间）---- */
currentTime = 100;
posts.length = 0;
keyDown('a');
check(Math.abs(currentTime - 95) < 1e-6, '按 A 后退 5 秒（100s → 95s）');
check(seeks().some((p) => p.body.value === 95000), '后退也发给房间（跟拖进度条一条路，所有人一起跳）');
currentTime = 100;
keyDown('ArrowLeft');
check(Math.abs(currentTime - 95) < 1e-6, '← 和 A 一样后退 5 秒');

currentTime = 100;
posts.length = 0;
keyDown('ArrowRight');
check(Math.abs(currentTime - 100) < 1e-6, '按住 → 还不到 0.2 秒时先不跳（要等松手才知道是单击还是长按）');
keyUp('ArrowRight');
check(Math.abs(currentTime - 105) < 1e-6, '松手时前进 5 秒（100s → 105s）');
check(seeks().some((p) => p.body.value === 105000), '前进 5 秒同样发给房间');

currentTime = 100;
posts.length = 0;
keyDown('d');
advance(150);            // 短按：松手比 0.2 秒的判定还早
check(playbackRate === 1, '短按 D 不给倍速加速');
keyUp('d');
check(Math.abs(currentTime - 105) < 1e-6, '按一下 D（不到 0.2 秒）照样前进 5 秒');
check(seeks().length === 1, '一次按键只发一次跳转（自动重复不算新按键）');

prevented = 0;
keyDown('ArrowDown');
check(prevented === 1, '处理掉的键调用 preventDefault（方向键不会去滚页面）');

/* ---- 按住 D/→：2 倍速快进 ---- */
currentTime = 100;
posts.length = 0;
keyDown('d');
advance(199);
check(playbackRate === 1 && Math.abs(currentTime - 100) < 1e-6, '按住不到 0.2 秒时还是 1 倍速、也没跳走');
advance(2);              // 累计 201ms，过线
check(playbackRate === 2, '按住超过 0.2 秒进入 2 倍速');
check(Math.abs(currentTime - 100) < 1e-6, '长按进 2 倍速时不额外跳 5 秒（跳转只属于单击）');
keyUp('d');
check(playbackRate === 1, '松开 D 恢复 1 倍速');
check(posts.length === 0, '长按快进只在本机：不跳转、不改房间倍速，一个请求都不发');

// 房间本来就在 1.5 倍速时，松手要回到房间倍速，而不是硬写 1 倍
S.state.rate = 1.5;
keyDown('ArrowRight');
advance(250);
check(playbackRate === 2, '房间 1.5 倍速时按住 → 一样进 2 倍速');
keyUp('ArrowRight');
check(playbackRate === 1.5, '松手回到房间倍速（房间是 1 倍速时就是 1 倍）');
S.state.rate = 1;

// 按住时切走窗口收不到 keyup，倍速不能留在 2 倍
keyDown('d');
advance(250);
check(playbackRate === 2, '按住 D 期间是 2 倍速');
fireWin('blur');
check(playbackRate === 1, '按住时窗口失焦也能把 2 倍速收回来（不会一直 2 倍速跑下去）');
currentTime = 100;
posts.length = 0;
keyUp('d');
check(Math.abs(currentTime - 100) < 1e-6 && posts.length === 0, '兜底取消之后再来的 keyup 不会再触发一次跳转');

// 系统自动重复（按住不放的连续 keydown）不是新的一次按键
video.volume = 0.5;
keyDown('w', { repeat: true });
check(Math.abs(video.volume - 0.5) < 1e-9, '自动重复的 W 不算新按键：音量不会一路冲到底');
posts.length = 0;
keyDown('d', { repeat: true });
advance(500);
check(playbackRate === 1 && posts.length === 0, '自动重复的 D 既不进 2 倍速也不跳 5 秒');

/* ---- 输入框里打字不吃快捷键，复选框上照常生效 ---- */
const textarea = { tagName: 'TEXTAREA', isContentEditable: false };
keyDown('q', { target: textarea });
check(!S.keysOpen, '在输入框里打 q 不会弹出面板（文字要能正常输入）');
video.volume = 0.5;
keyDown('w', { target: textarea });
check(Math.abs(video.volume - 0.5) < 1e-9, '在输入框里按 w 不改音量');
currentTime = 100;
posts.length = 0;
keyDown('d', { target: textarea });
keyUp('d', { target: textarea });
check(Math.abs(currentTime - 100) < 1e-6 && posts.length === 0, '在输入框里按 d 不跳转（按下和松开都要放行）');

video.volume = 0.5;
currentTime = 100;
keyDown('ArrowDown', { target: { tagName: 'INPUT', type: 'range' } });
check(Math.abs(video.volume - 0.5) < 1e-9 && Math.abs(currentTime - 100) < 1e-6,
  '焦点在滑块上时方向键归滑块自己（我们不抢，免得一下动两格）');

video.volume = 0.5;
keyDown('w', { target: { tagName: 'INPUT', type: 'checkbox' } });
check(Math.abs(video.volume - 0.6) < 1e-9, '焦点在「静音」复选框上时音量键照常生效（否则点完静音音量键就失灵）');

/* ---- 没对上房间时不许跳（键盘不能绕过遮罩把全场带跑）---- */
currentTime = 100;
posts.length = 0;
S.matches = false;
keyDown('d');
keyUp('d');
check(Math.abs(currentTime - 100) < 1e-6 && posts.length === 0, '哈希还没对上房间时方向键不跳转');
S.matches = true;

S.file = null;
currentTime = 100;
keyDown('ArrowRight');
keyUp('ArrowRight');
check(Math.abs(currentTime - 100) < 1e-6, '还没选本地文件时方向键不跳转（跟控制条一样不可用）');
S.file = file;

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
