import { describe, expect, test } from "bun:test";

import {
  AccountDoesNotExistError,
  ContractCodeDoesNotExistError,
  ContractMethodNotFoundError,
} from "near-api-js/rpc-errors";

import { loadNearConfig } from "./near-config";
import { callView, contractPanic, createViewProvider } from "./view";

// Talks to the live testnet RPC. Run with:
//   LAST_CALL_RPC_INTEGRATION=1 bun test web/src/near/view.integration.test.ts
// `wrap.testnet` is the long-lived wrapped NEAR token; `dev.testnet` is an account without a contract.
const enabled = process.env.LAST_CALL_RPC_INTEGRATION === "1";
const provider = createViewProvider(loadNearConfig({ NEXT_PUBLIC_CONTRACT_ID: "wrap.testnet" }).rpcUrl);

async function viewError(contractId: string, method: string): Promise<unknown> {
  try {
    await callView(provider, { contractId, method });
  } catch (error) {
    return error;
  }
  throw new Error("callView did not throw");
}

describe.skipIf(!enabled)("callView against testnet", () => {
  test("returns the decoded JSON result of a real contract", async () => {
    const metadata = await callView(provider, { contractId: "wrap.testnet", method: "ft_metadata" });
    expect(metadata).toMatchObject({ spec: "ft-1.0.0", symbol: "wNEAR", decimals: 24 });
  });

  test("passes arguments", async () => {
    const balance = await callView(provider, {
      contractId: "wrap.testnet",
      method: "ft_balance_of",
      args: { account_id: "wrap.testnet" },
    });
    expect(balance).toMatch(/^\d+$/);
  });

  test("missing method", async () => {
    expect(await viewError("wrap.testnet", "no_such_method_xyz")).toBeInstanceOf(ContractMethodNotFoundError);
  });

  test("missing account", async () => {
    const error = await viewError("no-such-account-lastcall-probe.testnet", "ft_metadata");
    expect(error).toBeInstanceOf(AccountDoesNotExistError);
  });

  test("account without a contract", async () => {
    expect(await viewError("dev.testnet", "ft_metadata")).toBeInstanceOf(ContractCodeDoesNotExistError);
  });

  test("contract panic exposes its message", async () => {
    const panic = contractPanic(await viewError("wrap.testnet", "ft_balance_of"));
    expect(panic?.message).toContain("Failed to deserialize input from JSON");
    expect(panic?.code).toBeUndefined();
  });
});
