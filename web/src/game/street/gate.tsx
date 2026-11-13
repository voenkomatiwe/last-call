"use client";

import { shortLast } from "../bar/bar-hall";
import { formatNear } from "../format";
import type { EntryStep } from "./entry";

// The one button in front of the pub (LC-024): it always offers the next contract step, never more.

export interface GateProps {
  readonly step: EntryStep;
  readonly accountId: string | null;
  /** Share of the stake burnt for a missed failed night, in percent. */
  readonly slashPct: number;
  /** The step being sent, if any. */
  readonly busy: boolean;
  readonly onStep: (step: EntryStep) => void;
}

export function Gate({ step, accountId, slashPct, busy, onStep }: GateProps) {
  if (step.kind === "member") return null;
  const { note, label, enabled } = gateText(step, accountId, slashPct);
  return (
    <div className="lc-gate">
      <p className="lc-gate-note">{note}</p>
      <button
        type="button"
        className="lc-gate-btn"
        disabled={!enabled || busy}
        aria-busy={busy || undefined}
        onClick={() => onStep(step)}
      >
        {busy ? <span className="lc-gate-dots">{label}</span> : label}
      </button>
    </div>
  );
}

function gateText(
  step: Exclude<EntryStep, { kind: "member" }>,
  accountId: string | null,
  slashPct: number
): { note: React.ReactNode; label: string; enabled: boolean } {
  const who = accountId ? <b className="lc-gate-em">{accountId}</b> : null;
  switch (step.kind) {
    case "connect":
      return { note: "Members only. Connect a NEAR wallet to reach the door", label: "Connect wallet", enabled: true };
    case "register":
      return {
        note: (
          <>
            {who} · open a $LAST account first ({formatNear(step.deposit)} NEAR deposit)
          </>
        ),
        label: "Open a $LAST account",
        enabled: true,
      };
    case "faucet":
      return {
        note: (
          <>
            Stake to enter: <b className="lc-gate-em">{shortLast(step.stake)} LAST</b>. You have{" "}
            {shortLast(step.balance)}. First round is on the house
          </>
        ),
        label: `Take ${shortLast(step.amount)} LAST from the tap`,
        enabled: true,
      };
    case "no-funds":
      return {
        note: (
          <>
            Stake to enter: <b className="lc-gate-em">{shortLast(step.stake)} LAST</b>. You have{" "}
            {shortLast(step.balance)}. Ask a holder for LAST: no faucet on this network
          </>
        ),
        label: `Need ${shortLast(step.stake)} LAST`,
        enabled: false,
      };
    case "settle":
      return {
        note: "Old nights must be settled before anyone can join",
        label: `Settle ${step.days} nights`,
        enabled: true,
      };
    case "join":
      return {
        note: (
          <>
            <b className="lc-gate-em">{shortLast(step.balance)} LAST</b> · the stake comes back when you leave. Miss a
            failed night: −{slashPct}%
          </>
        ),
        label: `Enter · stake ${shortLast(step.stake)} LAST`,
        enabled: true,
      };
  }
}
