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
