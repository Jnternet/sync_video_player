// 检查 web/app.js 里引用的 DOM id / class 是否都在 index.html 中存在。
// 这类拼写错误在浏览器里只会表现为“某个按钮点了没反应”，静态检查更省事。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

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

console.log(
  `检查了 ${usedIds.size} 个 id、${usedClasses.size} 个 class（HTML 共 ${htmlIds.size} 个 id）`,
);
console.log(bad === 0 ? '前端接线检查通过 ✔' : `发现 ${bad} 处问题 ✘`);
process.exit(bad === 0 ? 0 : 1);

