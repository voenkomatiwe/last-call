import type { Provider } from "near-api-js";

import { callView } from "../near/view";
import { ContractShapeError } from "./decode";
import {
  type ConfigView,
  type DaySummary,
  type KickablePage,
  type MemberView,
  type OpenDayView,
  parseBalance,
  parseConfig,
  parseHistory,
  parseKickablePage,
  parseMember,
  parseOpenDay,
  parseState,
  parseStorageBalance,
  parseStorageBalanceBounds,
  type StateView,
  type StorageBalance,
  type StorageBalanceBounds,
} from "./views";

/** Typed view calls of one deployed contract. Every result is validated before it is returned. */
export class ContractReader {
  constructor(
    private readonly provider: Provider,
    readonly contractId: string
  ) {}

  private async view<T>(method: string, args: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
    return parse(await callView(this.provider, { contractId: this.contractId, method, args }));
  }

  state(): Promise<StateView> {
    return this.view("get_state", {}, parseState);
  }

  openDay(): Promise<OpenDayView> {
    return this.view("get_open_day", {}, parseOpenDay);
  }

  member(accountId: string): Promise<MemberView | null> {
    return this.view("get_member", { account_id: accountId }, parseMember);
  }

  /** Settled days, newest first; the contract keeps the last 64. */
  history(limit = 64): Promise<DaySummary[]> {
    return this.view("get_history", { limit }, parseHistory);
  }

  kickable(fromIndex: number, limit: number): Promise<KickablePage> {
    return this.view("get_kickable", { from_index: fromIndex, limit }, parseKickablePage);
  }

  /** Every kickable member, paging until `next_index` is null. A hint: entries may be stale. */
  async allKickable(pageSize = 200): Promise<string[]> {
    const accounts: string[] = [];
    let from: number | null = 0;
    while (from !== null) {
      const page: KickablePage = await this.kickable(from, pageSize);
      accounts.push(...page.accounts);
      // A page that does not move forward would loop forever: refuse it.
      if (page.nextIndex !== null && page.nextIndex <= from) {
        throw new ContractShapeError(`get_kickable.next_index ${page.nextIndex} does not advance past ${from}`);
      }
      from = page.nextIndex;
    }
    return accounts;
  }

  config(): Promise<ConfigView> {
    return this.view("get_config", {}, parseConfig);
  }

  balance(accountId: string): Promise<bigint> {
    return this.view("ft_balance_of", { account_id: accountId }, parseBalance);
  }

  storageBalance(accountId: string): Promise<StorageBalance | null> {
    return this.view("storage_balance_of", { account_id: accountId }, parseStorageBalance);
  }

  storageBalanceBounds(): Promise<StorageBalanceBounds> {
    return this.view("storage_balance_bounds", {}, parseStorageBalanceBounds);
  }
}
