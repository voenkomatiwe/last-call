//! Error strings (spec S16). Each value equals its name; the TS side matches by the `ERR_` prefix.
//! Raise them with `require!(cond, ERR_...)` or `env::panic_str(ERR_...)`.

pub const ERR_NOT_MEMBER: &str = "ERR_NOT_MEMBER";
pub const ERR_ALREADY_MEMBER: &str = "ERR_ALREADY_MEMBER";
pub const ERR_WARMUP: &str = "ERR_WARMUP";
pub const ERR_ALREADY_CHECKED_IN: &str = "ERR_ALREADY_CHECKED_IN";
pub const ERR_BACKLOG: &str = "ERR_BACKLOG";
pub const ERR_LOW_GAS: &str = "ERR_LOW_GAS";
pub const ERR_NOT_REGISTERED: &str = "ERR_NOT_REGISTERED";
pub const ERR_INSUFFICIENT_BALANCE: &str = "ERR_INSUFFICIENT_BALANCE";
pub const ERR_STORAGE_DEPOSIT: &str = "ERR_STORAGE_DEPOSIT";
pub const ERR_NOTHING_TO_CLAIM: &str = "ERR_NOTHING_TO_CLAIM";
pub const ERR_ONE_YOCTO: &str = "ERR_ONE_YOCTO";
pub const ERR_FAUCET_DISABLED: &str = "ERR_FAUCET_DISABLED";
pub const ERR_FAUCET_USED: &str = "ERR_FAUCET_USED";
pub const ERR_FAUCET_EMPTY: &str = "ERR_FAUCET_EMPTY";
pub const ERR_MEMBER_CANNOT_UNREGISTER: &str = "ERR_MEMBER_CANNOT_UNREGISTER";
pub const ERR_USE_JOIN: &str = "ERR_USE_JOIN";
pub const ERR_BAD_CONFIG: &str = "ERR_BAD_CONFIG";
pub const ERR_NO_CHECKIN_KEY: &str = "ERR_NO_CHECKIN_KEY";
pub const ERR_BAD_SIGNATURE: &str = "ERR_BAD_SIGNATURE";
pub const ERR_BAD_DAY: &str = "ERR_BAD_DAY";
pub const ERR_BAD_KEY: &str = "ERR_BAD_KEY";
pub const ERR_NOT_INACTIVE: &str = "ERR_NOT_INACTIVE";
pub const ERR_NO_PENDING_HERO: &str = "ERR_NO_PENDING_HERO";

#[cfg(test)]
mod tests {
    use super::*;

    /// Every constant of S16 exists and its value equals its name (the TS side matches strings).
    #[test]
    fn error_values_equal_names() {
        let all = [
            (ERR_NOT_MEMBER, "ERR_NOT_MEMBER"),
            (ERR_ALREADY_MEMBER, "ERR_ALREADY_MEMBER"),
            (ERR_WARMUP, "ERR_WARMUP"),
            (ERR_ALREADY_CHECKED_IN, "ERR_ALREADY_CHECKED_IN"),
            (ERR_BACKLOG, "ERR_BACKLOG"),
            (ERR_LOW_GAS, "ERR_LOW_GAS"),
            (ERR_NOT_REGISTERED, "ERR_NOT_REGISTERED"),
            (ERR_INSUFFICIENT_BALANCE, "ERR_INSUFFICIENT_BALANCE"),
            (ERR_STORAGE_DEPOSIT, "ERR_STORAGE_DEPOSIT"),
            (ERR_NOTHING_TO_CLAIM, "ERR_NOTHING_TO_CLAIM"),
            (ERR_ONE_YOCTO, "ERR_ONE_YOCTO"),
            (ERR_FAUCET_DISABLED, "ERR_FAUCET_DISABLED"),
            (ERR_FAUCET_USED, "ERR_FAUCET_USED"),
            (ERR_FAUCET_EMPTY, "ERR_FAUCET_EMPTY"),
            (ERR_MEMBER_CANNOT_UNREGISTER, "ERR_MEMBER_CANNOT_UNREGISTER"),
            (ERR_USE_JOIN, "ERR_USE_JOIN"),
            (ERR_BAD_CONFIG, "ERR_BAD_CONFIG"),
            (ERR_NO_CHECKIN_KEY, "ERR_NO_CHECKIN_KEY"),
            (ERR_BAD_SIGNATURE, "ERR_BAD_SIGNATURE"),
            (ERR_BAD_DAY, "ERR_BAD_DAY"),
            (ERR_BAD_KEY, "ERR_BAD_KEY"),
            (ERR_NOT_INACTIVE, "ERR_NOT_INACTIVE"),
            (ERR_NO_PENDING_HERO, "ERR_NO_PENDING_HERO"),
        ];
        assert_eq!(all.len(), 23);
        for (value, name) in all {
            assert_eq!(value, name);
        }
    }
}
