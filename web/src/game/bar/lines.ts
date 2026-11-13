// What the bartender and the patrons say (prototype `docs/prototypes/last-orders-bar.html`), with the
// contract's numbers filled in. Pure: no DOM.

import { type ContractErrorCode, contractErrorCode } from "../../contract/errors";

export interface BarFacts {
  /** Hero candidates per day (`closers_k`). */
  readonly closersK: number;
  /** The share of an absent member's stake slashed on a failed day, in percent. */
  readonly slashPct: number;
}

export const LINES = {
  ok: [
    "Bottoms up! You're #N",
    "Clean chug. #N is on the tab",
    "Bartender nods: #N, counted",
    "Absolute unit. #N logged",
  ],
  closer: ["Bottoms up! #N, you're a closer", "#N: closer seat. Pray for hero", "Last call is yours: #N closes"],
  closeGoal: ["You closed the goal. Ring it!", "Goal hit by you. Legend"],
  late: ["Goal's done. Counted, no hero ticket", "Late to the party, still poured"],
  notMouth: [
    "Ser, that's not your mouth",
    "Missed the mouth, missed the check-in",
    "Shaky hands?",
    "The pint won't drink itself",
  ],
  notFinished: [
    "Half a pint is not a check-in",
    "Paper hands. Finish it",
    "Bartender: I'm waiting for the bottom",
    "Leave a sip, lose the streak",
  ],
  extra: [
    "Already checked in. This one's on the house",
    "Bartender: water, maybe?",
    "One check-in a day. The floor is moving",
    "No streak for this one, just vibes",
  ],
  bell: [
    "Don't touch the bell",
    "I said don't touch the bell",
    "Once more and I ring the cops",
    "Fine. Ring it. Nobody has the till key anyway",
  ],
  goal: ["DING! Goal hit, the day is saved", "Bell! The pot doesn't burn tonight", "Goal. Streak lives. WAGMI"],
  cheer: ["Chug!", "Bottoms up!", "One! Two! Three!", "Drink, don't talk!", "Send it!", "Go go go!"],
  praise: ["Legend!", "Based", "Respect", "What a chug", "One more on board"],
  after: ["gm, checked in", "+1, streak holds", "Almost at the bell", "Cheers!"],
  groan: ["Ugh!", "Bro", "ngmi", "Weak"],
  enough: ["He's had enough", "Call him a cab", "Respect, but stop"],
  bless: ["Bless you", "Classy", "Juicy!"],
  fart: ["Ew!", "Who did that?!", "Open a window", "It was the chair", "Check-in with exhaust", "Bartender, the fan!"],
  toasts: ["To the pot!", "Cheers!", "Streak lives!", "WAGMI!"],
  /** Greeting when the bar opens, by streak tier (streak-tier.ts): novice … owner. */
  tierGreet: [
    "New face? Grab the pint, drink to the bottom",
    "gm. Back again?",
    "The usual, regular?",
    "Your mug's ready, local",
    "Legend in the house!",
    "Boss is here. Everyone, stand up",
  ],
  /** Said when the player reaches a tier: novice … owner. */
  tierUp: [
    "",
    "Guest now. Come back tomorrow",
    "Regular! You get a mug",
    "Local! The bar lights up for you",
    "LEGEND. Your name goes on the wall",
    "OWNER. The crown is yours",
  ],
  chorus: ["EYYY!", "Cheers!", "There they are!", "WAGMI!"],
} as const;

/** Lines the bartender drops when nothing happens; they depend on the deployment. */
export function hintLines(goal: number | null, facts: BarFacts): string[] {
  return [
    ...(goal !== null ? [`Tonight we need ${goal}. Everyone can see it`] : []),
    "Late? Still poured, just no hero ticket",
    "Nobody has the till key. Not even me",
    `No-shows lose ${facts.slashPct}% of their stake`,
  ];
}

/** Patron chatter. */
export function chatLines(facts: BarFacts): string[] {
  return [
    `Skip tonight, lose ${facts.slashPct}%`,
    "The pot is thicc today",
    "Bartender, same again!",
    "Where's Dave? Skipping again",
    "Two more and the bell rings",
    "Dibs on hero",
    "To everyone before the goal!",
    "No admin key. Not even the bartender",
    "Cheers while seats last",
    "gm",
  ];
}

export function cheerFor(name: string): string[] {
  return ["Bottoms up!", `Go ${name}!`, "Send it!"];
}

/** What the bartender says after the player's own check-in landed. */
export function ownCheckInLine(
  result: { readonly n: number; readonly goal: number; readonly inClosers: boolean },
  pick: (lines: readonly string[]) => string
): string {
  const n = (line: string) => line.replace("#N", `#${result.n}`);
  if (result.n === result.goal) return pick(LINES.closeGoal);
  if (result.n > result.goal) return n(pick(LINES.late));
  if (result.inClosers) return n(pick(LINES.closer));
  return n(pick(LINES.ok));
}

const BARTENDER_ERRORS: Partial<Record<ContractErrorCode, string>> = {
  ERR_ALREADY_CHECKED_IN: "You already checked in today. Not writing it twice",
  ERR_WARMUP: "Still warming up: I'll count you from your activation day",
  ERR_NOT_MEMBER: "You're not on the list. Join first",
  ERR_BACKLOG: "Settle the old days first, then I pour",
};

/**
 * Why a check-in did not count, in the bartender's words. The wallet's own refusal is told apart
 * from the contract's errors; anything else is shown as it came.
 */
export function bartenderError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = contractErrorCode(text);
  if (code) return BARTENDER_ERRORS[code] ?? `Not counted: ${code}`;
  if (/reject|cancel|denied|declined|closed/i.test(text)) return "Changed your mind? Wallet didn't sign, not counted";
  if (/allowance/i.test(text)) return "The check-in key ran out of gas. Use the wallet";
  return `Not counted: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
}
