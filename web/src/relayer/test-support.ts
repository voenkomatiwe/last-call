import { checkInPayload, formatEd25519PublicKey, hashNep413Payload } from "../checkin/nep413";
import vectorsFile from "../checkin/nep413-vectors.json";
import { bytesToBase64, hexToBytes } from "../near/encoding";
import {
  type CheckInGateway,
  type CheckInResult,
  type CheckInSubmission,
  type CheckinKeyLookup,
  ContractCallError,
} from "./check-in-relayer";

// Test helpers: a signer with the public RFC 8032 test key and a scriptable gateway.

export const CONTRACT_ID = "lastcall.testnet";
export const PUBLIC_KEY = vectorsFile.key.public_key;

const privateKey = crypto.subtle.importKey(
  "pkcs8",
  hexToBytes(`302e020100300506032b657004220420${vectorsFile.key.seed_hex}`),
  { name: "Ed25519" },
  false,
  ["sign"]
);

export async function signedRequest(accountId: string, day: number, options: { recipient?: string } = {}) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const payload = checkInPayload({ accountId, day, nonce, contractId: options.recipient ?? CONTRACT_ID });
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, await privateKey, await hashNep413Payload(payload))
  );
  return { account_id: accountId, day, nonce: bytesToBase64(nonce), signature: bytesToBase64(signature) };
}

export function otherPublicKey(): string {
  return formatEd25519PublicKey(hexToBytes("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"));
}

type Respond = (submission: CheckInSubmission) => Promise<CheckInResult>;

export class FakeGateway implements CheckInGateway {
  readonly contractId = CONTRACT_ID;
  today = 7;
  keys = new Map<string, CheckinKeyLookup>();
  readonly submissions: CheckInSubmission[] = [];
  respond: Respond = async (submission) => ({
    day: submission.day,
    n: this.submissions.length,
    goal: 5,
    in_closers: false,
  });

  member(
    accountId: string,
    publicKey: string = PUBLIC_KEY,
    state: { isActive?: boolean; checkedInToday?: boolean } = {}
  ): this {
    this.keys.set(accountId, {
      kind: "key",
      publicKey,
      isActive: state.isActive ?? true,
      checkedInToday: state.checkedInToday ?? false,
    });
    return this;
  }

  async getToday(): Promise<number> {
    return this.today;
  }

  async getCheckinKey(accountId: string): Promise<CheckinKeyLookup> {
    return this.keys.get(accountId) ?? { kind: "not-member" };
  }

  submitCheckIn(submission: CheckInSubmission): Promise<CheckInResult> {
    this.submissions.push(submission);
    return this.respond(submission);
  }
}

export function contractError(code: string): ContractCallError {
  return new ContractCallError(code);
}

/** A promise that the test resolves or rejects by hand. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
