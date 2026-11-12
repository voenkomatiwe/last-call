import type { LastCallSim } from "./engine";

/**
 * The invariants of plan section 4.8 that the state can show by itself. Returns one line per
 * violation; an empty list means all hold. I5 and I9 depend on the call sequence and are checked
 * by the tests; I7 is structural (there is no method that changes the config).
 */
export function checkInvariants(sim: LastCallSim): string[] {
  const s = sim.state;
  const violations: string[] = [];
  const fail = (message: string) => violations.push(message);

  // I1: the contract's balance is exactly its buckets.
  const buckets = s.pot + s.reserved + s.stake_pool + s.faucet_left + s.jackpot_pending;
  const contractBalance = sim.ftBalanceOf(s.contract_id);
  if (contractBalance !== buckets) fail(`I1: contract balance ${contractBalance} != buckets ${buckets}`);

  // I2: supply only goes down, and only by what was burned. Every token is on some balance.
  if (s.total_supply !== s.initial_supply - s.total_burned) {
    fail(`I2: total_supply ${s.total_supply} != initial ${s.initial_supply} - burned ${s.total_burned}`);
  }
  const ledger = [...s.balances.values()].reduce((sum, value) => sum + value, 0n);
  if (ledger !== s.total_supply) fail(`I2: sum of balances ${ledger} != total_supply ${s.total_supply}`);

  // I3: personal stakes never exceed the aggregates they are slashed against.
  const members = sim.effectiveMembers();
  const allStakes = members.reduce((sum, entry) => sum + entry.stake, 0n);
  const activeStakes = members
    .filter((entry) => entry.member.activation_day <= s.open.day)
    .reduce((sum, entry) => sum + entry.stake, 0n);
  if (allStakes > s.stake_pool) fail(`I3: sum of stakes ${allStakes} > stake_pool ${s.stake_pool}`);
  if (activeStakes > s.active_stake) fail(`I3: sum of active stakes ${activeStakes} > active_stake ${s.active_stake}`);
  if (s.open.active_stake > s.active_stake) fail("I3: open.active_stake > active_stake");
  if (s.active_stake > s.stake_pool) fail("I3: active_stake > stake_pool");

  // I4: everything members can claim is reserved.
  const claimable = members.reduce((sum, entry) => sum + entry.claimable, 0n);
  if (claimable > s.reserved) fail(`I4: pending claimable ${claimable} > reserved ${s.reserved}`);

  // I6: today's tickets are exactly numbers 1..min(count, goal), held by distinct members who
  // checked in today (or who left after checking in, whose tickets stay in the draw).
  const issued = s.open.goal > 0 ? Math.min(s.open.count, s.open.goal) : 0;
  const holders = new Set<string>();
  for (const [index, slot] of s.tickets) {
    if (slot.day !== s.open.day) continue;
    if (index >= issued) fail(`I6: ticket ${index + 1} written today beyond min(count, goal) = ${issued}`);
    if (holders.has(slot.holder)) fail(`I6: ${slot.holder} holds two tickets today`);
    holders.add(slot.holder);
    const member = s.members.get(slot.holder);
    // A holder who left and rejoined today has a fresh record (join_day today, no check-in yet).
    if (member && member.last_checkin !== s.open.day && member.join_day !== s.open.day) {
      fail(`I6: ${slot.holder} holds a ticket without checking in`);
    }
  }
  if (holders.size !== issued) fail(`I6: ${holders.size} tickets today, expected ${issued}`);
  if (s.tickets.size > 0 && Math.max(...s.tickets.keys()) >= Math.max(s.tickets.size, 1)) {
    fail("I6: ticket slots are not contiguous from 0");
  }

  // I8: no reward record with a zero share.
  for (const [day, reward] of s.rewards) {
    if (reward.per_share === 0n) fail(`I8: rewards[${day}] has per_share 0`);
  }

  // I10: every outstanding share is owed to exactly the members who have not collected it.
  for (const [day, reward] of s.rewards) {
    const owed = members.filter(
      (entry) => entry.member.last_checkin === day && entry.member.resolved_through <= day
    ).length;
    if (reward.refs !== owed) fail(`I10: rewards[${day}].refs ${reward.refs} != members owed ${owed}`);
  }

  // I11: counters match the member records.
  const active = members.filter((entry) => entry.member.activation_day <= s.open.day).length;
  if (s.active_count !== active) fail(`I11: active_count ${s.active_count} != active members ${active}`);
  if (s.members_total !== s.members.size) fail(`I11: members_total ${s.members_total} != ${s.members.size}`);

  // I12: the pending jackpot is exactly the pending draw's.
  const pendingJackpot = s.pending_hero?.jackpot ?? 0n;
  if (s.jackpot_pending !== pendingJackpot) fail(`I12: jackpot_pending ${s.jackpot_pending} != ${pendingJackpot}`);

  return violations;
}
