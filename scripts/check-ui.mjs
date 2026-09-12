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

// 控制条必须是 .video-wrap 的兄弟节点（同一个 .stage 里），而不是塞在画面容器里面：
// 画面容器带 overflow:hidden + 圆角，视频又常自成一个合成层，浮层塞在里面时
// 某些浏览器会把它画到视频下面——表现就是「点得到、看不见」。同时它不能在 .stage 外面。
const depthAt = (needle) => {
  const at = html.indexOf(needle);
  if (at < 0) return -1;
  let depth = 0;
  for (const m of html.slice(0, at).matchAll(/<div\b|<\/div>/g)) depth += m[0] === '</div>' ? -1 : 1;
  return depth;
};
if (depthAt('class="ctl-stack"') !== depthAt('class="video-wrap"')) {
  console.log('[FAIL] .ctl-stack 不是 .video-wrap 的兄弟节点：塞进画面容器里会被 overflow/合成层吃掉（点得到、看不见）');
  bad++;
}
if (!/\.stage\s*\{[\s\S]{0,120}?position:\s*relative/.test(cssCode)) {
  console.log('[FAIL] app.css 里 .stage 不是 position:relative：控制条会相对别的东西定位，跑到画面外面');
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

// CSS：默认必须是「文档流里、收起时不占高度」的滑出式控制条。
// 浮层（绝对定位叠在画面上）在有些显卡/浏览器上会被画到视频层下面（点得到、看不见），
// 所以它只能是可选模式，不能当默认。
const stackRule = (cssCode.match(/(?:^|\n)\s*\.ctl-stack\s*\{[\s\S]{0,500}?\}/) || [''])[0];
if (!/position:\s*relative/.test(stackRule) || !/max-height:\s*0/.test(stackRule) || !/overflow:\s*hidden/.test(stackRule)) {
  console.log('[FAIL] app.css 里 .ctl-stack 默认不是「在文档流里、收起时高度为 0」的滑出式（默认不能叠在画面上）');
  bad++;
}
if (!/\.stage:not\(\.ctl-idle\) \.ctl-stack\s*\{[\s\S]{0,300}?max-height:\s*[1-9]/.test(cssCode)) {
  console.log('[FAIL] app.css 缺少「有活动时把控制条展开」的规则（.stage:not(.ctl-idle) .ctl-stack）');
  bad++;
}
// 全屏：控制条的位置必须常驻预留（高度固定），否则它一出现就把画面挤上去，
// 用户调进度时画面跟着跳 —— 这是明确提过的验收点。
const fsStrip = (cssCode.match(/\.stage\.is-fs:not\(\.ctl-float\) \.ctl-stack\s*\{[\s\S]{0,300}?\}/) || [''])[0];
if (!/max-height:\s*none/.test(fsStrip) || !/padding/.test(fsStrip) || !/opacity:\s*0/.test(fsStrip)) {
  console.log('[FAIL] app.css 里全屏滑出模式没有常驻预留控制条位置（画面会被挤动）');
  bad++;
}
if (!/\.stage\.is-fs\.ctl-idle \.ctl-stack\s*\{[\s\S]{0,200}?pointer-events:\s*none/.test(cssCode)) {
  console.log('[FAIL] app.css 里全屏收起态没有 pointer-events:none（预留区会挡住鼠标）');
  bad++;
}
// 浮层模式：视频会自成合成层，浮层必须提层，而且这条只能是显式切过去的可选模式
const floatRule = (cssCode.match(/\.stage\.ctl-float \.ctl-stack\s*\{[\s\S]{0,900}?\}/) || [''])[0];
if (!/position:\s*absolute/.test(floatRule) || !/transform:\s*translateZ\(0\)/.test(floatRule)) {
  console.log('[FAIL] app.css 里浮层模式（.stage.ctl-float .ctl-stack）必须是绝对定位 + translateZ(0)');
  bad++;
}
// 光提层还不够：视频可能被送进硬件叠加层（显示控制器直接扫描输出），
// 那样网页浮层会被整个盖住。这几条是用来逼合成器把视频画回页面纹理的。
if (!/backdrop-filter/.test(floatRule)) {
  console.log('[FAIL] app.css 里浮层没有 backdrop-filter：合成器可能仍然把视频走硬件叠加层，浮层看不见');
  bad++;
}
const floatVideo = (cssCode.match(/\.stage\.ctl-float video\s*\{[\s\S]{0,300}?\}/) || [''])[0];
if (!/opacity:\s*\.?0?\.\d+/.test(floatVideo) || !/border-radius/.test(floatVideo) || !/transform:\s*translateZ\(0\)/.test(floatVideo)) {
  console.log('[FAIL] app.css 缺少「把视频踢出硬件叠加层」的处理（.stage.ctl-float video 需要 opacity<1 + border-radius + translateZ(0)）');
  bad++;
}
if (!/\.stage\.ctl-blocked \.ctl-stack/.test(cssCode)) {
  console.log('[FAIL] app.css 缺少 .stage.ctl-blocked .ctl-stack：选文件时会有一层控制条压在选择界面上');
  bad++;
}
if (!/ctl-float/.test(js) || !/barModeBtn/.test(js)) {
  console.log('[FAIL] app.js 没有「滑出 / 浮层」模式切换：浮层在某些环境画不出来时用户没得选');
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

// 浮层模式收敛：静止后整块透明且不拦点击；这里少一条，浮层就会一直挂在画面上
const idleRule = (cssCode.match(/\.stage\.ctl-float\.ctl-idle \.ctl-stack[\s\S]{0,300}?\}/) || [''])[0];
if (!/opacity:\s*0/.test(idleRule) || !/pointer-events:\s*none/.test(idleRule)) {
  console.log('[FAIL] app.css 缺少浮层模式的隐藏规则（.stage.ctl-float.ctl-idle .ctl-stack 需要 opacity:0 + pointer-events:none）');
  bad++;
}

// app.js：鼠标/触摸/按键唤醒控制条，静止后倒计时淡出，鼠标停在控制条上不淡出
if (!/const CTRL_IDLE_MS\s*=/.test(js) || !/setTimeout\(hideControls/.test(js)) {
  console.log('[FAIL] app.js 没有「静止一段时间后淡出控制条」的倒计时');
  bad++;
}
// 浮现必须挂在 window 的捕获阶段 + 按坐标判断：不依赖事件目标，视频层怎么折腾都能收到
if (!/'pointermove'[\s\S]{0,200}?window\.addEventListener\(ev, onPointerActivity, \{ capture: true/.test(js)) {
  console.log('[FAIL] app.js 没有在 window 捕获阶段接住指针移动来唤醒控制条（视频层会让事件目标不可靠）');
  bad++;
}
// 浮现不能做任何条件判断：漏判一次就是「鼠标晃了但控制条不出现」，宁可多亮
if (!/function onPointerActivity\(\)\s*\{\s*pokeControls\(\);/.test(js)) {
  console.log('[FAIL] app.js 的 onPointerActivity() 带了条件：漏判时鼠标晃动不会浮现（必须无条件 pokeControls）');
  bad++;
}
if (!/function updateBarState\(\)/.test(js)) {
  console.log('[FAIL] app.js 缺少顶栏「控制条状态」胶囊的更新逻辑（出问题时没法一眼看出状态）');
  bad++;
}
if (!/elementFromPoint/.test(js)) {
  console.log('[FAIL] app.js 的诊断面板缺少命中测试（判断浮层是不是被压在视频下面要用它）');
  bad++;
}
if (!/function initDebugPanel\(\)/.test(js)) {
  console.log('[FAIL] app.js 缺少 ?debug=1 调试面板（出问题时要靠它看状态）');
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
