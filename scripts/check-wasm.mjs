// 校验 web/sync_video_player_hash.wasm：与 Node 的 crypto 以及主程序 CLI 算出的 SHA-256 是否完全一致。
//
// 用法: node scripts/check-wasm.mjs [二进制路径]
//   WASM_PATH=<路径>     换一份 wasm 来测（默认 web/sync_video_player_hash.wasm）
//   WASM_COMPARE=<路径>  额外断言"这份 wasm 和另一份算出的摘要完全相同"，
//                        用来检查仓库里的 wasm 产物有没有跟着源码更新
//                        （比字节比对可靠：不同 rustc 版本编出的 wasm 字节不同，但摘要必须一致）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] || 'target/release/sync_video_player';
const wasmPath = process.env.WASM_PATH || new URL('../web/sync_video_player_hash.wasm', import.meta.url);

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  [PASS] ${m}`); pass++; };
const bad = (m) => { console.log(`  [FAIL] ${m}`); fail++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;

const ABI = 2;
check(ex.sync_video_player_version() === ABI, `wasm ABI 版本为 ${ABI}（实际 ${ex.sync_video_player_version()}）`);

// 构造 12 MiB 确定性伪随机数据（大于抽样阈值）
const SIZE = 12 * 1024 * 1024;
const data = new Uint8Array(SIZE);
let s = 0x12345678;
for (let i = 0; i < SIZE; i++) {
  s = (s * 1103515245 + 12345) & 0x7fffffff;
  data[i] = (s >>> 16) & 0xff;
}
const ref = createHash('sha256').update(data).digest('hex');

const STAGE = 1 << 20;
const stagePtr = ex.sync_video_player_alloc(STAGE);
const toHex = (x, p) =>
  Array.from(new Uint8Array(x.memory.buffer, p, 32), (b) => b.toString(16).padStart(2, '0')).join('');

// 整文件摘要：分块喂给 wasm（前端就是这么调的）
function fullDigest(x, buf, ptr) {
  x.sync_video_player_begin_full();
  for (let off = 0; off < buf.length; off += STAGE) {
    const part = buf.subarray(off, Math.min(off + STAGE, buf.length));
    new Uint8Array(x.memory.buffer, ptr, part.length).set(part);
    x.sync_video_player_update(ptr, part.length);
  }
  return toHex(x, x.sync_video_player_finish());
}

// 抽样摘要：按 wasm 给出的采样计划读（u64 形参需要 BigInt）
function sampleDigest(x, buf, ptr) {
  x.sync_video_player_begin_sample(BigInt(buf.length));
  const count = x.sync_video_player_sample_count();
  for (let i = 0; i < count; i++) {
    const p = x.sync_video_player_sample_at(i);
    const dv = new DataView(x.memory.buffer, p, 16);
    const off = Number(dv.getBigUint64(0, true));
    const len = Number(dv.getBigUint64(8, true));
    const part = buf.subarray(off, off + len);
    new Uint8Array(x.memory.buffer, ptr, part.length).set(part);
    x.sync_video_player_update(ptr, part.length);
  }
  return { digest: toHex(x, x.sync_video_player_finish()), count };
}

const wasmFull = fullDigest(ex, data, stagePtr);
check(wasmFull === ref, 'wasm 整文件 SHA-256 与 Node crypto 一致');

// ---- 用同一个文件校验与 CLI 的一致性 ----
const dir = mkdtempSync(join(tmpdir(), 'sync_video_player-wasm-'));
const file = join(dir, 'sample.bin');
writeFileSync(file, data);
try {
  const cliFull = JSON.parse(execFileSync(BIN, ['hash', file, '--json'], { encoding: 'utf8' })).hash;
  check(cliFull === wasmFull, 'wasm 整文件摘要与 CLI(sync_video_player hash) 一致');

  // ---- 抽样模式 ----
  const sampled = sampleDigest(ex, data, stagePtr);
  const wasmSample = sampled.digest;
  check(sampled.count > 1, `抽样计划包含 ${sampled.count} 个采样点`);
  const cliSample = JSON.parse(execFileSync(BIN, ['hash', file, '--sample', '--json'], { encoding: 'utf8' })).hash;
  check(cliSample === wasmSample, 'wasm 抽样摘要与 CLI(--sample) 一致');
  check(wasmSample !== wasmFull, '抽样摘要与整文件摘要不同（域分隔生效）');
} catch (e) {
  bad(`调用 CLI 失败: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- 与「仓库里那份 wasm 产物」比对摘要 ----
// 重新编译后字节可能不同（rustc 版本不同），但摘要必须完全一致，
// 否则说明改了 src/sha256.rs 或 src/hashspec.rs 之后忘了重新构建并提交产物。
const comparePath = process.env.WASM_COMPARE;
if (comparePath) {
  console.log(`\n-- 与仓库产物比对：${comparePath} --`);
  const committedBytes = readFileSync(comparePath);
  const { instance: committed } = await WebAssembly.instantiate(committedBytes, {});
  const cx = committed.exports;
  const cPtr = cx.sync_video_player_alloc(STAGE);

  check(
    cx.sync_video_player_version() === ex.sync_video_player_version(),
    `两份 wasm 的 ABI 版本一致（${cx.sync_video_player_version()}）`,
  );
  check(
    fullDigest(cx, data, cPtr) === wasmFull,
    '重新编译的 wasm 与仓库产物的整文件摘要一致',
  );
  check(
    sampleDigest(cx, data, cPtr).digest === sampleDigest(ex, data, stagePtr).digest,
    '重新编译的 wasm 与仓库产物的抽样摘要一致',
  );
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
