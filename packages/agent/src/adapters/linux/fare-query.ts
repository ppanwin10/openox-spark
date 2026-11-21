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
type Itinerary = { origin: string; destination?: string; count: number; legs: Day[][]; partyTotal: boolean };

// Only bind a round trip with two identifiable date groups. Don't guess what ambiguous numeric dates mean.
function travelDates(text: string) {
  const groups: Day[][] = [];
  let end = 0;
  const matches = [...text.matchAll(dates)];
  for (const [i, m] of matches.entries()) {
    const g = m.groups!, named = g.enMonth ?? g.ukMonth;
    const month = named ? months.findIndex(v => v.startsWith(named.toLowerCase())) + 1 : Number(g.isoMonth ?? g.zhMonth);
    const day = Number(g.isoDay ?? g.zhDay ?? g.enDay ?? g.ukDay), year = Number(g.isoYear ?? g.zhYear ?? g.enYear ?? g.ukYear) || null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return [];
    const between = text.slice(end, m.index), choice = alternative.exec(between);
    if (!groups.length || !choice || choice[0] !== between) groups.push([]);
    const group = groups[groups.length - 1]!;
    group.push({ month, day, year }); end = m.index + m[0].length;
    const tail = text.slice(end, matches[i + 1]?.index), or = alternative.exec(tail);
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

export function requestedFareItinerary(request: string): Itinerary | undefined {
  if (!/\bround[- ]trip\b|\breturn (?:fares?|flights?|tickets?)\b|往返/i.test(request)
    || !/\b(?:fares?|airfare|prices?|costs?)\b|机票|票价/i.test(request)) return;
  if (/\b(?:not|rather than|without) (?:a |an |the )?(?:fare|price)(?:s|\s+quote)?\b|(?:不问|不查|不看)(?:票价|价格)/i.test(request)
    || /^(?:when|how far in advance|what is (?:the|their) (?:refund|booking|cancellation) policy)\b/i.test(request.trim())) return;
  const route = /(?:\b[Ff]rom\s+|从\s*)([A-Z]{3})(?![A-Za-z])(?:\s*(?:[Tt]o\b|到|至|→|[-–])\s*([A-Z]{3})(?![A-Za-z]))?/.exec(request);
  const count = adultCount(request), legs = travelDates(request);
  if (!route || !count || legs.length !== 2) return;
  return { origin: route[1]!, destination: route[2], count, legs, partyTotal: /\btotal\b|总价|合计|总票价/i.test(request) };
}

function matchesTrip(trip: Itinerary, text: string) {
  const codes: string[] = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const origin = codes.indexOf(trip.origin), actual = travelDates(text);
  return origin >= 0 && (!trip.destination || codes.slice(origin + 1).includes(trip.destination)) && adultCount(text) === trip.count
    && actual.length === 2 && actual.every((group, i) => group.every(day => trip.legs[i]!.some(wanted =>
      wanted.month === day.month && wanted.day === day.day && (!wanted.year || wanted.year === day.year))));
}

export function checkFareSearch(trip: Itinerary, query: string) {
  if (!matchesTrip(trip, query)) {
    throw new OxError("invalid_argument", "This fare search does not preserve the requested route, travel dates and adult count. No search was sent.",
      "Search for the original airport route, one requested departure/return combination (include the stated year), and the number of adults. Keep other restrictions; do not copy private notes into a search.");
  }
}

const currency = "(?:USD|CAD|EUR|GBP|CNY|JPY|AUD|NZD|CHF|HKD|RMB)";
const number = "\\d+(?:,\\d{3})*(?:\\.\\d+)?";
const money = `(?:(?:[$€£¥]|\\b${currency}\\b)\\s*${number}|${number}\\s*(?:\\b${currency}\\b|dollars\\b|euros\\b|元))`;
const total = "(?:(?:party |group |trip |round[- ]trip |fare )?total(?: fare| price| for (?:both|all)(?: (?:adults|passengers))?)?|(?:机票|票价|往返)?总价|合计|总票价)";
const partyPrice = new RegExp(`(?:${total}\\s*(?:[:：=]|is|was|of|为)?\\s*${money}|${money}\\s*(?:in\\s+)?${total}(?![a-z]|\\s+(?:per|each)\\b))`, "iu");
const cashAmount = new RegExp(money, "iu");
const incidental = /\b(?:baggage|change|cancellation|service|seat) fees?\b|\b(?:deposit|surcharge)\b|行李费|改签费|退票费|定金/iu;
export function checkFareExcerpts(trip: Itinerary, excerpts: readonly string[]) {
  if (!excerpts.every(text => matchesTrip(trip, text) && (trip.partyTotal ? partyPrice : cashAmount).test(text) && !incidental.test(text))) {
    throw new OxError("invalid_argument", "The selected excerpts do not establish a cash fare for the requested itinerary. No fare answer was finalized.",
      "Select a self-contained offer with the applicable route, dates, adult count and currency amount. For a requested party total it must identify that amount as the total, not a per-person price or fee. Otherwise use unverifiedSource for a page actually read this turn.");
  }
}
