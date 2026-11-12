import { type Account, actions, getTransactionLastResult } from "near-api-js";

import { checkInSignedCall, settleCall } from "../contract/calls";
import { contractErrorCode } from "../contract/errors";
import type { ContractReader } from "../contract/reader";
import { parseCheckInResult } from "../contract/views";
import {
  type CheckInGateway,
  type CheckInResult,
  type CheckInSubmission,
  type CheckinKeyLookup,
  ContractCallError,
} from "./check-in-relayer";

// The NEAR side of the relayer (plan 4.10): reads through the typed views, sends `check_in_signed`
// from the relayer account, which pays the gas. It never holds a member's key.

/**
 * Gas when `settle` runs first in the same transaction (more than `auto_settle_cap` days pending):
 * a 500-day settle burnt 45.7 Tgas in the contract's sandbox suite, and the check-in needs ≈ 2 Tgas
 * plus 15 Tgas kept for a hero draw. Together they stay under the 300 Tgas a transaction may attach.
 */
const SETTLE_FIRST_GAS = 200n * 10n ** 12n;
/** Longer than a few blocks plus RPC retries; short enough not to stall the queue for long. */
const SEND_TIMEOUT_MS = 30_000;

export class NearCheckInGateway implements CheckInGateway {
  constructor(
    private readonly reader: ContractReader,
    private readonly relayer: Account
  ) {}

  get contractId(): string {
    return this.reader.contractId;
  }

  async getToday(): Promise<number> {
    return (await this.reader.state()).today;
  }

  async getCheckinKey(accountId: string): Promise<CheckinKeyLookup> {
    const member = await this.reader.member(accountId);
    if (!member) return { kind: "not-member" };
    if (!member.checkinKey) return { kind: "no-key" };
    return { kind: "key", publicKey: member.checkinKey };
  }

  async submitCheckIn(submission: CheckInSubmission): Promise<CheckInResult> {
    const checkIn = checkInSignedCall({
      accountId: submission.accountId,
      day: submission.day,
      nonceBase64: submission.nonceBase64,
      signatureBase64: submission.signatureBase64,
    });
    const settle = settleCall();
    const functionCalls = [
      ...(submission.settleFirst ? [actions.functionCall(settle.methodName, settle.args, SETTLE_FIRST_GAS, 0n)] : []),
      actions.functionCall(checkIn.methodName, checkIn.args, BigInt(checkIn.gas), 0n),
    ];

    let outcome: Awaited<ReturnType<Account["signAndSendTransaction"]>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Submissions are serialized: one hung RPC call must not hold every later check-in. On a timeout
    // the transaction may still land; a retry then gets ERR_ALREADY_CHECKED_IN from the contract.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`check_in_signed was not confirmed in ${SEND_TIMEOUT_MS} ms`)),
        SEND_TIMEOUT_MS
      );
    });
    try {
      outcome = await Promise.race([
        this.relayer.signAndSendTransaction({ receiverId: this.contractId, actions: functionCalls }),
        timeout,
      ]);
    } catch (error) {
      const code = contractErrorCode(error instanceof Error ? error.message : String(error));
      if (code) throw new ContractCallError(code);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const result = parseCheckInResult(getTransactionLastResult(outcome));
    return { day: result.day, n: result.n, goal: result.goal, in_closers: result.inClosers };
  }
}
