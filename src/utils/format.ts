// Display formatters for timestamps, counts, byte sizes and money, shared so
// every row agrees on what "yesterday" looks like.
//
// Everything formats in the app's language, not the device's: someone reading
// Airhop in Spanish on an English phone sees "mar", not "Tue". So never
// `toLocale*String([])`, whose empty list asks the OS, the value that diverges.
// The language is read at call time; App.tsx subscribes to the i18n store and
// re-renders the tree on a change, so no formatter needs to be a hook.
//
// Numerals are pinned to Latin app-wide (`formatCount` in `@i18n` does the same,
// and `catalog.test.ts` forbids a catalog its own), so the app renders one digit
// system. Grouping still follows the locale, the half that helps: Hindi and
// Tamil group by lakh, Georgian by thin space. Month and weekday names come
// from Intl per locale.
//
// `hour: "2-digit"` gives "20:02" or "08:02 PM" by locale, both right for their
// reader, so timestamp rows size for the wider form. `qps-ploc` negotiates to a
// 12-hour English and exercises it.

import {
  satsToBtc,
  type BitcoinUnit,
  type TokenInfo,
} from "@core/payments/cashu";
import { getLanguage, t } from "@i18n";

const DAY_MS = 86_400_000;

// Latin digits via the BCP-47 extension, not the `numberingSystem` option: an
// engine ignores an extension it lacks during negotiation but can throw on an
// option it lacks, and Hermes ships a partial Intl.
function latinLocale(): string {
  return `${getLanguage()}-u-nu-latn`;
}

// Intl formatters are expensive to construct and these run per list row, so
// they are cached per language and shape.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = latinLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = dateFormatters.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat(locale, options);
  dateFormatters.set(key, made);
  return made;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = latinLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = numberFormatters.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.NumberFormat(locale, options);
  numberFormatters.set(key, made);
  return made;
}

// Clock time only, e.g. "14:32". For a row already grouped under a date.
export function formatClockTime(ms: number): string {
  return formatter({
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

// Calendar days, so 23:59 and 00:01 the next morning are one day apart.
function calendarDaysAgo(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// A conversation row's timestamp, the mainstream messenger ladder that says
// how stale a row is in the fewest glyphs: 14:32 today, Yesterday, Tue this
// week, 4 Mar, and 4 Mar 2025 in another year (a bare "4 Mar" reads as this
// year). Without the middle steps, yesterday looks as old as last month.
export function formatListTimestamp(ms: number): string {
  const then = new Date(ms);
  const now = new Date();
  const days = calendarDaysAgo(then, now);

  if (days <= 0) return formatClockTime(ms);
  if (days === 1) return t("format.yesterday");
  if (days < 7) return formatter({ weekday: "short" }).format(then);
  if (then.getFullYear() === now.getFullYear()) return formatShortDate(ms);
  return formatter({
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(then);
}

// "just now", "5m ago", "2h ago", "3d ago", then the dated form past a week.
export function formatAgo(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return t("format.just_now");
  if (minutes < 60) return t("format.minutes_ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("format.hours_ago", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("format.days_ago", { count: days });
  return formatListTimestamp(ms);
}

// A thread's date separator, on the same calendar-day rule as row timestamps,
// so a thread opened just after midnight cannot say both "Today" and "Tue".
export function formatDateSeparator(ms: number): string {
  const then = new Date(ms);
  const now = new Date();
  const days = calendarDaysAgo(then, now);

  if (days <= 0) return t("format.today");
  if (days === 1) return t("format.yesterday");
  if (days < 7) return formatter({ weekday: "long" }).format(then);
  if (then.getFullYear() === now.getFullYear()) {
    return formatter({
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(then);
  }
  return formatter({
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(then);
}

// "4 Mar", no year.
export function formatShortDate(ms: number): string {
  return formatter({
    month: "short",
    day: "numeric",
  }).format(ms);
}

// "4 March 2026".
export function formatLongDate(ms: number): string {
  return formatter({
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(ms);
}

// Locale grouping (1,000 / 1.000 / 1 000), Latin digits: these sit beside
// Latin units and in the monospace face.
export function formatNumber(value: number): string {
  return numberFormatter({}).format(value);
}

// IEC units: the divisor is 1024.
export function formatBytes(bytes: number): string {
  // Ungrouped: no branch exceeds 1023 before promotion, and "1,023 B" is
  // noise. Latin digits with the locale's decimal separator ("1,4 MiB").
  if (bytes < 1024) return `${formatFixed(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${formatFixed(bytes / 1024, 0)} KiB`;
  return `${formatFixed(bytes / (1024 * 1024), 1)} MiB`;
}

function formatFixed(value: number, fractionDigits: number): string {
  return numberFormatter({
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: false,
  }).format(value);
}

// The inverse of `formatNumber`, accepting any script's digits: a Persian,
// Arabic, Hindi or Bengali number pad types its own, which `parseInt` reads as
// NaN, a payment button that silently does nothing. Each Unicode digit's value
// is its offset from the zero of its run of ten. Whitespace is dropped;
// separators are rejected (grouping in one locale, a decimal point in the next,
// and amounts are whole sats).
export function parseWholeNumber(text: string): number | null {
  let digits = "";
  for (const ch of text) {
    if (/\p{Nd}/u.test(ch)) {
      const cp = ch.codePointAt(0) ?? 0;
      let zero = cp;
      while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
      digits += String((cp - zero) % 10);
    } else if (!/\s/.test(ch)) {
      return null;
    }
  }
  if (digits.length === 0) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---- Money ----
// Here, not in core: `src/core/` imports no display layer (so it can target a
// Node CLI or web build), and a formatter needs the app's language. The
// dependency runs the other way, for `satsToBtc`'s exact integer arithmetic.

// Units a mint may issue that are not ISO 4217 currencies, so have no minor
// unit to scale by.
const NON_FIAT_UNITS = new Set(["sat", "msat", "btc", "auth"]);

// ISO 4217 codes with no minor unit; every other code has two.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "clp",
  "isk",
  "jpy",
  "krw",
  "pyg",
  "ugx",
  "vnd",
  "xaf",
  "xof",
]);

// Cashu amounts are integers in the unit's smallest denomination (NUT-00):
// 150 usd is $1.50, and shown raw it is a hundredfold error on the balance
// card. Null for a unit that is not a currency.
function fiatMinorDigits(unit: string): number | null {
  const code = unit.toLowerCase();
  if (NON_FIAT_UNITS.has(code) || !/^[a-z]{3}$/.test(code)) return null;
  return ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
}

// Only `sat` switches to BTC. Other units are the mint's own (usd, eur) and
// already what they say: showing them as bitcoin would invent an exchange rate
// nobody supplied. Fiat shows in major units with its code, grouped like any
// number. Value and label are separate so the balance card can style them.
export function formatAmount(
  amount: number,
  unit: string,
  display: BitcoinUnit,
): { value: string; label: string } {
  const minor = fiatMinorDigits(unit);
  if (minor !== null) {
    return {
      value: numberFormatter({
        minimumFractionDigits: minor,
        maximumFractionDigits: minor,
      }).format(amount / 10 ** minor),
      label: unit.toUpperCase(),
    };
  }
  if (unit !== "sat" || display === "sat") {
    return { value: formatNumber(amount), label: unit };
  }
  // Exact digits from satsToBtc, ungrouped: nearly all of them sit after the
  // point, where grouping adds nothing.
  return { value: satsToBtc(amount), label: "BTC" };
}

// "500 sat", "1.50 USD".
export function formatUnitAmount(amount: number, unit: string): string {
  const { value, label } = formatAmount(amount, unit, "sat");
  return `${value} ${label}`;
}

// A unit as printed beside an amount: "sat", or "USD" for a currency.
export function unitLabel(unit: string): string {
  return formatAmount(0, unit, "sat").label;
}

// For a translated sentence's {amount} and {unit} placeholders.
export function amountParts(
  amount: number,
  unit: string,
): { amount: string; unit: string } {
  const { value, label } = formatAmount(amount, unit, "sat");
  return { amount: value, unit: label };
}

// "500 sat - coffee money", for search previews and accessibility labels.
export function formatTokenSummary(info: TokenInfo): string {
  const amount = formatUnitAmount(info.amount, info.unit);
  return info.memo ? `${amount} - ${info.memo}` : amount;
}

// m:ss.
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins)}:${secs.toString().padStart(2, "0")}`;
}
