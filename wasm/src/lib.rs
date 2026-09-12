//! 在浏览器本地运行的 Rust 哈希器。
//!
//! 浏览器把文件按块读进来、写进本模块的线性内存，调用 `sync_video_player_update` 做增量 SHA-256。
//! **文件字节全程留在本机**：不过网络，也不进入本模块以外的任何地方。
//!
//! 哈希实现与抽样规范直接复用主程序的源码（见下面的 `#[path]`），
//! 因此 `sync_video_player hash` 与网页端算出的摘要必然一致。

#[path = "../../src/sha256.rs"]
mod sha256;
#[path = "../../src/hashspec.rs"]
mod hashspec;

use core::ptr;
use hashspec::{sample_plan, Sample};
use sha256::Sha256;

/// 与 `hashspec::ABI_VERSION` 同步；前端会校验这个值。
pub const ABI_VERSION: u32 = hashspec::ABI_VERSION;

static mut HASHER: Sha256 = Sha256::new();
static mut PLAN: Vec<Sample> = Vec::new();
static mut OUT: [u8; 32] = [0u8; 32];
static mut PAIR: [u8; 16] = [0u8; 16];

#[inline]
fn hasher() -> &'static mut Sha256 {
    // 用裸指针取可变引用，避开 static_mut_refs 告警（wasm 单线程，无数据竞争）
    unsafe { &mut *ptr::addr_of_mut!(HASHER) }
}

/// 模块 ABI 版本
#[no_mangle]
pub extern "C" fn sync_video_player_version() -> u32 {
    ABI_VERSION
}

/// 在 wasm 线性内存里申请一段缓冲区（前端用来暂存待哈希的字节）
#[no_mangle]
pub extern "C" fn sync_video_player_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// 释放 `sync_video_player_alloc` 申请的缓冲区
#[no_mangle]
pub extern "C" fn sync_video_player_free(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

/// 开始一次整文件 SHA-256
#[no_mangle]
pub extern "C" fn sync_video_player_begin_full() {
    unsafe {
        let h: &mut Sha256 = &mut *ptr::addr_of_mut!(HASHER);
        *h = Sha256::new();
        let plan: &mut Vec<Sample> = &mut *ptr::addr_of_mut!(PLAN);
        plan.clear();
    }
}

/// 开始一次抽样指纹：先写入域前缀/长度/采样点表，随后按顺序 `sync_video_player_update` 各采样点数据。
#[no_mangle]
pub extern "C" fn sync_video_player_begin_sample(size: u64) {
    let plan = sample_plan(size);
    let h = hasher();
    *h = Sha256::new();
    hashspec::feed_sample_header(h, size, &plan);
    unsafe {
        let slot: &mut Vec<Sample> = &mut *ptr::addr_of_mut!(PLAN);
        *slot = plan;
    }
}

/// 本次抽样计划包含多少个采样点
#[no_mangle]
pub extern "C" fn sync_video_player_sample_count() -> u32 {
    let plan: &Vec<Sample> = unsafe { &*ptr::addr_of!(PLAN) };
    plan.len() as u32
}

/// 第 i 个采样点的 `[offset(8 字节 LE), len(8 字节 LE)]`，返回指向该 16 字节的指针。
#[no_mangle]
pub extern "C" fn sync_video_player_sample_at(i: u32) -> *const u8 {
    unsafe {
        let plan = &*ptr::addr_of!(PLAN);
        if (i as usize) >= plan.len() {
            return ptr::null();
        }
        let s = plan[i as usize];
        let pair: &mut [u8; 16] = &mut *ptr::addr_of_mut!(PAIR);
        pair[..8].copy_from_slice(&s.offset.to_le_bytes());
        pair[8..].copy_from_slice(&s.len.to_le_bytes());
        pair.as_ptr()
    }
}

/// 追加一段字节（指针指向 wasm 线性内存）
#[no_mangle]
pub extern "C" fn sync_video_player_update(data: *const u8, len: usize) {
    if data.is_null() || len == 0 {
        return;
    }
    let slice = unsafe { core::slice::from_raw_parts(data, len) };
    hasher().update(slice);
}

/// 结束并返回 32 字节摘要的指针（转小写十六进制由前端完成）
#[no_mangle]
pub extern "C" fn sync_video_player_finish() -> *const u8 {
    let digest = hasher().clone().finalize();
    unsafe {
        let out: &mut [u8; 32] = &mut *ptr::addr_of_mut!(OUT);
        *out = digest;
        out.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    //! 这些断言跑在本机（`cargo test --manifest-path wasm/Cargo.toml`），
    //! 直接调用导出给浏览器的 C ABI，确认它和主程序用的是同一套摘要。
    use super::*;
    use std::sync::Mutex;

    /// 导出的函数共用一组 static 状态，测试必须串行。
    static SERIAL: Mutex<()> = Mutex::new(());

    /// 空输入与 `abc` 的 SHA-256，取自 NIST/FIPS 180-4 测试向量。
    const EMPTY_DIGEST: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ABC_DIGEST: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn serial<T>(f: impl FnOnce() -> T) -> T {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }

    fn hex32(ptr: *const u8) -> String {
        assert!(!ptr.is_null());
        sha256::hex(unsafe { core::slice::from_raw_parts(ptr, 32) })
    }

    fn write_at(ptr: *mut u8, data: &[u8]) {
        assert!(!ptr.is_null());
        unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len()) };
    }

    /// 把一行字节喂进哈希器（走前端一模一样的调用序列：alloc → update → free）。
    fn feed(data: &[u8]) {
        let buf = sync_video_player_alloc(data.len());
        write_at(buf, data);
        sync_video_player_update(buf, data.len());
        sync_video_player_free(buf, data.len());
    }

    fn read_pair(ptr: *const u8) -> (u64, u64) {
        assert!(!ptr.is_null());
        let b = unsafe { core::slice::from_raw_parts(ptr, 16) };
        let mut off = [0u8; 8];
        let mut len = [0u8; 8];
        off.copy_from_slice(&b[..8]);
        len.copy_from_slice(&b[8..]);
        (u64::from_le_bytes(off), u64::from_le_bytes(len))
    }

    fn fake_data(size: u64) -> Vec<u8> {
        (0..size).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn abi_version_is_exposed() {
        assert_eq!(sync_video_player_version(), ABI_VERSION);
        // 前端会拿这个值对比；改 ABI 时这里必须先失败
        assert_eq!(ABI_VERSION, hashspec::ABI_VERSION);
        assert_eq!(ABI_VERSION, 2);
    }

    #[test]
    fn alloc_returns_writable_memory() {
        serial(|| {
            let buf = sync_video_player_alloc(8);
            write_at(buf, b"abcdefgh");
            let got = unsafe { core::slice::from_raw_parts(buf, 8) };
            assert_eq!(got, b"abcdefgh");
            sync_video_player_free(buf, 8);
            // 长度 0 的申请也要能安全地拿指针、安全地释放
            let empty = sync_video_player_alloc(0);
            sync_video_player_free(empty, 0);
        });
    }

    #[test]
    fn full_hash_matches_nist_vectors() {
        serial(|| {
            sync_video_player_begin_full();
            assert_eq!(hex32(sync_video_player_finish()), EMPTY_DIGEST);

            sync_video_player_begin_full();
            feed(b"abc");
            assert_eq!(hex32(sync_video_player_finish()), ABC_DIGEST);
        });
    }

    #[test]
    fn null_and_empty_updates_are_ignored() {
        serial(|| {
            sync_video_player_begin_full();
            sync_video_player_update(ptr::null(), 16);
            sync_video_player_update(ptr::null(), 0);
            let buf = sync_video_player_alloc(4);
            sync_video_player_update(buf, 0);
            sync_video_player_free(buf, 4);
            assert_eq!(hex32(sync_video_player_finish()), EMPTY_DIGEST);
        });
    }

    #[test]
    fn chunking_does_not_change_the_digest() {
        serial(|| {
            let data = fake_data(5_000);
            sync_video_player_begin_full();
            feed(&data);
            let one_shot = hex32(sync_video_player_finish());

            sync_video_player_begin_full();
            for chunk in data.chunks(777) {
                feed(chunk);
            }
            assert_eq!(hex32(sync_video_player_finish()), one_shot);
        });
    }

    #[test]
    fn small_file_sample_is_a_single_span() {
        serial(|| {
            sync_video_player_begin_sample(1024);
            assert_eq!(sync_video_player_sample_count(), 1);
            assert_eq!(read_pair(sync_video_player_sample_at(0)), (0, 1024));
            assert!(sync_video_player_sample_at(1).is_null(), "越界应返回空指针");
        });
    }

    #[test]
    fn sample_plan_from_abi_is_sorted_and_bounded() {
        serial(|| {
            let size = 12 * 1024 * 1024u64;
            sync_video_player_begin_sample(size);
            let n = sync_video_player_sample_count();
            assert_eq!(n as u64, hashspec::SPOT_COUNT + 1);

            let mut prev_off = 0u64;
            let mut total = 0u64;
            for i in 0..n {
                let (off, len) = read_pair(sync_video_player_sample_at(i));
                assert!(off >= prev_off, "采样点必须按偏移排序");
                assert!(off + len <= size, "采样点不能越过文件末尾");
                prev_off = off;
                total += len;
            }
            assert!(total < 4 * 1024 * 1024, "抽样读取量应保持在 MB 级");
            assert!(sync_video_player_sample_at(n).is_null());
        });
    }

    #[test]
    fn sample_digest_equals_host_implementation() {
        serial(|| {
            let size = 9 * 1024 * 1024u64;
            let data = fake_data(size);

            // 浏览器路径：按 ABI 给出的计划读采样点
            sync_video_player_begin_sample(size);
            for i in 0..sync_video_player_sample_count() {
                let (off, len) = read_pair(sync_video_player_sample_at(i));
                feed(&data[off as usize..(off + len) as usize]);
            }
            let via_abi = hex32(sync_video_player_finish());

            // 主程序路径：同一份 hashspec 源码直接算
            let plan = hashspec::sample_plan(size);
            let mut h = Sha256::new();
            hashspec::feed_sample_header(&mut h, size, &plan);
            for s in &plan {
                h.update(&data[s.offset as usize..(s.offset + s.len) as usize]);
            }
            assert_eq!(via_abi, sha256::hex(&h.finalize()));

            // 抽样摘要与整文件摘要必须不同（域分隔前缀起作用）
            sync_video_player_begin_full();
            feed(&data);
            assert_ne!(hex32(sync_video_player_finish()), via_abi);
        });
    }
}
