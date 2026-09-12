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
// 画面区域：0,0 - 800,450。控制条按坐标判断指针在不在画面上，所以要一个真实矩形。
const wrap = getEl('videoWrap');
wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 });
let fullscreenEl = null;
let requestedOn = null;

const docHandlers = new Map();
const fireDoc = (ev) => (docHandlers.get(ev) || []).forEach((fn) => fn({ type: ev }));
const winHandlers = new Map();
const fireWin = (ev, props) => (winHandlers.get(ev) || []).forEach((fn) => fn(Object.assign({ type: ev }, props)));

stage.requestFullscreen = function () {
  requestedOn = this;                                   // 记下全屏的到底是哪个元素
  fullscreenEl = stage;
  fireDoc('fullscreenchange');
  return Promise.resolve();
};

const document = {
  getElementById: getEl,
  querySelector: (sel) => (
    sel === '.stage' ? stage : sel === '.ctl-stack' ? stack : sel === '.video-wrap' ? wrap : null
  ),
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
const pointerIn = () => fireWin('pointermove', { clientX: 400, clientY: 300 });    // 画面里（0,0-800,450）
const pointerOut = () => fireWin('pointermove', { clientX: 1500, clientY: 900 });  // 画面外

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

pointerIn();
check(!idle(), '鼠标在画面上晃一下控制条就浮出来（无条件浮现，不依赖事件目标）');

advance(CTRL_IDLE_MS + 50);
pointerOut();
check(!idle(), '鼠标在画面外晃动也会浮现（不做坐标判断，宁可多亮也不能漏）');
check(getEl('barStatePill').textContent.includes('显示中'), '顶栏状态胶囊显示「控制条 显示中」');

advance(CTRL_IDLE_MS + 50);
check(idle(), '晃完不再动又淡出');
check(getEl('barStatePill').textContent.includes('已收起'), '顶栏状态胶囊显示「控制条 已收起」');

fireWin('touchstart', {});
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
pointerIn();
S.scrubbing = true;
advance(CTRL_IDLE_MS * 2);
check(!idle(), '正拖着进度条时不淡出');
S.scrubbing = false;
advance(CTRL_IDLE_MS + 50);
check(idle(), '松开进度条后照常淡出');

// 暂停时控制条留着（要能点播放、拖进度），续播后恢复计时
pointerIn();
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
pointerIn();
check(!idle(), '窗口模式下鼠标在画面上晃动也能唤出控制条');

// 默认「滑出」模式 + 可切「浮层」模式：浮层在某些显卡/浏览器上就是画不出来，
// 默认必须是那条一定能看见的路径，浮层只能一键切过去。
const barModeBtn = getEl('barModeBtn');
check(!stage.classes.has('ctl-float'), '默认是「滑出」模式：控制条在文档流里、不叠在画面上');
check(barModeBtn.textContent.includes('滑出'), '按钮文案显示当前是「滑出」');
advance(CTRL_IDLE_MS + 50);
check(idle(), '滑出模式下静止后控制条收起（收起时高度为 0，不占画面位置）');
check(getEl('barStatePill').textContent.includes('已收起'), '状态胶囊显示「控制条 已收起」');
barModeBtn.fire('click');
check(stage.classes.has('ctl-float'), '点顶栏「控制条」可切到浮层模式（bilibili 那种叠在画面上）');
check(barModeBtn.textContent.includes('浮层'), '按钮文案显示当前是「浮层」');
barModeBtn.fire('click');
check(!stage.classes.has('ctl-float'), '再点一下切回滑出模式');
advance(CTRL_IDLE_MS + 50);
check(idle(), '切回滑出后照常收起');

// 诊断面板：不用改 URL 就能开
check(els.has('diagBtn'), '顶栏有「诊断」按钮（点开看控制条状态，定位问题用）');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
