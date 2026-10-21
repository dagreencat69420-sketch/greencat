//! Deterministic rarity table matching demo `nftCatalog.ts`.
//! Seed: `greencat-meme-collection-v1` · Fisher–Yates via mulberry32 (JS parity).

pub const COLLECTION_SIZE: u16 = 10_000;
pub const CATALOG_SEED: &str = "greencat-meme-collection-v1";

pub const RARITY_COMMON: u8 = 0;
pub const RARITY_UNCOMMON: u8 = 1;
pub const RARITY_RARE: u8 = 2;
pub const RARITY_LEGENDARY: u8 = 3;

pub const COUNT_LEGENDARY: usize = 100;
pub const COUNT_RARE: usize = 900;
pub const COUNT_UNCOMMON: usize = 2_000;
pub const COUNT_COMMON: usize = 7_000;

pub fn hash_seed(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s.bytes() {
        h ^= b as u32;
        h = (h as i32).wrapping_mul(16777619) as u32;
    }
    h
}

/// Mulberry32 step returning the raw u32 (equivalent to JS `((t ^ (t>>>14)) >>> 0)`).
pub fn mulberry32_u32(state: &mut u32) -> u32 {
    let a = (*state as i32).wrapping_add(0x6d2b79f5_u32 as i32);
    *state = a as u32;
    let a_u = a as u32;
    let mut t = ((a_u ^ (a_u >> 15)) as i32).wrapping_mul(1 | a);
    let t_u = t as u32;
    let imul2 = ((t_u ^ (t_u >> 7)) as i32).wrapping_mul(61 | t);
    t = t.wrapping_add(imul2) ^ t;
    (t as u32) ^ ((t as u32) >> 14)
}

pub fn mulberry32_next(state: &mut u32) -> f64 {
    (mulberry32_u32(state) as f64) / 4294967296.0
}

/// `Math.floor(rng() * n)` via integer multiply — matches IEEE for this PRNG.
#[inline(always)]
pub fn floor_mul(rand_u32: u32, n: u32) -> u32 {
    ((rand_u32 as u64 * n as u64) >> 32) as u32
}

/// Fill `out` (len >= 10000) with shuffled rarity table in-place.
pub fn fill_rarity_table_into(out: &mut [u8]) {
    assert!(out.len() >= COLLECTION_SIZE as usize);
    let n = COLLECTION_SIZE as usize;
    let mut i = 0usize;
    for _ in 0..COUNT_LEGENDARY {
        out[i] = RARITY_LEGENDARY;
        i += 1;
    }
    for _ in 0..COUNT_RARE {
        out[i] = RARITY_RARE;
        i += 1;
    }
    for _ in 0..COUNT_UNCOMMON {
        out[i] = RARITY_UNCOMMON;
        i += 1;
    }
    for _ in 0..COUNT_COMMON {
        out[i] = RARITY_COMMON;
        i += 1;
    }
    let mut state = hash_seed(CATALOG_SEED);
    for i in (1..n).rev() {
        let r = mulberry32_u32(&mut state);
        let j = floor_mul(r, (i + 1) as u32) as usize;
        out.swap(i, j);
    }
}

pub fn build_rarity_table() -> Vec<u8> {
    let mut table = vec![0u8; COLLECTION_SIZE as usize];
    fill_rarity_table_into(&mut table);
    table
}

pub fn get_token_rarity(token_id: u16) -> Option<u8> {
    if !(1..=COLLECTION_SIZE).contains(&token_id) {
        return None;
    }
    Some(build_rarity_table()[(token_id - 1) as usize])
}

pub fn rarity_label(r: u8) -> &'static str {
    match r {
        RARITY_LEGENDARY => "legendary",
        RARITY_RARE => "rare",
        RARITY_UNCOMMON => "uncommon",
        _ => "common",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_hash_matches_demo() {
        assert_eq!(hash_seed(CATALOG_SEED), 3574348136);
    }

    #[test]
    fn integer_floor_matches_float() {
        let mut s1 = hash_seed(CATALOG_SEED);
        let mut s2 = hash_seed(CATALOG_SEED);
        for i in (1..10000).rev() {
            let u = mulberry32_u32(&mut s1);
            let f = mulberry32_next(&mut s2);
            let j_int = floor_mul(u, (i + 1) as u32) as usize;
            let j_float = (f * ((i + 1) as f64)).floor() as usize;
            assert_eq!(j_int, j_float, "mismatch at i={}", i);
        }
    }

    #[test]
    fn rarity_parity_sample_ids() {
        let expect: &[(u16, u8)] = &[
            (1, RARITY_COMMON),
            (2, RARITY_COMMON),
            (3, RARITY_COMMON),
            (42, RARITY_RARE),
            (100, RARITY_UNCOMMON),
            (500, RARITY_UNCOMMON),
            (1000, RARITY_COMMON),
            (5000, RARITY_RARE),
            (9999, RARITY_COMMON),
            (10000, RARITY_COMMON),
        ];
        let table = build_rarity_table();
        for &(id, r) in expect {
            assert_eq!(table[(id - 1) as usize], r);
        }
    }

    #[test]
    fn rarity_counts() {
        let table = build_rarity_table();
        let mut counts = [0usize; 4];
        for r in &table {
            counts[*r as usize] += 1;
        }
        assert_eq!(counts[RARITY_LEGENDARY as usize], COUNT_LEGENDARY);
        assert_eq!(counts[RARITY_RARE as usize], COUNT_RARE);
        assert_eq!(counts[RARITY_UNCOMMON as usize], COUNT_UNCOMMON);
        assert_eq!(counts[RARITY_COMMON as usize], COUNT_COMMON);
    }
}
