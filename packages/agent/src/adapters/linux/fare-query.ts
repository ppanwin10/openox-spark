import { OxError } from "./functions";

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthNames = months.map(m => `${m}|${m.slice(0, 3)}`).join("|");
const dates = new RegExp([
  "\\b(?<isoYear>20\\d{2})-(?<isoMonth>\\d{2})-(?<isoDay>\\d{2})(?!\\d)",
  "(?:(?<zhYear>20\\d{2})年)?(?<zhMonth>\\d{1,2})月(?<zhDay>\\d{1,2})[日号]",
  `\\b(?<enMonth>${monthNames})\\.?\\s+(?<enDay>\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(?<enYear>20\\d{2})\\b)?`,
  `\\b(?<ukDay>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<ukMonth>${monthNames})\\.?\\b(?:,?\\s+(?<ukYear>20\\d{2})\\b)?`,
].join("|"), "giu");
const alternative = /^\s*(?:evening|morning|afternoon|傍晚|晚上|早上|上午|下午)?\s*(?:or\b|或(?:者)?)\s*/i;
type Day = { month: number; day: number; year: number | null };

// Only bind a round trip with two identifiable date groups. Don't guess what ambiguous numeric dates mean.
function travelDates(text: string) {
  const groups: Day[][] = [];
  let end = 0;
  for (const m of text.matchAll(dates)) {
    const g = m.groups!, named = g.enMonth ?? g.ukMonth;
    const month = named ? months.findIndex(v => v.startsWith(named.toLowerCase())) + 1 : Number(g.isoMonth ?? g.zhMonth);
    const day = Number(g.isoDay ?? g.zhDay ?? g.enDay ?? g.ukDay), year = Number(g.isoYear ?? g.zhYear ?? g.enYear ?? g.ukYear) || null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return [];
    const between = text.slice(end, m.index), choice = alternative.exec(between);
    if (!groups.length || !choice || choice[0] !== between) groups.push([]);
    const group = groups[groups.length - 1]!;
    group.push({ month, day, year }); end = m.index + m[0].length;
    const tail = text.slice(end), or = alternative.exec(tail);
    if (or) {
      const short = /^(\d{1,2})(?:[日号]|(?:st|nd|rd|th)?\b)(?!\s*(?:[-/]|月))/i.exec(tail.slice(or[0].length));
      if (short && Number(short[1]) >= 1 && Number(short[1]) <= 31) {
        group.push({ month, day: Number(short[1]), year }); end += or[0].length + short[0].length;
      }
    }
  }
  const years = new Set(groups.flat().flatMap(d => d.year ? [d.year] : []));
  if (years.size === 1) for (const d of groups.flat()) d.year ??= [...years][0]!;
  return groups;
}

const adults = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
function adultCount(text: string) {
  const en = /\b([1-9]\d?|one|two|three|four|five|six|seven|eight|nine)\s+adults?\b/i.exec(text)?.[1];
  if (en) return Number(en) || adults.indexOf(en.toLowerCase()) + 1;
  const zh = /([1-9]\d?|[一二两三四五六七八九])\s*[位名个]?\s*成人/u.exec(text)?.[1];
  return zh ? Number(zh) || "一二三四五六七八九".indexOf(zh.replace("两", "二")) + 1 : undefined;
}

export function checkFareSearch(request: string, query: string) {
  if (!/\bround[- ]trip\b|\breturn (?:fares?|flights?|tickets?)\b|往返/i.test(request)
    || !/\b(?:fares?|airfare|prices?|costs?)\b|机票|票价/i.test(request)) return;
  const route = /(?:\bfrom\s+|从\s*)([A-Z]{3})(?![A-Za-z])(?:\s*(?:to\b|到|至|→|[-–])\s*([A-Z]{3})(?![A-Za-z]))?/.exec(request);
  const count = adultCount(request), legs = travelDates(request);
  if (!route || !count || legs.length !== 2) return;
  const codes: string[] = query.toUpperCase().match(/[A-Z]+/g) ?? [];
  const origin = codes.indexOf(route[1]!), destination = route[2];
  const actual = travelDates(query);
  const sameDay = (a: Day, b: Day) => a.month === b.month && a.day === b.day && (!a.year || a.year === b.year);
  if (origin < 0 || destination && !codes.slice(origin + 1).includes(destination) || adultCount(query) !== count
    || actual.length !== 2 || !actual.every((group, i) => group.every(day => legs[i]!.some(option => sameDay(option, day))))) {
    throw new OxError("invalid_argument", "This fare search does not preserve the requested route, travel dates and adult count. No search was sent.",
      "Search for the original airport route, one requested departure/return combination (include the stated year), and the number of adults. Keep other restrictions; do not copy private notes into a search.");
  }
}
