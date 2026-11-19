export type Recurrence =
  | { type: "interval"; seconds: number }
  | { type: "once"; fireAt: number }
  | { type: "daily"; hour: number; minute: number; timeZone: string }
  | { type: "weekly"; weekday: number; hour: number; minute: number; timeZone: string };

export const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const formatters = new Map<string, Intl.DateTimeFormat>();
const day = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

export const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function validTimeZone(zone: string) {
  try { formatter(zone); return true; } catch { return false; }
}
export function parseISODate(text: string) {
  if (!isoPattern.test(text)) return undefined;
  const value = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(value) ? value : undefined;
}
export const isoDate = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");

function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(zone, value);
  }
  return value;
}

export function wall(milliseconds: number, zone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(milliseconds))) if (part.type !== "literal") fields[part.type] = Number(part.value);
  return Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour! % 24, fields.minute!, fields.second!);
}
export function validVisibility(value: { timeZone: string; windows: { from?: string; until?: string }[] }) {
  const date = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`))
    && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
  return validTimeZone(value.timeZone) && value.windows.every(window => (!window.from || date(window.from)) && (!window.until || date(window.until))
    && (!window.from || !window.until || window.from <= window.until));
}
export function visibleAt(rule: { timeZone: string; windows: { weekdays: number[]; start: string; end: string; from?: string; until?: string }[] } | undefined, at: number) {
  if (!rule) return true;
  if (!validVisibility(rule)) return false;
  if (!rule.windows.length) return true;
  const local = new Date(wall(at, rule.timeZone)), minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return rule.windows.some(window => {
    const start = minute(window.start), end = minute(window.end);
    const begins = new Date(local);
    if (start > end && minutes < end) begins.setUTCDate(begins.getUTCDate() - 1);
    else if (start !== end && !(start < end ? minutes >= start && minutes < end : minutes >= start)) return false;
    const date = begins.toISOString().slice(0, 10);
    return window.weekdays.includes(begins.getUTCDay() + 1) && (!window.from || date >= window.from) && (!window.until || date <= window.until);
  });
}
const offset = (milliseconds: number, zone: string) => {
  const whole = Math.floor(milliseconds / 1000) * 1000;
  return wall(whole, zone) - whole;
};

function instants(local: number, zone: string) {
  const before = offset(local - day, zone), after = offset(local + day, zone);
  return [...new Set([before, after, offset(local, zone)])].map(value => local - value).filter(time => wall(time, zone) === local);
}

export function localTimeInstants(text: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) || !validTimeZone(zone)) return [];
  const local = Date.parse(`${text}:00Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 16) !== text) return [];
  return instants(local, zone);
}

function instant(local: number, zone: string) {
  const matches = instants(local, zone);
  if (matches.length) return Math.min(...matches);
  const before = offset(local - day, zone), after = offset(local + day, zone);
  let low = Math.min(local - before, local - after), high = Math.max(local - before, local - after);
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (wall(middle, zone) >= local) high = middle; else low = middle;
  }
  return high;
}

export function validRecurrence(recurrence: Recurrence) {
  const time = (hour: number, minute: number, zone: string) => Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59 && validTimeZone(zone);
  switch (recurrence.type) {
    case "interval": return Number.isInteger(recurrence.seconds) && recurrence.seconds >= 30 && recurrence.seconds <= 31_536_000;
    case "once": return Number.isFinite(recurrence.fireAt);
    case "daily": return time(recurrence.hour, recurrence.minute, recurrence.timeZone);
    case "weekly": return Number.isInteger(recurrence.weekday) && recurrence.weekday >= 1 && recurrence.weekday <= 7 && time(recurrence.hour, recurrence.minute, recurrence.timeZone);
  }
}

export function nextOccurrence(recurrence: Recurrence, after: number): number | undefined {
  if (recurrence.type === "interval") return after + recurrence.seconds * 1000;
  if (recurrence.type === "once") return recurrence.fireAt > after ? recurrence.fireAt : undefined;
  const today = new Date(wall(after, recurrence.timeZone));
  for (let index = 0; index <= 8; index++) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + index));
    if (recurrence.type === "weekly" && date.getUTCDay() + 1 !== recurrence.weekday) continue;
    const candidate = instant(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), recurrence.hour, recurrence.minute), recurrence.timeZone);
    if (candidate > after) return candidate;
  }
  return undefined;
}

export function recurrenceSummary(recurrence: Recurrence) {
  switch (recurrence.type) {
    case "interval": return `every ${recurrence.seconds} seconds`;
    case "once": return `once at ${isoDate(recurrence.fireAt)}`;
    case "daily": return `daily at ${pad(recurrence.hour)}:${pad(recurrence.minute)} ${recurrence.timeZone}`;
    case "weekly": return `weekly on weekday ${recurrence.weekday} at ${pad(recurrence.hour)}:${pad(recurrence.minute)} ${recurrence.timeZone}`;
  }
}
