// 检查 web/app.js 里引用的 DOM id / class 是否都在 index.html 中存在。
// 这类拼写错误在浏览器里只会表现为“某个按钮点了没反应”，静态检查更省事。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
);

const usedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const usedClasses = new Set([
  ...[...js.matchAll(/querySelectorAll\('\.([\w-]+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/querySelector\('\.([\w-]+)'\)/g)].map((m) => m[1]),
]);

let bad = 0;
for (const id of usedIds) {
  if (!htmlIds.has(id)) {
    console.log(`[FAIL] app.js 使用了 index.html 中不存在的 id: #${id}`);
    bad++;
  }
}
for (const cls of usedClasses) {
  if (!htmlClasses.has(cls)) {
    console.log(`[FAIL] app.js 使用了 index.html 中不存在的 class: .${cls}`);
    bad++;
  }
}

// HTML 里声明的 id 必须唯一
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
if (dupes.length) {
  console.log(`[FAIL] index.html 存在重复 id: ${[...new Set(dupes)].join(', ')}`);
  bad++;
}

// 全屏的样子必须是「画面铺满 + 控制条浮在画面上按需出现」。
// 回归过两次：先是只全屏 .video-wrap（纯画面）导致全屏后调不了；
// 后来又把控制条做成占位的一整条，把画面挤小了——所以要同时卡住这两点。
const stageHtml = (html.match(/<section class="stage">[\s\S]*?<\/section>/) || [''])[0];
const stackHtml = stageHtml.slice(stageHtml.indexOf('class="ctl-stack"'));
const CONTROLS = ['id="seek"', 'id="rateSel"', 'id="vol"', 'id="muteChk"', 'id="fsBtn"'];
if (!stageHtml || !stackHtml) {
  console.log('[FAIL] index.html 里找不到 <section class="stage"> / .ctl-stack，无法确认全屏范围');
  bad++;
} else {
  // 控制条必须在 .ctl-stack 里：全屏时整块浮起来的就是它
  for (const need of CONTROLS) {
    if (!stackHtml.includes(need)) {
      console.log(`[FAIL] .ctl-stack 里缺少 ${need}：全屏后这个控件不会跟着浮上来`);
      bad++;
    }
  }
}

// 全屏请求要指向 .stage（画面 + 控制条都在里面），不能只全屏 .video-wrap。
const stageSelFn = (js.match(/function stageEl\(\) \{[\s\S]*?\n\}/) || [''])[0];
const toggleFn = (js.match(/function toggleFullscreen\(\) \{[\s\S]*?\n\}/) || [''])[0];
if (!stageSelFn.includes("querySelector('.stage')") || !/stageEl\(\)/.test(toggleFn)) {
  console.log('[FAIL] app.js 的全屏请求没有指向 .stage（只全屏画面就调不了进度/音量）');
  bad++;
} else if (!/requestFullscreen/.test(toggleFn)) {
  console.log('[FAIL] app.js 的 toggleFullscreen() 里没有 requestFullscreen');
  bad++;
}

// CSS：控制条挂在画面上面（绝对定位、不吃画面高度），带 -webkit- 前缀兜底
const stackRule = (css.match(/\.stage:fullscreen \.ctl-stack[\s\S]{0,500}?\}/) || [''])[0];
if (!/position:\s*absolute/.test(stackRule) || !/bottom:\s*0/.test(stackRule)) {
  console.log('[FAIL] app.css 里 .stage:fullscreen .ctl-stack 不是浮在画面底部的绝对定位（会挤占画面）');
  bad++;
}
if (!/\.stage:-webkit-full-screen \.ctl-stack/.test(css)) {
  console.log('[FAIL] app.css 缺少 .stage:-webkit-full-screen .ctl-stack（老 Safari 兜底）');
  bad++;
}
if (/^\s*\.ctl-stack\s*[,{]/m.test(css)) {
  console.log('[FAIL] app.css 给 .ctl-stack 加了全局规则：窗口模式下控制条本来就该正常占位');
  bad++;
}

// 淡出：静止后整块透明且不拦点击；这里少一条，全屏就会一直挂着一条控制条
const idleRule = (css.match(/\.stage:fullscreen\.ctl-idle \.ctl-stack[\s\S]{0,300}?\}/) || [''])[0];
if (!/opacity:\s*0/.test(idleRule) || !/pointer-events:\s*none/.test(idleRule)) {
  console.log('[FAIL] app.css 缺少 .ctl-idle 的淡出规则（opacity:0 + pointer-events:none）');
  bad++;
}

// app.js：鼠标/触摸/按键唤醒控制条，静止后倒计时淡出，鼠标停在控制条上不淡出
if (!/const FS_IDLE_MS\s*=/.test(js) || !/setTimeout\(hideFullscreenControls/.test(js)) {
  console.log('[FAIL] app.js 没有「静止一段时间后淡出控制条」的倒计时');
  bad++;
}
if (!/'mousemove'[\s\S]{0,120}?'touchstart'[\s\S]{0,120}?'keydown'/.test(js) ||
    !/document\.addEventListener\(ev, pokeFullscreenControls/.test(js)) {
  console.log('[FAIL] app.js 没有接住鼠标移动/触摸/按键来唤醒全屏控制条');
  bad++;
}
if (!/mouseenter', holdFullscreenControls/.test(js)) {
  console.log('[FAIL] app.js 少了「鼠标停在控制条上就不淡出」：拖音量/进度条时会被吞掉');
  bad++;
}

console.log(
  `检查了 ${usedIds.size} 个 id、${usedClasses.size} 个 class（HTML 共 ${htmlIds.size} 个 id）`,
);
console.log(bad === 0 ? '前端接线检查通过 ✔' : `发现 ${bad} 处问题 ✘`);
process.exit(bad === 0 ? 0 : 1);
