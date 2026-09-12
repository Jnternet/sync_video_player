// 用最小 DOM 桩加载真实的 web/app.js，验证"偏差只在收到新控制信息时改变"的策略：
//   1) 首次拿到控制信息 → 对齐一次
//   2) 之后一串心跳快照（签名不变）→ 播放器一个动作都不能有
//   3) 出现新操作（暂停/跳转/倍速）→ 才允许改变
// 直接跑交付给浏览器的那份文件，而不是重写一份逻辑来自测。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  [PASS] ${m}`); pass++; };
const bad = (m) => { console.log(`  [FAIL] ${m}`); fail++; };
const check = (c, m) => (c ? ok(m) : bad(m));

function makeEl(id) {
  return {
    id,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    dataset: {},
    value: '0',
    checked: true,
    textContent: '',
    innerHTML: '',
    disabled: false,
    addEventListener() {},
  };
}

const els = new Map();
const video = makeEl('video');
let currentTime = 0;
let seekWrites = 0;
let playCalls = 0;
let pauseCalls = 0;
let playbackRate = 1;
video.readyState = 4;
video.duration = 3600;
video.paused = true;
video.volume = 1;
video.muted = false;
video.addEventListener = () => {};
video.play = async () => { playCalls++; video.paused = false; };
video.pause = () => { pauseCalls++; video.paused = true; };
Object.defineProperty(video, 'currentTime', {
  get: () => currentTime,
  set: (v) => { currentTime = v; seekWrites++; },
});
Object.defineProperty(video, 'playbackRate', {
  get: () => playbackRate,
  set: (v) => { playbackRate = v; },
});
els.set('video', video);

const sandbox = {
  document: {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    activeElement: null,
  },
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
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  JSON, Math, Date, Number, String, Array, Object, Boolean, isFinite, parseInt, parseFloat,
  URLSearchParams,
};
sandbox.globalThis = sandbox;

// 顶层 const/let 不会挂到 context 对象上，所以把需要的引用显式导出一份再取用
const exposed = src + '\n;globalThis.__api = { S, onState, tickLocal, stateSignature, targetPos };\n';
vm.createContext(sandbox);
vm.runInContext(exposed, sandbox);
const { S, onState, tickLocal, stateSignature } = sandbox.__api;

const HASH = 'a'.repeat(64);
const BASE_POS = 600000;
const BASE_SRV = Date.now();

const snapshot = (over) => Object.assign({
  room: 'test',
  srv_ms: Date.now(),
  version: 1,
  media: { hash: HASH, size: 1000, name: 'movie.mkv', mode: 'full', duration_ms: 3600000 },
  owner: 'c1',
  playing: true,
  rate: 1,
  base_pos_ms: BASE_POS,
  base_srv_ms: BASE_SRV,
  pos_ms: BASE_POS,
  wait_for_buffer: true,
  paused_by_wait: false,
  waiting_for: [],
  clients: [],
}, over || {});

S.offset = 0;
S.localHash = HASH;
S.file = { name: 'movie.mkv', size: 1000 };
video.readyState = 4;

S.lastSignature = null;
onState(snapshot());
check(seekWrites === 1, '首次收到控制信息时对齐一次（seek 次数=' + seekWrites + '，目标=' + Math.round(currentTime) + 's）');
check(video.paused === false, '房间处于播放态时本地开始播放');

const before = { seekWrites, playCalls, pauseCalls, playbackRate, currentTime };
for (let i = 0; i < 6; i++) {
  onState(snapshot({ srv_ms: Date.now() + i * 1000, version: 1 + i }));
}
check(seekWrites === before.seekWrites, '心跳期间没有发生任何跳转');
check(playCalls === before.playCalls && pauseCalls === before.pauseCalls, '心跳期间没有播放/暂停动作');
check(playbackRate === before.playbackRate, '心跳期间倍速没有被改动');
check(currentTime === before.currentTime, '心跳期间播放位置没有被触碰');

check(
  stateSignature(snapshot({ srv_ms: Date.now() })) === stateSignature(snapshot({ srv_ms: Date.now() + 5000, version: 99 })),
  '状态签名忽略心跳差异，只由控制信息决定',
);
check(
  stateSignature(snapshot()) !== stateSignature(snapshot({ playing: false })),
  '播放/暂停属于新的控制信息',
);
check(
  stateSignature(snapshot({ rate: 1.5 })) !== stateSignature(snapshot()),
  '倍速属于新的控制信息',
);

const beforePause = { seekWrites, pauseCalls };
onState(snapshot({ playing: false, base_pos_ms: BASE_POS + 30000, base_srv_ms: Date.now() }));
check(pauseCalls === beforePause.pauseCalls + 1, '收到 pause 控制信息后本地暂停');
check(seekWrites > beforePause.seekWrites, '收到 pause 控制信息后对齐到新位置');

onState(snapshot({ playing: false, rate: 2, base_pos_ms: BASE_POS + 30000, base_srv_ms: Date.now() }));
check(playbackRate === 2, '倍速控制信息生效（当前 ' + playbackRate + 'x）');

const beforeTick = { seekWrites, playbackRate, currentTime };
S.autoTrim = false;
for (let i = 0; i < 10; i++) tickLocal();
check(
  seekWrites === beforeTick.seekWrites && playbackRate === beforeTick.playbackRate && currentTime === beforeTick.currentTime,
  '本地心跳 tick 不做任何位置/倍速调整',
);
check(typeof S.drift === 'number' || S.drift === null, '偏差只作为展示值存在');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
