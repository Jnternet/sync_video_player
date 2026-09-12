// 全屏控制条的浮现/淡出行为：用最小 DOM 桩加载真实交付的 web/app.js，断言
//   1) 点「⛶ 全屏」全屏的是 .stage（画面 + 控制条都在里面）
//   2) 静止一会儿控制条淡出，动鼠标/触摸/按键又浮回来
//   3) 鼠标停在控制条上、或正在拖进度条时不淡出
//   4) 退出全屏（以及窗口模式）下不淡出，控制条照常占位可见
// 时间用假定时器推进，不真的等 2.6 秒；跑的是交付给浏览器的那份文件。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  [PASS] ${m}`); pass++; };
const bad = (m) => { console.log(`  [FAIL] ${m}`); fail++; };
const check = (c, m) => (c ? ok(m) : bad(m));

/* ------------------------------------------------------- 假定时器 */
// 「静止 2.6 秒淡出」用真实时钟等太久，所以自己排一个时间轴按需推进。
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

const video = getEl('video');
video.readyState = 4;
video.duration = 3600;
video.paused = true;
video.volume = 1;
video.muted = false;
video.play = async () => {};
video.pause = () => {};

const stage = getEl('stage');
const stack = getEl('ctlStack');
let fullscreenEl = null;
let requestedOn = null;

const docHandlers = new Map();
const fireDoc = (ev) => (docHandlers.get(ev) || []).forEach((fn) => fn({ type: ev }));

stage.requestFullscreen = function () {
  requestedOn = this;                                   // 记下全屏的到底是哪个元素
  fullscreenEl = stage;
  fireDoc('fullscreenchange');
  return Promise.resolve();
};

const document = {
  getElementById: getEl,
  querySelector: (sel) => (sel === '.stage' ? stage : sel === '.ctl-stack' ? stack : null),
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => {
    if (!docHandlers.has(ev)) docHandlers.set(ev, []);
    docHandlers.get(ev).push(fn);
  },
  get fullscreenElement() { return fullscreenEl; },
  activeElement: null,
  exitFullscreen() { fullscreenEl = null; fireDoc('fullscreenchange'); return Promise.resolve(); },
};

const sandbox = {
  document,
  window: { addEventListener: () => {}, prompt: () => {} },
  location: { search: '?room=test', origin: 'http://127.0.0.1:8080' },
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, v); },
  },
  crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; } },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, srv_ms: Date.now() }), text: async () => '{}' }),
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

const exposed = src + '\n;globalThis.__api = { S, bind, FS_IDLE_MS };\n';
vm.createContext(sandbox);
vm.runInContext(exposed, sandbox);
const { S, bind, FS_IDLE_MS } = sandbox.__api;

bind();   // 真实页面里由 DOMContentLoaded 触发

const idle = () => stage.classes.has('ctl-idle');

/* ------------------------------------------------------- 场景 */
console.log('全屏控制条（浮现 / 淡出）行为检查：');

getEl('fsBtn').fire('click');
check(requestedOn === stage, '点「⛶ 全屏」全屏的是 .stage：画面和控制条都进全屏');
check(fullscreenEl === stage && !idle(), '刚进全屏时控制条先亮着（不是一进去就空屏）');

advance(FS_IDLE_MS + 50);
check(idle(), `鼠标静止 ${FS_IDLE_MS}ms 后控制条淡出，不挡画面`);

fireDoc('mousemove');
check(!idle(), '鼠标一晃控制条又浮出来');

advance(FS_IDLE_MS + 50);
check(idle(), '晃完不再动又淡出');

fireDoc('touchstart');
check(!idle(), '触屏点一下也能唤醒控制条');

advance(FS_IDLE_MS + 50);
fireDoc('keydown');
check(!idle(), '按一下键盘也能唤醒控制条');

// 鼠标停在控制条上时不该淡出，否则拖音量/进度条的手会被"吞掉"
stack.fire('mouseenter');
advance(FS_IDLE_MS * 3);
check(!idle(), '鼠标停在控制条上时一直可见（正在调音量/进度）');
stack.fire('mouseleave');
advance(FS_IDLE_MS + 50);
check(idle(), '鼠标离开控制条后重新开始倒计时');

// 正在拖动进度条（按住不放）也不该淡出
fireDoc('mousemove');
S.scrubbing = true;
advance(FS_IDLE_MS * 2);
check(!idle(), '正拖着进度条时不淡出');
S.scrubbing = false;
advance(FS_IDLE_MS + 50);
check(idle(), '松开进度条后照常淡出');

// 退出全屏：窗口模式下控制条是正常占位的那一条，必须一直可见
document.exitFullscreen();
check(!idle(), '退出全屏后清掉淡出状态，控制条恢复正常占位显示');
advance(FS_IDLE_MS * 3);
check(!idle(), '窗口模式（非全屏）下不会自动淡出');
fireDoc('mousemove');
advance(FS_IDLE_MS * 3);
check(!idle(), '窗口模式下鼠标乱动也不会把控制条藏起来');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
