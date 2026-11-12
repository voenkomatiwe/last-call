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
  ok: ["До дна! Засчитано, #N", "Чисто! #N в журнале", "Бармен кивнул: #N, отметился", "Вот это глоток. #N засчитан"],
  closer: [
    "До дна! Ты в замыкающих, #N",
    "#N — замыкающий. Держи кулаки за героя дня",
    "Последний звонок твой: #N в замыкающих",
  ],
  closeGoal: ["До дна! Ты закрыл цель", "Ты добил цель. Колокол твой"],
  late: ["Цель уже взяли. Засчитано, но в розыгрыш не попал", "Опоздал к звонку, но наливаем"],
  notMouth: ["Ну ты чего, до рта не донёс", "Мимо рта — мимо чек-ина", "Рука дрогнула?", "Бокал сам себя не выпьет"],
  notFinished: [
    "Не допил — не считается. До дна!",
    "Половина — это не чек-ин",
    "Бармен: я жду дно",
    "Оставил на донышке — оставил без стрика",
  ],
  extra: [
    "Сегодня ты уже отметился. Этот за счёт заведения",
    "Бармен: может, водички?",
    "Чек-ин один в день, а пол уже качается",
    "Стрик за это не растёт, а голова кружится",
  ],
  bell: [
    "Не трогай колокол",
    "Я сказал, не трогай",
    "Ещё раз — и звоню я. В полицию",
    "Ладно, звони. Всё равно ключа от кассы нет",
  ],
  goal: ["ДЗЫНЬ! Цель взята, день спасён", "Звонок! Котёл сегодня не горит", "Цель есть. Стрик живёт"],
  cheer: ["Давай!", "До дна!", "Раз! Два! Три!", "Пей, не болтай!", "Залпом!", "Ну-ну-ну!"],
  praise: ["Красава!", "Наш человек", "Уважаю", "Вот это глоток", "Ещё один в строю"],
  after: ["Отметился, красавчик", "+1, держим стрик", "Ещё чуть-чуть до звонка", "Чин-чин!"],
  groan: ["Эээ!", "Ну ты чего", "Позор!", "Слабо?"],
  enough: ["Ему хватит", "Вызовите такси", "Уважаю, но хватит"],
  bless: ["Будь здоров", "Культурно", "Смачно!"],
  fart: ["Фу!", "Кто это?!", "Окно откройте", "Это стул скрипнул", "Чек-ин с выхлопом", "Бармен, вытяжку!"],
  toasts: ["За котёл!", "Ура!", "Стрик живёт!", "Чин-чин!"],
} as const;

/** Lines the bartender drops when nothing happens; they depend on the deployment. */
export function hintLines(goal: number | null, facts: BarFacts): string[] {
  return [
    ...(goal !== null ? [`Цель видна всем: нужно ${goal}`] : []),
    "Опоздавшим тоже наливаем, но без розыгрыша",
    "У бармена нет ключа от кассы. Ни у кого нет",
    `Не отметишься — сгорит ${facts.slashPct}% залога`,
  ];
}

/** Patron chatter. */
export function chatLines(facts: BarFacts): string[] {
  return [
    `Кто не придёт — минус ${facts.slashPct}% залога`,
    "Котёл сегодня жирный",
    "Бармен, повтори!",
    "Где Дима? Опять прогуляет",
    "Ещё пара — и звонок",
    "Чур я герой дня",
    "За тех, кто до цели!",
    "Ключа от кассы нет даже у бармена",
    "Чокнемся, пока места есть",
  ];
}

export function cheerFor(name: string): string[] {
  return ["До дна!", `Давай, ${name}!`, "Залпом!"];
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
  ERR_ALREADY_CHECKED_IN: "Ты сегодня уже отмечался. Второй раз не запишу",
  ERR_WARMUP: "Прогрев ещё идёт: запишу со дня активации",
  ERR_NOT_MEMBER: "Ты не в списке. Сначала вступи",
  ERR_BACKLOG: "Сначала закройте прошлые дни (Settle), потом запишу",
};

/**
 * Why a check-in did not count, in the bartender's words. The wallet's own refusal is told apart
 * from the contract's errors; anything else is shown as it came.
 */
export function bartenderError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = contractErrorCode(text);
  if (code) return BARTENDER_ERRORS[code] ?? `Не записал: ${code}`;
  if (/reject|cancel|denied|declined|closed/i.test(text)) return "Передумал? Кошелёк не подписал — не считается";
  if (/allowance/i.test(text)) return "У ключа для чек-ина кончился газ. Отметься через кошелёк";
  return `Не записал: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
}
