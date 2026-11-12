import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";

import paramsFile from "../config/params.json";
import { ContractReader } from "../web/src/contract/reader";

// A local NEAR node with the real contract (plan 6.3). Used by `bun run demo`, the relayer check,
// and golden traces. Lessons from `contract/tests/sandbox.rs` are kept: liblzma on macOS, one long
// epoch and a 3 s maximum block delay so fast-forward is quick and predictable, fast-forward in
// chunks, and waiting until fast-forwarded blocks stop coming.

const ROOT = join(import.meta.dir, "..");
export const WASM_PATH = join(ROOT, "contract/res/last_call.wasm");
const WASM_SHA256_PATH = join(ROOT, "contract/res/last_call.wasm.sha256");
const METADATA = { spec: "ft-1.0.0", name: "Last Call", symbol: "LAST", decimals: 18 } as const;
/** `near-sandbox` stops polling a fast-forward target after a while; 2 000 blocks take under a second. */
const FF_CHUNK = 2_000;
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

export type ParamSet = "mainnet" | "testnet" | "demo";

/** Fails with a clear message if the wasm is not the committed release build. */
export async function verifiedWasm(paths = { wasm: WASM_PATH, sha256: WASM_SHA256_PATH }): Promise<Uint8Array> {
  const expected = (await Bun.file(paths.sha256).text()).trim().split(/\s+/)[0];
  const wasm = new Uint8Array(await Bun.file(paths.wasm).arrayBuffer());
  const actual = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `contract/res/last_call.wasm has sha256 ${actual}, expected ${expected} from last_call.wasm.sha256`
    );
  }
  return wasm;
}

/** On macOS the sandbox binary links liblzma from Homebrew's xz. */
async function ensureLiblzma(): Promise<void> {
  if (process.platform !== "darwin") return;
  const prefix = await Bun.$`brew --prefix xz`.nothrow().quiet().text();
  const lib = prefix.trim() ? join(prefix.trim(), "lib") : "";
  if (!lib || !(await Bun.file(join(lib, "liblzma.dylib")).exists())) {
    throw new Error("near-sandbox needs liblzma on macOS: run `brew install xz`");
  }
  const current = process.env.DYLD_LIBRARY_PATH;
  if (!current?.split(":").includes(lib)) process.env.DYLD_LIBRARY_PATH = current ? `${lib}:${current}` : lib;
}

export interface TestAccount {
  readonly accountId: string;
  readonly account: Account;
  readonly publicKey: string;
}

export interface Deployment {
  readonly contractId: string;
  readonly holder: TestAccount;
  readonly reader: ContractReader;
  readonly dayMs: number;
}

export class LocalChain {
  private constructor(
    private readonly sandbox: Sandbox,
    readonly provider: JsonRpcProvider,
    readonly root: Account
  ) {}

  get rpcUrl(): string {
    return this.sandbox.rpcUrl;
  }

  static async start(): Promise<LocalChain> {
    await ensureLiblzma();
    const sandbox = await Sandbox.start({
      config: {
        additionalConfig: { consensus: { max_block_production_delay: { secs: 3, nanos: 0 } } },
        additionalGenesis: { epoch_length: 100_000 },
      },
    });
    try {
      const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
      const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
      return new LocalChain(sandbox, provider, root);
    } catch (error) {
      await sandbox.tearDown();
      throw error;
    }
  }

  /** Stops the node and removes its temporary home directory. */
  async stop(): Promise<void> {
    await this.sandbox.tearDown();
  }

  /** Creates `<prefix>.sandbox` with a fresh full-access key held in memory. */
  async createAccount(prefix: string, near = 50n): Promise<TestAccount> {
    const keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    await this.root.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: near * NEAR });
    const accountId = `${prefix}.${DEFAULT_ACCOUNT_ID}`;
    return { accountId, account: new Account(accountId, this.provider, keyPair.toString()), publicKey };
  }

  /** Deploys the verified wasm to `<name>.sandbox` and calls `new` with a set from params.json. */
  async deploy(name: string, set: ParamSet = "demo", overrides: Record<string, unknown> = {}): Promise<Deployment> {
    const wasm = await verifiedWasm();
    const contract = await this.createAccount(name, 20n);
    const holder = await this.createAccount(`holder-${name}`);
    const params = (paramsFile as Record<string, Record<string, unknown>>)[set];
    if (!params) throw new Error(`no parameter set ${set}`);
    const config = { ...(params.config as Record<string, unknown>), ...overrides };
    await contract.account.deployContract(wasm);
    await contract.account.callFunction({
      contractId: contract.accountId,
      methodName: "new",
      args: {
        config,
        total_supply: params.total_supply,
        pot_bps: params.pot_bps,
        faucet_bps: params.faucet_bps,
        initial_holder: holder.accountId,
        metadata: METADATA,
      },
      gas: 300n * TGAS,
    });
    return {
      contractId: contract.accountId,
      holder,
      reader: new ContractReader(this.provider, contract.accountId),
      dayMs: Number(config.day_length_s) * 1000,
    };
  }

  async height(): Promise<number> {
    const block = await this.provider.viewBlock({ finality: "optimistic" });
    return block.header.height;
  }

  /** `sandbox_fast_forward` in chunks, then waits until the fast-forwarded blocks stop coming. */
  async fastForward(blocks: number): Promise<void> {
    let left = blocks;
    while (left > 0) {
      const n = Math.min(left, FF_CHUNK);
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: n } }),
      });
      const body = (await response.json()) as { error?: unknown };
      if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
      left -= n;
    }
    let last = await this.height();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await Bun.sleep(300);
      const now = await this.height();
      if (now <= last + 10) return;
      last = now;
    }
    throw new Error("fast-forwarded blocks keep coming after 3 minutes");
  }

  /**
   * Moves block time until the contract's `today` reaches `target`, using `get_state` as the clock.
   * A fast-forwarded block adds about (min + max block delay) / 2 of block time, so the step is
   * measured as it goes. Returns the new `today`.
   */
  async goToDay(deployment: Deployment, target: number): Promise<number> {
    let msPerBlock = 1_500;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await deployment.reader.state();
      if (state.today >= target) return state.today;
      const need = (target - state.today - 1) * deployment.dayMs + state.msToDayEnd;
      // Long jumps go 80% of the way first so an error in the estimate cannot overshoot by days.
      const aim = need > 2 * deployment.dayMs ? 0.8 * need : need + 0.25 * msPerBlock;
      const blocks = Math.max(1, Math.ceil(aim / msPerBlock));
      const before = state.today * deployment.dayMs + (deployment.dayMs - state.msToDayEnd);
      await this.fastForward(blocks);
      const after = await deployment.reader.state();
      const moved = after.today * deployment.dayMs + (deployment.dayMs - after.msToDayEnd) - before;
      if (blocks >= 20 && moved > 0) msPerBlock = moved / blocks;
    }
    throw new Error(`could not reach day ${target}`);
  }
}
