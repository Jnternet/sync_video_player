// 控制条的浮现/淡出与全屏切换：用最小 DOM 桩加载真实交付的 web/app.js，断言
//   1) 点「⛶ 全屏」全屏的是 .stage，并给它加上 .is-fs（全屏布局靠这个类，不靠 :fullscreen 伪类）
//   2) 鼠标在画面上动/触摸/按键 → 控制条浮现；静止一会儿 → 淡出
//   3) 鼠标停在控制条上、或正在拖进度条时 → 不淡出
//   4) 暂停时控制条一直留着；恢复播放后重新计时
//   5) 退出全屏后布局类被摘掉，窗口模式下同样是「浮现/淡出」这一套
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

const exposed = src + '\n;globalThis.__api = { S, bind, CTRL_IDLE_MS };\n';
vm.createContext(sandbox);
vm.runInContext(exposed, sandbox);
const { S, bind, CTRL_IDLE_MS } = sandbox.__api;

bind();   // 真实页面里由 DOMContentLoaded 触发

const idle = () => stage.classes.has('ctl-idle');
const fsClass = () => stage.classes.has('is-fs');
const fsBtn = getEl('fsBtn');

/* ------------------------------------------------------- 场景 */
console.log('控制条（浮现 / 淡出 / 全屏）行为检查：');

video.paused = false;   // 先按"正在播放"来测淡出；暂停时不该淡出，单独测

fsBtn.fire('click');
check(requestedOn === stage, '点「⛶ 全屏」全屏的是 .stage：画面和控制条都进全屏');
check(fsClass(), '进全屏后 .stage 加上 .is-fs（全屏布局靠这个类，不靠 :fullscreen 伪类）');
check(!idle(), '刚进全屏时控制条先亮着（不是一进去就空屏）');
check(fsBtn.textContent.includes('退出全屏'), '按钮文案变成「退出全屏」');

advance(CTRL_IDLE_MS + 50);
check(idle(), `鼠标静止 ${CTRL_IDLE_MS}ms 后控制条淡出，不挡画面`);

stage.fire('mousemove');   // 全屏时 .stage 铺满屏幕，鼠标在任何位置动都落在它身上
check(!idle(), '鼠标在画面上晃一下控制条就浮出来');

advance(CTRL_IDLE_MS + 50);
check(idle(), '晃完不再动又淡出');

stage.fire('touchstart');
check(!idle(), '触屏点一下也能唤醒控制条');

advance(CTRL_IDLE_MS + 50);
fireDoc('keydown');
check(!idle(), '按一下键盘也能唤醒控制条');

// 鼠标停在控制条上时不该淡出，否则拖音量/进度条的手会被"吞掉"
stack.fire('mouseenter');
advance(CTRL_IDLE_MS * 3);
check(!idle(), '鼠标停在控制条上时一直可见（正在调音量/进度）');
stack.fire('mouseleave');
advance(CTRL_IDLE_MS + 50);
check(idle(), '鼠标离开控制条后重新开始倒计时');

// 正在拖动进度条（按住不放）也不该淡出
stage.fire('mousemove');
S.scrubbing = true;
advance(CTRL_IDLE_MS * 2);
check(!idle(), '正拖着进度条时不淡出');
S.scrubbing = false;
advance(CTRL_IDLE_MS + 50);
check(idle(), '松开进度条后照常淡出');

// 暂停时控制条留着（要能点播放、拖进度），续播后恢复计时
stage.fire('mousemove');
video.paused = true;
advance(CTRL_IDLE_MS * 3);
check(!idle(), '暂停时控制条一直留着（方便点播放/拖进度）');
video.paused = false;
video.fire('play');
advance(CTRL_IDLE_MS + 50);
check(idle(), '恢复播放后重新计时并淡出');

// 退出全屏：摘掉全屏布局类，窗口模式下还是同一套浮现/淡出
document.exitFullscreen();
check(!fsClass(), '退出全屏后摘掉 .is-fs');
check(!idle(), '退出全屏后控制条先亮着');
check(fsBtn.textContent.includes('全屏') && !fsBtn.textContent.includes('退出'), '按钮文案回到「⛶ 全屏」');
advance(CTRL_IDLE_MS + 50);
check(idle(), '窗口模式下不动鼠标同样会淡出（控制条一直不占画面位置）');
stage.fire('mousemove');
check(!idle(), '窗口模式下鼠标在画面上晃动也能唤出控制条');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
