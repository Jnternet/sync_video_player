// 校验 web/sync_video_player_hash.wasm：与 Node 的 crypto 以及主程序 CLI 算出的 SHA-256 是否完全一致。
// 用法: node scripts/check-wasm.mjs [二进制路径]
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] || 'target/release/sync_video_player';
const wasmPath = new URL('../web/sync_video_player_hash.wasm', import.meta.url);

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
const toHex = (p) => Array.from(new Uint8Array(ex.memory.buffer, p, 32), (b) => b.toString(16).padStart(2, '0')).join('');

// ---- 整文件模式：分块喂给 wasm ----
ex.sync_video_player_begin_full();
for (let off = 0; off < SIZE; off += STAGE) {
  const part = data.subarray(off, Math.min(off + STAGE, SIZE));
  new Uint8Array(ex.memory.buffer, stagePtr, part.length).set(part);
  ex.sync_video_player_update(stagePtr, part.length);
}
const wasmFull = toHex(ex.sync_video_player_finish());
check(wasmFull === ref, 'wasm 整文件 SHA-256 与 Node crypto 一致');

// ---- 用同一个文件校验与 CLI 的一致性 ----
const dir = mkdtempSync(join(tmpdir(), 'sync_video_player-wasm-'));
const file = join(dir, 'sample.bin');
writeFileSync(file, data);
try {
  const cliFull = JSON.parse(execFileSync(BIN, ['hash', file, '--json'], { encoding: 'utf8' })).hash;
  check(cliFull === wasmFull, 'wasm 整文件摘要与 CLI(sync_video_player hash) 一致');

  // ---- 抽样模式：按 wasm 给出的采样计划读取 ----
  // wasm 的 u64 形参需要 BigInt
  ex.sync_video_player_begin_sample(BigInt(SIZE));
  const n = ex.sync_video_player_sample_count();
  check(n > 1, `抽样计划包含 ${n} 个采样点`);
  for (let i = 0; i < n; i++) {
    const p = ex.sync_video_player_sample_at(i);
    const dv = new DataView(ex.memory.buffer, p, 16);
    const off = Number(dv.getBigUint64(0, true));
    const len = Number(dv.getBigUint64(8, true));
    const part = data.subarray(off, off + len);
    new Uint8Array(ex.memory.buffer, stagePtr, part.length).set(part);
    ex.sync_video_player_update(stagePtr, part.length);
  }
  const wasmSample = toHex(ex.sync_video_player_finish());
  const cliSample = JSON.parse(execFileSync(BIN, ['hash', file, '--sample', '--json'], { encoding: 'utf8' })).hash;
  check(cliSample === wasmSample, 'wasm 抽样摘要与 CLI(--sample) 一致');
  check(wasmSample !== wasmFull, '抽样摘要与整文件摘要不同（域分隔生效）');
} catch (e) {
  bad(`调用 CLI 失败: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
