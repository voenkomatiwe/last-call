import { canVerifyEd25519 } from "../checkin/ed25519-support";
import { checkInPayload, parseEd25519PublicKey, verifyNep413Signature } from "../checkin/nep413";
import { isValidAccountId } from "../near/account-id";
import { base64ToBytes, bytesToBase64 } from "../near/encoding";

// The relayer of signed check-ins (plan section 4.10). It cannot forge a check-in: the contract
// verifies the signature itself. It can refuse to send one or change the order, which is why the
// direct `check_in()` call must keep working without it.

/** `CheckInResult` of the contract (plan section 4.5). */
export interface CheckInResult {
  readonly day: number;
  readonly n: number;
  readonly goal: number;
  readonly in_closers: boolean;
}

export type CheckinKeyLookup =
  | { readonly kind: "not-member" }
  | { readonly kind: "no-key" }
  | { readonly kind: "key"; readonly publicKey: string };

/** A contract failure with the `ERR_...` code the contract panicked with (plan section 4.7). */
export class ContractCallError extends Error {
  override readonly name = "ContractCallError";
  constructor(readonly code: string) {
    super(code);
  }
}

/** The chain side of the relayer. The NEAR adapter implements it; tests use a fake. */
export interface CheckInGateway {
  /** The contract account: the NEP-413 recipient of every check-in message. */
  readonly contractId: string;
  /** The current day as the contract counts it. */
  getToday(): Promise<number>;
  getCheckinKey(accountId: string): Promise<CheckinKeyLookup>;
  /**
   * Sends `check_in_signed`. With `settleFirst`, sends `settle` and `check_in_signed` as two
   * actions of one transaction. Throws `ContractCallError` when the contract refuses.
   */
  submitCheckIn(submission: CheckInSubmission): Promise<CheckInResult>;
}

export interface CheckInSubmission {
  readonly accountId: string;
  readonly day: number;
  readonly nonceBase64: string;
  readonly signatureBase64: string;
  readonly settleFirst: boolean;
}

export type RelayErrorCode =
  | "INVALID_REQUEST"
  | "ERR_BAD_DAY"
  | "ERR_NOT_MEMBER"
  | "ERR_NO_CHECKIN_KEY"
  | "ERR_BAD_SIGNATURE"
  | "ALREADY_SUBMITTED"
  | "CONTRACT_ERROR"
  | "RELAYER_FAILED";

export type RelayOutcome =
  | { readonly ok: true; readonly result: CheckInResult }
  | {
      readonly ok: false;
      readonly code: RelayErrorCode;
      /** The contract's own code when `code` is `CONTRACT_ERROR`. */
      readonly contractCode?: string;
      /** The contract's current day when the request was for another day. */
      readonly today?: number;
      readonly message: string;
    };

interface ValidRequest {
  readonly accountId: string;
  readonly day: number;
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
}

const MAX_DAY = 0xffff_ffff;

function decodeBytes(value: unknown, length: number): Uint8Array | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const bytes = base64ToBytes(value);
    return bytes.length === length ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Validates the untrusted request body: `{ account_id, day, nonce, signature }`, bytes in base64. */
export function parseCheckInRequest(body: unknown): ValidRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { account_id, day, nonce, signature } = body as Record<string, unknown>;

  if (typeof account_id !== "string" || !isValidAccountId(account_id)) return undefined;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > MAX_DAY) return undefined;
  const nonceBytes = decodeBytes(nonce, 32);
  const signatureBytes = decodeBytes(signature, 64);
  if (!nonceBytes || !signatureBytes) return undefined;

  return { accountId: account_id, day, nonce: nonceBytes, signature: signatureBytes };
}

function refuse(code: RelayErrorCode, message: string, extra: { contractCode?: string; today?: number } = {}) {
  return { ok: false as const, code, message, ...extra };
}

export class CheckInRelayer {
  /** `account:day` of submissions that are pending or have succeeded. */
  private readonly submitted = new Set<string>();
  /**
   * Resolves when the most recently arrived request is out of the way: submitted, refused, or
   * failed. Each request waits for the one that arrived before it, so the chain sees check-ins in
   * arrival order even though their checks run concurrently. Order decides who is in the closing
   * five, so it must not depend on which RPC lookup happens to return first.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly gateway: CheckInGateway) {}

  async relay(body: unknown): Promise<RelayOutcome> {
    // Take a place in line on arrival, before the first await.
    const turn = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hadTurn = false;

    try {
      const checked = await this.check(body);
      if (!("request" in checked)) return checked;
      const { request } = checked;

      // No await between this check and the reservation: two requests cannot both pass it.
      const reservation = `${request.accountId}:${request.day}`;
      if (this.submitted.has(reservation)) {
        return refuse(
          "ALREADY_SUBMITTED",
          `A check-in for ${request.accountId} on day ${request.day} was already sent`
        );
      }
      this.submitted.add(reservation);

      await turn;
      hadTurn = true;
      try {
        const result = await this.submit({
          accountId: request.accountId,
          day: request.day,
          // Re-encoded: the input may be valid but non-canonical base64.
          nonceBase64: bytesToBase64(request.nonce),
          signatureBase64: bytesToBase64(request.signature),
        });
        return { ok: true, result };
      } catch (error) {
        this.submitted.delete(reservation);
        if (error instanceof ContractCallError) {
          return refuse("CONTRACT_ERROR", `The contract refused the check-in: ${error.code}`, {
            contractCode: error.code,
          });
        }
        throw error;
      }
    } finally {
      // A request that never reached its turn must still not let later ones pass earlier ones.
      if (hadTurn) release();
      else void turn.then(release);
    }
  }

  /** Every refusal the backend can decide on its own, before anything is sent. */
  private async check(body: unknown): Promise<RelayOutcome | { readonly request: ValidRequest }> {
    const request = parseCheckInRequest(body);
    if (!request) {
      return refuse(
        "INVALID_REQUEST",
        "Expected { account_id, day, nonce, signature } with base64 nonce and signature"
      );
    }

    // A false negative here would blame the user's signature for a server problem.
    if (!(await canVerifyEd25519())) throw new Error("This runtime cannot verify ed25519 signatures");

    const today = await this.gateway.getToday();
    if (request.day !== today) {
      return refuse("ERR_BAD_DAY", `The check-in is for day ${request.day}, today is day ${today}`, { today });
    }

    const lookup = await this.gateway.getCheckinKey(request.accountId);
    if (lookup.kind === "not-member") return refuse("ERR_NOT_MEMBER", `${request.accountId} is not a member`);
    if (lookup.kind === "no-key") {
      return refuse("ERR_NO_CHECKIN_KEY", `${request.accountId} has no check-in key; check in directly instead`);
    }

    const payload = checkInPayload({
      accountId: request.accountId,
      day: request.day,
      nonce: request.nonce,
      contractId: this.gateway.contractId,
    });
    const publicKey = parseEd25519PublicKey(lookup.publicKey);
    if (!(await verifyNep413Signature({ payload, signature: request.signature, publicKey }))) {
      return refuse("ERR_BAD_SIGNATURE", "The signature does not match the member's check-in key");
    }
    return { request };
  }

  private async submit(submission: Omit<CheckInSubmission, "settleFirst">): Promise<CheckInResult> {
    try {
      return await this.gateway.submitCheckIn({ ...submission, settleFirst: false });
    } catch (error) {
      // More than AUTO_SETTLE_CAP days are pending: settle in the same transaction. This is safe
      // because the outcome of settle does not depend on the random seed (plan section 4.9).
      if (error instanceof ContractCallError && error.code === "ERR_BACKLOG") {
        return this.gateway.submitCheckIn({ ...submission, settleFirst: true });
      }
      throw error;
    }
  }
}
