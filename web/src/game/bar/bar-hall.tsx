"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import type { QuickCheckIn } from "../../checkin/use-checkin-key";
import { kickCall, retryPickHeroCall } from "../../contract/calls";
import { type ActionState, accountActions } from "../actions";
import { formatCountdown, formatUnits, LAST_DECIMALS } from "../format";
import type { GameData } from "../use-game";
import type { BarSettings } from "./bar-settings";
import { Icon, type IconName } from "./icons";

// The room around the bar scene (LC-021, user's choice "A · HUD like Reigns", 14 Nov): one scene in the
// middle, a thin HUD on top with the four numbers that matter (time left, on board / goal, your
// streak, pot) and the wallet menu, and a dock at the bottom whose buttons open sheets (your tab,
// past nights, no-shows). Same layout on phone and desktop; it always fits one screen.

type Send = (label: string, call: ActionState["call"]) => void;
type SheetId = "tab" | "nights" | "noshows";

/** 482,019,334 LAST → "482M"; small amounts keep two decimals. */
export function shortLast(amount: bigint): string {
  if (amount === 0n) return "0";
  const whole = Number(formatUnits(amount, LAST_DECIMALS, 0).replaceAll(",", ""));
  if (whole >= 1e9) return `${(whole / 1e9).toFixed(1)}B`;
  if (whole >= 1e6) return `${(whole / 1e6).toFixed(1)}M`;
  if (whole >= 1e3) return `${(whole / 1e3).toFixed(1)}K`;
  return formatUnits(amount, LAST_DECIMALS, whole >= 100 ? 0 : 2);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface Props {
  readonly data: GameData;
  readonly kickable: readonly string[];
  readonly accountId: string;
  readonly busy: string | undefined;
  readonly message: string | undefined;
  readonly quick: QuickCheckIn;
  /** The bar scene. */
  readonly stage: ReactNode;
  /** The contract's access-key check. */
  readonly keys: ReactNode;
  readonly settings: BarSettings;
  readonly onSend: Send;
  readonly onEnableQuick: () => void;
  readonly onDisconnect: () => void;
}

export function BarHall(props: Props) {
  const { data, kickable, accountId, settings, onDisconnect, message } = props;
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const member = data.account?.member;
  const claimable = member?.pendingClaimable ?? 0n;

  return (
    <div className="lc-hall">
      <Hud data={data} accountId={accountId} settings={settings} onDisconnect={onDisconnect} />
      <div className="lc-hall-stage">{props.stage}</div>
      {message && (
        <p className="lc-toast" role="status">
          {message}
        </p>
      )}
      {/* Desktop: the blocks stand beside the scene; phones and tablets open them as sheets. */}
      <aside className="lc-side lc-side-left" aria-label="Past nights">
        <h2>Past nights</h2>
        <NightsSheet {...props} />
      </aside>
      <aside className="lc-side lc-side-right" aria-label="Your tab">
        <h2>Your tab</h2>
        <TabSheet {...props} />
        <h2>No-shows</h2>
        <NoShowsSheet {...props} />
      </aside>
      <nav className="lc-dock" aria-label="Bar menu">
        <button type="button" className="lc-dock-btn" onClick={() => setSheet("tab")}>
          <Icon name="bill" /> Your tab
          {claimable > 0n && <b className="lc-badge">+{shortLast(claimable)}</b>}
        </button>
        <button type="button" className="lc-dock-btn" onClick={() => setSheet("nights")}>
          <Icon name="moonStars" /> Nights
          {data.game.state.pendingHeroDays.length > 0 && (
            <b className="lc-badge">
              <Icon name="cupStar" />
            </b>
          )}
        </button>
        <button type="button" className="lc-dock-btn" onClick={() => setSheet("noshows")}>
          <Icon name="ghost" /> No-shows
          {kickable.length > 0 && <b className="lc-badge">{kickable.length}</b>}
        </button>
      </nav>
      <Sheet open={sheet === "tab"} title="Your tab" onClose={() => setSheet(null)}>
        <TabSheet {...props} />
      </Sheet>
      <Sheet open={sheet === "nights"} title="Past nights" onClose={() => setSheet(null)}>
        <NightsSheet {...props} />
      </Sheet>
      <Sheet open={sheet === "noshows"} title="No-shows" onClose={() => setSheet(null)}>
        <NoShowsSheet {...props} />
      </Sheet>
    </div>
  );
}

function Hud({
  data,
  accountId,
  settings,
  onDisconnect,
}: {
  readonly data: GameData;
  readonly accountId: string;
  readonly settings: BarSettings;
  readonly onDisconnect: () => void;
}) {
  const now = useNow(1_000);
  const { state } = data.game;
  const day = data.openDay;
  const member = data.account?.member;
  const left = state.msToDayEnd - (now - data.readAt);
  const count = day.stale ? 0 : day.count;
  const toBell = day.isIdle || day.stale ? null : Math.max(0, day.goal - day.count);
  const done = member?.checkedInToday ?? false;
  // Urgent in the last 15% of the night, whatever the night length (10 minutes on the sandbox).
  const urgent = !done && left < data.game.config.dayLengthS * 1000 * 0.15;

  return (
    <header className="lc-hud">
      <div className="lc-hud-stats">
        <span className={`lc-stat${urgent ? " is-urgent" : ""}`} title="Time left tonight">
          <Icon name="alarm" /> <b>{formatCountdown(left)}</b>
        </span>
        <span className="lc-stat" title={toBell === null ? "Quiet night" : `${toBell} more to ring the bell`}>
          <Icon name="users" /> <b>{count}</b>
          {toBell !== null && <small>/{day.goal}</small>}
        </span>
        <span
          className={`lc-stat${done ? " is-lit" : " is-risk"}`}
          title={done ? "Checked in tonight" : "Not checked in tonight: drink to keep the streak"}
        >
          <Icon name="fire" /> <b>{member?.currentPersonalStreak ?? 0}</b>
          <small>{done ? <Icon name="check" /> : "drink!"}</small>
        </span>
        <span className="lc-stat lc-stat-pot" title="The pot">
          <Icon name="moneyBag" /> <b>{shortLast(state.pot)}</b>
        </span>
      </div>
      <AccountMenu accountId={accountId} settings={settings} onDisconnect={onDisconnect} />
    </header>
  );
}

/** A native modal dialog: a bottom sheet on phones, a side drawer on desktops. */
function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a mouse shortcut; Escape closes the dialog natively.
    <dialog
      ref={ref}
      className="lc-sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lc-sheet-body">
        <header className="lc-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="lc-sheet-x" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function TabSheet({ data, busy, quick, keys, onSend, onEnableQuick }: Props) {
  const account = data.account;
  const member = account?.member;
  const actions = accountActions(data.game, account);
  const claim = actions.find((a) => a.id === "claim");
  const more = actions.filter((a) => a.id === "leave" || a.id === "settle");
  const text = (action: ActionState) =>
    action.id === "claim" && member
      ? `Claim ${shortLast(member.pendingClaimable)} LAST`
      : action.id === "leave"
        ? "Leave the bar"
        : action.id === "settle"
          ? "Settle old nights"
          : action.label;
  const button = (action: ActionState, className: string) => (
    <button
      key={action.id}
      type="button"
      className={className}
      disabled={!action.call || busy !== undefined}
      onClick={() => onSend(action.label, action.call)}
    >
      {busy === action.label ? `${text(action)}…` : text(action)}
    </button>
  );

  return (
    <div className="lc-sheet-content">
      {member && (
        <dl className="lc-big-stats">
          <div>
            <dt>your streak</dt>
            <dd>
              <Icon name="fire" /> {member.currentPersonalStreak} <small>best {member.bestPersonalStreak}</small>
            </dd>
          </div>
          <div>
            <dt>to claim</dt>
            <dd>{shortLast(member.pendingClaimable)}</dd>
          </div>
          <div>
            <dt>stake</dt>
            <dd>{shortLast(member.effectiveStake)}</dd>
          </div>
        </dl>
      )}
      {member?.kickableFromDay != null && !member.checkedInToday && (
        <p className="lc-warn">Skip until night {member.kickableFromDay} and anyone can kick you.</p>
      )}
      <div className="lc-row-buttons">
        {claim && button(claim, "lc-btn lc-btn-amber")}
        {member && quick.status === "off" && (
          <button type="button" className="lc-btn" disabled={busy !== undefined} onClick={onEnableQuick}>
            {busy === "Enable one-tap check-in" ? "Enabling…" : "Skip wallet popups"}
          </button>
        )}
      </div>
      {member && quick.status === "off" && (
        <p className="lc-note">One wallet confirmation adds a key that can only check in. No more popups.</p>
      )}
      {more.length > 0 && (
        <details className="lc-more">
          <summary>More</summary>
          <div className="lc-row-buttons">{more.map((a) => button(a, "lc-btn"))}</div>
          {more.map((a) => a.note && <p key={a.id}>{a.note}</p>)}
        </details>
      )}
      <div className="lc-keys">{keys}</div>
    </div>
  );
}

function NightsSheet({ data, busy, onSend }: Props) {
  const [all, setAll] = useState(false);
  const { state, config } = data.game;
  const day = data.openDay;
  const history = [...data.history].sort((a, b) => b.day - a.day);
  const days = all ? history : history.slice(0, 7);
  const pendingHero = state.pendingHeroDays;

  return (
    <div className="lc-sheet-content">
      <dl className="lc-big-stats">
        <div>
          <dt>bar streak</dt>
          <dd>
            {state.streak} <small>best {state.longestStreak}</small>
          </dd>
        </div>
        <div>
          <dt>pot</dt>
          <dd>{shortLast(state.pot)}</dd>
        </div>
        <div>
          <dt>burnt</dt>
          <dd>{shortLast(state.totalBurned)}</dd>
        </div>
      </dl>
      {!day.stale && day.closers.length > 0 && (
        <p className="lc-note">
          Hero seats tonight (last {config.closersK} before the bell): <b>{day.closers.join(", ")}</b>
        </p>
      )}
      {pendingHero.length > 0 && (
        <div className="lc-row-buttons">
          {pendingHero.map((d) => (
            <button
              key={d}
              type="button"
              className="lc-btn"
              disabled={busy !== undefined}
              title="Only if the draw is stuck: it ran out of gas"
              onClick={() => onSend(`Retry the draw of day ${d}`, retryPickHeroCall(d))}
            >
              <Icon name="cupStar" /> Retry hero draw, night {d}
            </button>
          ))}
        </div>
      )}
      {history.length === 0 ? (
        <p className="lc-note">No nights settled yet. First round's on you.</p>
      ) : (
        <ol className="lc-nights">
          {days.map((d) => {
            const burnt = d.potBurned + d.stakeSlashed;
            return (
              <li key={d.day} className={`lc-night is-${d.outcome.toLowerCase()}`}>
                <span className="lc-night-day">Night {d.day}</span>
                <span className="lc-night-count">
                  <Icon name="users" /> {d.count}/{d.goal}
                </span>
                <span className="lc-night-result">
                  {d.outcome === "Success" ? (
                    <>
                      <Icon name="bellBing" /> +{shortLast(d.perShare)} each
                      {d.jackpot > 0n && (
                        <>
                          {" · "}
                          <Icon name="cupStar" /> {d.hero ?? "drawing…"}
                        </>
                      )}
                    </>
                  ) : d.outcome === "Fail" ? (
                    <>
                      <Icon name="bonfire" /> {shortLast(burnt)} burnt
                    </>
                  ) : (
                    <>
                      <Icon name="sleeping" /> quiet
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {history.length > days.length || all ? (
        <button type="button" className="lc-link" onClick={() => setAll((v) => !v)}>
          {all ? "less" : `all ${history.length} nights`}
        </button>
      ) : null}
    </div>
  );
}

function NoShowsSheet({ kickable, busy, onSend }: Props) {
  return (
    <div className="lc-sheet-content">
      <p className="lc-note">They stopped showing up. Kick one and take part of their exit fee.</p>
      {kickable.length === 0 ? (
        <p className="lc-note">
          <Icon name="confetti" /> Everyone's drinking. No one to kick.
        </p>
      ) : (
        <ul className="lc-kick">
          {kickable.map((target) => (
            <li key={target}>
              <span>
                <Icon name="ghost" /> {target}
              </span>
              <button
                type="button"
                className="lc-btn"
                disabled={busy !== undefined}
                onClick={() => onSend(`Kick ${target}`, kickCall(target))}
              >
                <Icon name="userCross" /> Kick
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Switch({
  icon,
  label,
  on,
  onChange,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} className="lc-switch" onClick={() => onChange(!on)}>
      <span>
        <Icon name={icon} /> {label}
      </span>
      <i aria-hidden="true" />
    </button>
  );
}

/** The wallet chip: settings (sound, burps, boring mode) and a confirmed log-out. */
function AccountMenu({
  accountId,
  settings,
  onDisconnect,
}: {
  readonly accountId: string;
  readonly settings: BarSettings;
  readonly onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lc-menu" ref={box}>
      <button
        type="button"
        className="lc-menu-btn"
        aria-expanded={open}
        aria-controls="lc-menu-pop"
        onClick={() => setOpen((v) => !v)}
        title={accountId}
      >
        <i className="lc-menu-dot" aria-hidden="true" />
        <span className="lc-menu-who">{accountId}</span>
        <Icon name="settings" />
        <span className="sr-only">Settings</span>
      </button>
      {open && (
        <div className="lc-menu-pop" id="lc-menu-pop">
          <Switch icon="volume" label="Sound" on={settings.sound} onChange={settings.setSound} />
          <Switch icon="wind" label="Burps & farts" on={settings.bodySounds} onChange={settings.setBodySounds} />
          <a className="lc-menu-item" href="?ui=plain">
            <span>
              <Icon name="sleeping" /> Boring mode (no bar)
            </span>
          </a>
          <button
            type="button"
            className="lc-menu-item lc-menu-out"
            onClick={() => {
              setOpen(false);
              dialog.current?.showModal();
            }}
          >
            <span>
              <Icon name="logout" /> Log out
            </span>
          </button>
        </div>
      )}
      <dialog ref={dialog} className="lc-modal" aria-labelledby="lc-modal-title">
        <h3 id="lc-modal-title">Closing your tab?</h3>
        <p>
          This only disconnects <b>{accountId}</b> from this page. Your seat, stake and streak stay on chain. Skip
          nights and the streak dies, though.
        </p>
        <form method="dialog" className="lc-modal-actions">
          <button type="submit" className="lc-btn">
            One more round
          </button>
          <button
            type="button"
            className="lc-btn lc-btn-amber"
            onClick={() => {
              dialog.current?.close();
              onDisconnect();
            }}
          >
            Log out
          </button>
        </form>
      </dialog>
    </div>
  );
}
