// 检查 web/app.js 里引用的 DOM id / class 是否都在 index.html 中存在。
// 这类拼写错误在浏览器里只会表现为“某个按钮点了没反应”，静态检查更省事。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里会拿伪类当反面教材，检查只看真正的规则

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

// 控制条必须是「浮在画面上、不占位置、按需出现」的样子。
// 回归过几次：只全屏 .video-wrap（纯画面）导致全屏后调不了；控制条占位把画面挤小；
// 用 :fullscreen 伪类驱动布局，在 Firefox 里整条规则被丢掉，全屏后什么都弹不出来。
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

// 控制条要放在 .video-wrap 里面：这样它跟着画面走（全屏时贴屏幕底部），
// 并且被画面的圆角裁掉；放到外面就会变成画面下方独立的一条。
const depthAt = (needle) => {
  const at = html.indexOf(needle);
  if (at < 0) return -1;
  let depth = 0;
  for (const m of html.slice(0, at).matchAll(/<div\b|<\/div>/g)) depth += m[0] === '</div>' ? -1 : 1;
  return depth;
};
if (depthAt('class="ctl-stack"') !== depthAt('class="video-wrap"') + 1) {
  console.log('[FAIL] .ctl-stack 没有放在 .video-wrap 里面：控制条不会贴在画面底部（全屏时也不会贴屏幕底部）');
  bad++;
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

// CSS：控制条浮在画面上（绝对定位、不吃画面高度）
const stackRule = (cssCode.match(/(?:^|\n)\s*\.ctl-stack\s*\{[\s\S]{0,500}?\}/) || [''])[0];
if (!/position:\s*absolute/.test(stackRule) || !/bottom:\s*0/.test(stackRule)) {
  console.log('[FAIL] app.css 里 .ctl-stack 不是浮在画面底部的绝对定位（会挤占画面）');
  bad++;
}

// 这一条是踩过的坑：Firefox 不认 :-webkit-full-screen，而选择器列表里只要有一个
// 不认识的伪类，整条规则（连 :fullscreen 那半截）会被整体丢弃 —— 全屏后什么都弹不出来。
// 所以全屏布局一律用 app.js 加在 .stage 上的 .is-fs 类，CSS 里不许再出现带前缀的伪类。
if (/-webkit-full-screen|-moz-full-screen/.test(cssCode)) {
  console.log('[FAIL] app.css 又用上了 :-webkit-full-screen / :-moz-full-screen：Firefox 不认带前缀的伪类，'
    + '混在选择器列表里会让整条规则失效（全屏布局请用 .is-fs 类）');
  bad++;
}

// 全屏布局类：画面铺满 + 视频撑开
if (!/\.stage\.is-fs\s*\{[\s\S]{0,300}?position:\s*fixed/.test(cssCode)) {
  console.log('[FAIL] app.css 缺少 .stage.is-fs 的全屏布局（全屏时要铺满屏幕、钉住视口）');
  bad++;
}
if (!/\.stage\.is-fs \.video-wrap\s*\{[\s\S]{0,200}?flex/.test(cssCode)) {
  console.log('[FAIL] app.css 里 .stage.is-fs .video-wrap 没有撑满（全屏后画面不会铺满屏幕）');
  bad++;
}
if (!/classList\.toggle\('is-fs'/.test(js)) {
  console.log('[FAIL] app.js 没有在 fullscreenchange 时给 .stage 切换 .is-fs（全屏布局靠它生效）');
  bad++;
}

// 淡出：静止后整块透明且不拦点击；这里少一条，控制条就会一直挂在画面上
const idleRule = (cssCode.match(/\.stage\.ctl-idle \.ctl-stack[\s\S]{0,300}?\}/) || [''])[0];
if (!/opacity:\s*0/.test(idleRule) || !/pointer-events:\s*none/.test(idleRule)) {
  console.log('[FAIL] app.css 缺少 .ctl-idle 的淡出规则（opacity:0 + pointer-events:none）');
  bad++;
}

// app.js：鼠标/触摸/按键唤醒控制条，静止后倒计时淡出，鼠标停在控制条上不淡出
if (!/const CTRL_IDLE_MS\s*=/.test(js) || !/setTimeout\(hideControls/.test(js)) {
  console.log('[FAIL] app.js 没有「静止一段时间后淡出控制条」的倒计时');
  bad++;
}
if (!/'mousemove'[\s\S]{0,120}?'touchstart'/.test(js) ||
    !/stage\.addEventListener\(ev, pokeControls/.test(js)) {
  console.log('[FAIL] app.js 没有在画面上接住鼠标移动/触摸来唤醒控制条');
  bad++;
}
if (!/mouseenter', holdControls/.test(js)) {
  console.log('[FAIL] app.js 少了「鼠标停在控制条上就不淡出」：拖音量/进度条时会被吞掉');
  bad++;
}

console.log(
  `检查了 ${usedIds.size} 个 id、${usedClasses.size} 个 class（HTML 共 ${htmlIds.size} 个 id）`,
);
console.log(bad === 0 ? '前端接线检查通过 ✔' : `发现 ${bad} 处问题 ✘`);
process.exit(bad === 0 ? 0 : 1);
