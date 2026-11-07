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

function wall(milliseconds: number, zone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(milliseconds))) if (part.type !== "literal") fields[part.type] = Number(part.value);
  return Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour! % 24, fields.minute!, fields.second!);
}
const offset = (milliseconds: number, zone: string) => {
  const whole = Math.floor(milliseconds / 1000) * 1000;
  return wall(whole, zone) - whole;
};

function instant(local: number, zone: string) {
  const before = offset(local - day, zone), after = offset(local + day, zone);
  const matches = [...new Set([before, after, offset(local, zone)])].map(value => local - value).filter(time => wall(time, zone) === local);
  if (matches.length) return Math.min(...matches);
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
