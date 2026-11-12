//! `failed_bits`: word `d / 64`, bit `d % 64` (spec S4, S8, S9). Owner: C2.
//!
//! A missing word means all its 64 bits are 0.

use near_sdk::store::LookupMap;

/// Bits per storage word.
const WORD_BITS: u32 = u64::BITS;

/// Sets the bit of day `d`.
pub fn set(bits: &mut LookupMap<u32, u64>, d: u32) {
    let word = bits.entry(d / WORD_BITS).or_insert(0);
    *word |= 1u64 << (d % WORD_BITS);
}

/// Whether the bit of day `d` is set.
pub fn is_set(bits: &LookupMap<u32, u64>, d: u32) -> bool {
    bits.get(&(d / WORD_BITS))
        .is_some_and(|word| word & (1u64 << (d % WORD_BITS)) != 0)
}

/// Number of set bits in `[from, to)` (0 if `from ≥ to`), word by word with masks.
///
/// Reads the words `from / 64 ..= (to − 1) / 64`.
pub fn count(bits: &LookupMap<u32, u64>, from: u32, to: u32) -> u32 {
    if from >= to {
        return 0;
    }
    let last = to - 1;
    let (first_word, last_word) = (from / WORD_BITS, last / WORD_BITS);
    let mut total = 0;
    for index in first_word..=last_word {
        let Some(word) = bits.get(&index) else {
            continue;
        };
        let lo = if index == first_word {
            from % WORD_BITS
        } else {
            0
        };
        let hi = if index == last_word {
            last % WORD_BITS
        } else {
            WORD_BITS - 1
        };
        // Bits lo..=hi; both shifts are by 0..=63.
        let mask = (u64::MAX << lo) & (u64::MAX >> (WORD_BITS - 1 - hi));
        total += (word & mask).count_ones();
    }
    total
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn map(prefix: &[u8]) -> LookupMap<u32, u64> {
        LookupMap::new(prefix.to_vec())
    }

    fn with_days(prefix: &[u8], days: impl IntoIterator<Item = u32>) -> LookupMap<u32, u64> {
        let mut bits = map(prefix);
        for d in days {
            set(&mut bits, d);
        }
        bits
    }

    /// xorshift64 (Marsaglia 13/7/17): deterministic, no crate.
    struct Xorshift(u64);

    impl Xorshift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, n: u32) -> u32 {
            (self.next() % u64::from(n)) as u32
        }
    }

    #[test]
    fn t09_bits_on_word_boundary_63_64_65() {
        let bits = with_days(b"a", [63, 64, 65]);
        // Raw words: day 63 is the top bit of word 0, days 64 and 65 the two low bits of word 1.
        assert_eq!(bits.get(&0), Some(&0x8000_0000_0000_0000));
        assert_eq!(bits.get(&1), Some(&0b11));
        assert_eq!(bits.get(&2), None);

        assert!(!is_set(&bits, 62));
        assert!(is_set(&bits, 63));
        assert!(is_set(&bits, 64));
        assert!(is_set(&bits, 65));
        assert!(!is_set(&bits, 66));
        assert!(!is_set(&bits, 0));
        assert!(!is_set(&bits, 127));
        assert!(!is_set(&bits, 128));

        assert_eq!(count(&bits, 0, 63), 0);
        assert_eq!(count(&bits, 0, 64), 1);
        assert_eq!(count(&bits, 63, 64), 1);
        assert_eq!(count(&bits, 64, 65), 1);
        assert_eq!(count(&bits, 63, 65), 2);
        assert_eq!(count(&bits, 64, 66), 2);
        assert_eq!(count(&bits, 65, 66), 1);
        assert_eq!(count(&bits, 62, 66), 3);
        assert_eq!(count(&bits, 66, 128), 0);
        assert_eq!(count(&bits, 0, 1000), 3);
    }

    #[test]
    fn t09_bits_single_boundary_days() {
        for (d, word, value) in [(63u32, 0u32, 1u64 << 63), (64, 1, 1), (65, 1, 2)] {
            let bits = with_days(&[b'b', d as u8], [d]);
            assert_eq!(bits.get(&word), Some(&value), "day {d}");
            assert_eq!(count(&bits, 0, 200), 1, "day {d}");
            assert_eq!(count(&bits, d, d + 1), 1, "day {d}");
            assert_eq!(count(&bits, 0, d), 0, "day {d}");
            assert_eq!(count(&bits, d + 1, 200), 0, "day {d}");
            assert!(is_set(&bits, d));
            assert!(!is_set(&bits, d - 1) && !is_set(&bits, d + 1));
        }
    }

    #[test]
    fn t09_count_within_one_word() {
        let bits = with_days(b"c", [3, 5, 10, 40]);
        assert_eq!(
            bits.get(&0),
            Some(&((1 << 3) | (1 << 5) | (1 << 10) | (1 << 40)))
        );
        assert_eq!(count(&bits, 3, 4), 1);
        assert_eq!(count(&bits, 4, 10), 1);
        assert_eq!(count(&bits, 4, 11), 2);
        assert_eq!(count(&bits, 0, 64), 4);
        assert_eq!(count(&bits, 11, 40), 0);
        assert_eq!(count(&bits, 11, 41), 1);
        assert_eq!(count(&bits, 3, 41), 4);
        assert_eq!(count(&bits, 6, 10), 0);
    }

    #[test]
    fn t09_count_across_several_words() {
        // Words 0, 1, 2, 3 and 4; word 5 missing; word 6 present.
        let bits = with_days(b"d", [10, 70, 130, 190, 200, 255, 256, 400]);
        assert_eq!(count(&bits, 10, 257), 7);
        assert_eq!(count(&bits, 11, 256), 5);
        assert_eq!(count(&bits, 64, 128), 1);
        assert_eq!(count(&bits, 0, 192), 4);
        assert_eq!(count(&bits, 191, 256), 2);
        assert_eq!(count(&bits, 257, 400), 0);
        assert_eq!(count(&bits, 257, 401), 1);
        assert_eq!(count(&bits, 0, 448), 8);
    }

    #[test]
    fn t09_count_long_ranges() {
        // Every third day in [0, 1500): 500 days.
        let bits = with_days(b"e", (0..1500).step_by(3));
        assert_eq!(count(&bits, 0, 1500), 500);
        assert_eq!(count(&bits, 1, 1500), 499);
        assert_eq!(count(&bits, 0, 1000), 334); // 0, 3, …, 999
        assert_eq!(count(&bits, 100, 1100), 333); // 102, 105, …, 1098
        assert_eq!(count(&bits, 0, 5000), 500);

        // Every day in [0, 2048): full middle words.
        let full = with_days(b"f", 0..2048);
        assert_eq!(full.get(&5), Some(&u64::MAX));
        assert_eq!(count(&full, 0, 2048), 2048);
        assert_eq!(count(&full, 1, 2047), 2046);
        assert_eq!(count(&full, 5, 1205), 1200);
        assert_eq!(count(&full, 2000, 3000), 48);
    }

    #[test]
    fn t09_count_empty_and_reversed_range() {
        let bits = with_days(b"g", [0, 63, 64, 1000]);
        for d in [0, 63, 64, 65, 1000, u32::MAX] {
            assert_eq!(count(&bits, d, d), 0, "from == to == {d}");
        }
        assert_eq!(count(&bits, 65, 64), 0);
        assert_eq!(count(&bits, u32::MAX, 0), 0);
        assert_eq!(count(&map(b"h"), 0, 10_000), 0);
    }

    #[test]
    fn t09_set_is_idempotent_and_keeps_neighbours() {
        let mut bits = with_days(b"i", [7, 9]);
        set(&mut bits, 7);
        set(&mut bits, 8);
        assert_eq!(bits.get(&0), Some(&0b11_1000_0000));
        assert_eq!(count(&bits, 0, 64), 3);
    }

    #[test]
    fn t09_top_of_the_day_range() {
        let mut bits = with_days(b"j", [u32::MAX]);
        // Word 2^26 − 1, bit 63.
        assert_eq!(bits.get(&67_108_863), Some(&(1 << 63)));
        assert!(is_set(&bits, u32::MAX));
        assert!(!is_set(&bits, u32::MAX - 1));
        // `to` is exclusive, so day u32::MAX is never counted.
        assert_eq!(count(&bits, u32::MAX - 64, u32::MAX), 0);
        set(&mut bits, u32::MAX - 1);
        set(&mut bits, u32::MAX - 64);
        assert_eq!(count(&bits, u32::MAX - 64, u32::MAX), 2);
        assert_eq!(count(&bits, u32::MAX - 200, u32::MAX), 2);
    }

    #[test]
    fn t09_bits_persist_in_storage() {
        let mut bits = with_days(b"k", [5, 64, 700]);
        bits.flush();
        let reloaded = map(b"k");
        assert!(is_set(&reloaded, 5) && is_set(&reloaded, 64) && is_set(&reloaded, 700));
        assert!(!is_set(&reloaded, 6));
        assert_eq!(count(&reloaded, 0, 701), 3);
    }

    #[test]
    fn t09_count_matches_a_naive_model() {
        // Independent model: a set of days, counted one by one.
        let mut rng = Xorshift(0x9B17);
        for round in 0..20u8 {
            let mut bits = map(&[b'm', round]);
            let mut days = BTreeSet::new();
            let span = 64 + rng.below(1500);
            for _ in 0..rng.below(span) {
                let d = rng.below(span);
                set(&mut bits, d);
                days.insert(d);
            }
            for d in 0..span {
                assert_eq!(
                    is_set(&bits, d),
                    days.contains(&d),
                    "round {round}, day {d}"
                );
            }
            for _ in 0..300 {
                let from = rng.below(span + 64);
                let to = from + rng.below(span + 64 - from + 1);
                let expected = days.range(from..to).count() as u32;
                assert_eq!(
                    count(&bits, from, to),
                    expected,
                    "round {round}, [{from}, {to})"
                );
            }
        }
    }
}
