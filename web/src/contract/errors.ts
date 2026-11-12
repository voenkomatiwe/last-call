// Plain-language messages for the contract's `ERR_*` codes (`contract/src/errors.rs`,
// `contract/API.md` "Errors"). A test keeps this list equal to the contract's.

export const CONTRACT_ERROR_MESSAGES = {
  ERR_NOT_MEMBER: "This account is not a member of the game.",
  ERR_ALREADY_MEMBER: "This account is already a member.",
  ERR_WARMUP: "Still in warm-up: check-ins open on your activation day.",
  ERR_ALREADY_CHECKED_IN: "Already checked in today.",
  ERR_BACKLOG: "Too many days wait to be settled. Settle them first, then try again.",
  ERR_LOW_GAS: "Not enough gas for the hero draw. Send it again with more gas.",
  ERR_NOT_REGISTERED: "Register for the $LAST token first.",
  ERR_INSUFFICIENT_BALANCE: "Not enough $LAST for the stake.",
  ERR_STORAGE_DEPOSIT: "The attached NEAR does not cover the member storage deposit.",
  ERR_NOTHING_TO_CLAIM: "Nothing to claim yet.",
  ERR_ONE_YOCTO: "This call needs exactly 1 yoctoNEAR attached.",
  ERR_FAUCET_DISABLED: "The faucet is off on this deployment.",
  ERR_FAUCET_USED: "This account already used the faucet.",
  ERR_FAUCET_EMPTY: "The faucet is empty.",
  ERR_MEMBER_CANNOT_UNREGISTER: "Leave the game before closing the token account.",
  ERR_USE_JOIN: "Tokens cannot be sent to the contract; use Join.",
  ERR_BAD_CONFIG: "Invalid deployment parameters.",
  ERR_NO_CHECKIN_KEY: "No check-in key is registered for this account.",
  ERR_BAD_SIGNATURE: "The check-in signature is not valid.",
  ERR_BAD_DAY: "The signed check-in is for another day.",
  ERR_BAD_KEY: "The check-in key must be an ed25519 key.",
  ERR_NOT_INACTIVE: "This member cannot be kicked yet.",
  ERR_NO_PENDING_HERO: "No hero draw is pending for that day.",
} as const satisfies Record<`ERR_${string}`, string>;

export type ContractErrorCode = keyof typeof CONTRACT_ERROR_MESSAGES;

/** Finds the contract's `ERR_*` code in any error text (wallet, near-api-js, or RPC). */
export function contractErrorCode(text: string): ContractErrorCode | undefined {
  for (const match of text.matchAll(/\bERR_[A-Z0-9_]+/g)) {
    if (match[0] in CONTRACT_ERROR_MESSAGES) return match[0] as ContractErrorCode;
  }
  return undefined;
}

/** A message for the user: the contract's error in plain words, or the original text. */
export function describeContractError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = contractErrorCode(text);
  return code ? CONTRACT_ERROR_MESSAGES[code] : text;
}
