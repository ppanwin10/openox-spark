import { OxError } from "./functions";

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthNames = months.map(m => `${m}|${m.slice(0, 3)}`).join("|");
const dates = new RegExp([
  "\\b(?<isoYear>20\\d{2})-(?<isoMonth>\\d{2})-(?<isoDay>\\d{2})(?!\\d)",
  "(?:(?<zhYear>20\\d{2})年)?(?<zhMonth>\\d{1,2})月(?<zhDay>\\d{1,2})[日号]",
  `\\b(?<enMonth>${monthNames})\\.?\\s+(?<enDay>\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(?<enYear>20\\d{2})\\b)?`,
  `\\b(?<ukDay>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<ukMonth>${monthNames})\\.?\\b(?:,?\\s+(?<ukYear>20\\d{2})\\b)?`,
].join("|"), "giu");
const periods = { morning: "morning", afternoon: "afternoon", evening: "evening",
  早上: "morning", 上午: "morning", 下午: "afternoon", 傍晚: "evening", 晚上: "evening" } as const;
type Period = typeof periods[keyof typeof periods];
const periodWords = Object.keys(periods).join("|");
const afterDate = new RegExp(`^\\s*(?:in the\\s+)?(${periodWords})(?![a-z])`, "i");
const beforeDate = new RegExp(`(?:^|[^a-z])(${periodWords})\\s+(?:of\\s+|on\\s+)?$`, "i");
const alternative = new RegExp(`^\\s*(?:(?:in the\\s+)?(?:${periodWords}))?\\s*(?:or\\b|或(?:者)?)\\s*`, "i");
type Day = { month: number; day: number; year: number | null; period?: Period };
type Itinerary = { origin: string; destination?: string; exclusions: string[]; count: number; legs: Day[][]; partyTotal: boolean };

function periodAtDate(before: string, after: string, outbound: boolean): Period | undefined {
  const suffix = afterDate.exec(after), prefix = beforeDate.exec(before);
  const word = suffix?.[1] ?? prefix?.[1];
  if (!word) return;
  // An arrival or a return clock is not evidence for the outbound departure.
  const left = prefix ? before.slice(0, before.lastIndexOf(prefix[1]!)).trimEnd() : before;
  const right = suffix ? after.slice(suffix[0].length) : after;
  if (/(?:\barriv(?:e[sd]?|ing|al)(?:\s+(?:on|the|in))*|到达|抵达)\s*$/i.test(left)
    || /^\s*(?:arrival\b|到达|抵达)/i.test(right)
    || outbound && (/(?:\breturn(?:s|ing)?(?:\s+on)?|返程|返回)\s*$/i.test(left) || /^\s*(?:return\b|返程|返回)/i.test(right))) return;
  return periods[word.toLowerCase() as keyof typeof periods];
}

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
    end = m.index + m[0].length;
    const tail = text.slice(end, matches[i + 1]?.index), or = alternative.exec(tail);
    const outbound = groups.length === 1;
    group.push({ month, day, year, period: periodAtDate(between, tail, outbound) });
    if (or) {
      const short = /^(\d{1,2})(?:[日号]|(?:st|nd|rd|th)?\b)(?!\s*(?:[-/]|月))/i.exec(tail.slice(or[0].length));
      if (short && Number(short[1]) >= 1 && Number(short[1]) <= 31) {
        const length = or[0].length + short[0].length;
        group.push({ month, day: Number(short[1]), year, period: periodAtDate("", tail.slice(length), outbound) }); end += length;
      }
    }
  }
  const years = new Set(groups.flat().flatMap(d => d.year ? [d.year] : []));
  if (years.size === 1) for (const d of groups.flat()) d.year ??= [...years][0]!;
  return groups;
}

function excludedDestinations(text: string): string[] {
  const result: string[] = [];
  for (const m of text.matchAll(/(?:\bexclud(?:e|ing)\s+(?:destinations?\s*:\s*)?|排除(?:目的地[：:])?\s*)([^.;!?\n。，；！？]+)/giu)) {
    const terms = m[1]!.split(/\s+as destinations?\b/i, 1)[0]!.split(/\s+(?:and|or)\s+|\s*[,、/和及]\s*/iu);
    for (const term of terms.map(s => s.trim()).filter(Boolean)) {
      if (/\b(?:fees?|tax(?:es)?|bags?|baggage|layovers?|connections?|airlines?|refunds?)\b|行李费|改签费|税费|中转|经停/iu.test(term)) continue;
      result.push(/^[a-z]{3}$/i.test(term) && (term === term.toUpperCase() || term === term.toLowerCase()) ? term.toUpperCase() : term);
    }
  }
  return result;
}

// Admit only a complete code-to-code route. Prose such as "to New York" is not a route to NEW.
const endpointBoundary = /^\s*(?:(?:via|经)\s+[a-z]{3}\s*)?(?:$|[.;:；。：]|,?\s*(?:\d|\b(?:round[- ]trip|return|fare[s]?|departs?|outbound|on|leaving|nonstop|direct)\b|出发|往返|[年月日])|,?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/iu;
function eligibleDestination(trip: Itinerary, text: string, search: boolean) {
  if (!trip.exclusions.length) return true;
  const endpoints = [...text.matchAll(/(?<![a-z0-9])([a-z]{3})\s*(?:to\s+|→|[-–—]|至|到|飞往)\s*([a-z]{3})(?![a-z0-9])/gi)]
    .filter(m => m[1]!.toUpperCase() === trip.origin);
  if (endpoints.length) {
    const endpoint = endpoints[0]!;
    const tail = text.slice(endpoint.index + endpoint[0].length);
    return endpoints.length === 1 && endpointBoundary.test(tail)
      && trip.exclusions.every(s => /^[A-Z]{3}$/.test(s) && s !== endpoint[2]!.toUpperCase());
  }
  // Broad discovery may retain the original exclusions. Don't infer a metro area's airports from its name.
  const negatives = search ? excludedDestinations(text).map(s => s.toLowerCase()) : [];
  return search && trip.exclusions.every(s => negatives.includes(s.toLowerCase()));
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
    || !/\b(?:fares?|airfares?|prices?|costs?)\b|机票|票价/i.test(request)) return;
  if (/\b(?:train|rail|bus|ferry)\b|火车|高铁|客运|轮渡/i.test(request) && !/\b(?:flights?|airfare|airline)\b|机票|航班/i.test(request)) return;
  if (/\b(?:not|rather than|without) (?:a |an |the )?(?:fare|price)(?:s|\s+quote)?\b|(?:不问|不查|不看)(?:票价|价格)/i.test(request)
    || /^(?:when|how far in advance|what is (?:the|their) (?:refund|booking|cancellation) policy)\b/i.test(request.trim())) return;
  const route = /(?:\b[Ff]rom\s+|从\s*)([A-Z]{3})(?![A-Za-z])(?:\s*(?:[Tt]o\b|到|至|→|[-–])\s*([A-Z]{3})(?![A-Za-z]))?/.exec(request);
  const count = adultCount(request), legs = travelDates(request);
  if (!route || !count || legs.length !== 2) return;
  return { origin: route[1]!, destination: route[2], exclusions: excludedDestinations(request), count, legs, partyTotal: /\btotal\b|总价|合计|总票价/i.test(request) };
}

function matchesTrip(trip: Itinerary, text: string, search: boolean) {
  const codes: string[] = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const origin = codes.indexOf(trip.origin), actual = travelDates(text);
  return origin >= 0 && (!trip.destination || codes.slice(origin + 1).includes(trip.destination)) && adultCount(text) === trip.count && eligibleDestination(trip, text, search)
    && actual.length === 2 && actual.every((group, i) => group.every(day => trip.legs[i]!.some(wanted =>
      wanted.month === day.month && wanted.day === day.day && (!wanted.year || wanted.year === day.year) && (!wanted.period || wanted.period === day.period))));
}

export function checkFareSearch(trip: Itinerary, query: string) {
  if (!matchesTrip(trip, query, true)) {
    throw new OxError("invalid_argument", "This fare search does not preserve the requested itinerary. No search was sent.",
      "Use the requested route, an eligible destination or the original destination exclusions, one dated departure/return combination with its stated time of day, and the adult count. Do not include private notes.");
  }
}

const currency = "(?:USD|CAD|EUR|GBP|CNY|JPY|AUD|NZD|CHF|HKD|RMB)";
const number = "\\d+(?:,\\d{3})*(?:\\.\\d+)?";
const money = `(?:(?:[$€£¥]|\\b${currency}(?![a-z]))\\s*${number}|${number}\\s*(?:${currency}(?![a-z])|dollars\\b|euros\\b|元))`;
const party = "(?:(?:both|all|\\d+|one|two|three|four|five|six|seven|eight|nine)\\s+(?:adults?|passengers?)|the (?:party|group))";
const total = `(?:\\b(?:total (?:airfare|fare)|(?:party|group|trip|airfare|fare) total|total for ${party})\\b|(?:[一二两三四五六七八九1-9]位成人|机票|往返)总价|总票价)`;
const partyPrice = new RegExp(`(?:${total}\\s*(?:[:：=]|is\\b|was\\b|of\\b|为)?\\s*${money}|${money}\\s*${total})`, "iu");
const cashAmount = new RegExp(money, "iu");
const incidental = /\b(?:baggage|change|cancellation|service|seat) fees?\b|\b(?:deposit|surcharge|checked bags?)\b|行李费|改签费|退票费|定金/iu;
export function checkFareExcerpts(trip: Itinerary, excerpts: readonly string[]) {
  if (!excerpts.every(text => matchesTrip(trip, text, false) && (trip.partyTotal ? partyPrice.test(text) : cashAmount.test(text) && !incidental.test(text)))) {
    throw new OxError("invalid_argument", "The selected excerpts do not establish a cash fare for the requested itinerary. No fare answer was finalized.",
      "Select a self-contained offer with the applicable route, dates, adult count and currency amount. For a requested party total it must identify that amount as the total, not a per-person price or fee. Otherwise use unverifiedSource for a page actually read this turn.");
  }
}
