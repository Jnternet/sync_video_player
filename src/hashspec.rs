//! 哈希规范：抽样指纹的采样计划与摘要编码。
//!
//! 这份实现被**主程序**（`sync_video_player hash --sample`）和 **WASM 模块**（浏览器本地计算）
//! 通过 `#[path]` 共用，保证两条路径算出的摘要永远一致，不会各写一版而漂移。

use crate::sha256::Sha256;
use std::vec::Vec;

/// 抽样摘要的域分隔前缀：避免与整文件摘要或其他用途的摘要混淆。
pub const SAMPLE_DOMAIN: &[u8] = b"RTEST-SAMPLE-V1\n";
/// 头部采样长度
pub const HEAD_SAMPLE: u64 = 1024 * 1024;
/// 均匀采样点长度
pub const SPOT_SAMPLE: u64 = 64 * 1024;
/// 均匀采样点数量
pub const SPOT_COUNT: u64 = 8;
/// 小于这个尺寸就直接整文件哈希，抽样没有意义
pub const SAMPLE_MIN_SIZE: u64 = 8 * 1024 * 1024;

/// WASM 模块的 ABI 版本，前后端不一致时前端会拒绝使用。
pub const ABI_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub offset: u64,
    pub len: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Full,
    Sample,
}

#[allow(dead_code)]
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Sample => "sample",
        }
    }

    pub fn parse(s: &str) -> Mode {
        match s {
            "sample" | "fast" => Mode::Sample,
            _ => Mode::Full,
        }
    }
}

/// 抽样计划：头部 + 均匀分布的若干采样点 + 尾部，按偏移排序。
///
/// 小文件退化成「整文件一个样本」，调用方应视为整文件哈希。
pub fn sample_plan(size: u64) -> Vec<Sample> {
    if size <= SAMPLE_MIN_SIZE {
        return vec![Sample { offset: 0, len: size }];
    }
    let mut plan = vec![Sample {
        offset: 0,
        len: HEAD_SAMPLE.min(size),
    }];
    for i in 1..SPOT_COUNT {
        let mut offset = size / SPOT_COUNT * i;
        if offset + SPOT_SAMPLE > size {
            offset = size.saturating_sub(SPOT_SAMPLE);
        }
        plan.push(Sample {
            offset,
            len: SPOT_SAMPLE,
        });
    }
    plan.push(Sample {
        offset: size.saturating_sub(HEAD_SAMPLE),
        len: HEAD_SAMPLE.min(size),
    });
    plan.sort_by_key(|s| s.offset);
    plan
}

/// 摘要前半段：域前缀 + 文件长度 + 每个采样点的 offset/len。
/// 之后按计划顺序喂入各采样点的数据即可。
pub fn feed_sample_header(hasher: &mut Sha256, size: u64, plan: &[Sample]) {
    hasher.update(SAMPLE_DOMAIN);
    hasher.update(&size.to_le_bytes());
    for s in plan {
        hasher.update(&s.offset.to_le_bytes());
        hasher.update(&s.len.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sha256::hex;

    #[test]
    fn small_file_plan_is_single_sample() {
        let plan = sample_plan(1024);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].offset, 0);
        assert_eq!(plan[0].len, 1024);
    }

    #[test]
    fn plan_is_sorted_and_inside_file() {
        let size = 100 * 1024 * 1024;
        let plan = sample_plan(size);
        // 头部 1 个 + 中间 SPOT_COUNT-1 个 + 尾部 1 个
        assert_eq!(plan.len(), (SPOT_COUNT + 1) as usize);
        for w in plan.windows(2) {
            assert!(w[0].offset <= w[1].offset, "采样点必须按偏移排序");
        }
        for s in &plan {
            assert!(s.offset + s.len <= size, "采样点不能越过文件末尾");
        }
        assert!(
            plan.iter().map(|s| s.len).sum::<u64>() < 4 * 1024 * 1024,
            "抽样读取量应保持在 MB 级"
        );
    }

    #[test]
    fn sample_digest_is_stable_and_sensitive() {
        let size = 16 * 1024 * 1024u64;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let digest = |data: &[u8]| {
            let plan = sample_plan(size);
            let mut h = Sha256::new();
            feed_sample_header(&mut h, size, &plan);
            for s in &plan {
                h.update(&data[s.offset as usize..(s.offset + s.len) as usize]);
            }
            hex(&h.finalize())
        };
        assert_eq!(digest(&data), digest(&data));
        let mut changed = data.clone();
        changed[(size / 2) as usize] ^= 0xff;
        assert_ne!(digest(&data), digest(&changed));
    }
}
