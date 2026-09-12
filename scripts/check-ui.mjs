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

// 全屏必须覆盖控制条：全屏元素里要有进度、倍速、音量、静音和全屏按钮本身。
// 曾经只全屏 .video-wrap（纯画面），全屏后这些控件留在屏幕外，等于全屏就没法调了。
const stageHtml = (html.match(/<section class="stage">[\s\S]*?<\/section>/) || [''])[0];
if (!stageHtml) {
  console.log('[FAIL] index.html 里找不到 <section class="stage">，无法确认全屏范围');
  bad++;
} else {
  for (const need of ['id="seek"', 'id="rateSel"', 'id="vol"', 'id="muteChk"', 'id="fsBtn"']) {
    if (!stageHtml.includes(need)) {
      console.log(`[FAIL] 全屏元素 .stage 里缺少 ${need}：全屏后这个控件会看不见、调不了`);
      bad++;
    }
  }
}

// 全屏请求要指向 .stage；如果又改回 .video-wrap，上面那条检查就形同虚设。
const toggleFn = (js.match(/function toggleFullscreen\(\) \{[\s\S]*?\n\}/) || [''])[0];
if (!toggleFn) {
  console.log('[FAIL] app.js 里找不到 toggleFullscreen()，全屏入口被改名或删了');
  bad++;
} else if (!toggleFn.includes("querySelector('.stage')") || !/requestFullscreen/.test(toggleFn)) {
  console.log('[FAIL] app.js 的全屏请求没有指向包含控制条的 .stage（改成纯画面就没法调进度/音量）');
  bad++;
}

// 光把元素放进全屏还不够，CSS 得让画面撑满、控制条留在下面。
if (!/\.stage:fullscreen[\s\S]{0,400}\.video-wrap/.test(css) || !/\.stage:-webkit-full-screen/.test(css)) {
  console.log('[FAIL] app.css 缺少 .stage 全屏布局（.video-wrap 撑满 + 带 -webkit- 前缀的兜底）');
  bad++;
}

console.log(
  `检查了 ${usedIds.size} 个 id、${usedClasses.size} 个 class（HTML 共 ${htmlIds.size} 个 id）`,
);
console.log(bad === 0 ? '前端接线检查通过 ✔' : `发现 ${bad} 处问题 ✘`);
process.exit(bad === 0 ? 0 : 1);
