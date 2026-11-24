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
type Itinerary = { origin: string; destination?: string; exclusions: string[]; count: number; legs: Day[][]; partyTotal: boolean; estimateRequested: boolean };

function periodAtDate(before: string, after: string, outbound: boolean): Period | undefined {
  const suffix = afterDate.exec(after), prefix = beforeDate.exec(before);
  const word = suffix?.[1] ?? prefix?.[1];
  if (!word) return;
  // An arrival or a return clock is not evidence for the outbound departure.
  const left = prefix ? before.slice(0, before.lastIndexOf(prefix[1]!)).trimEnd() : before;
  const right = suffix ? after.slice(suffix[0].length) : after;
  if (/(?:\barriv(?:e[sd]?|ing|al)(?:\s+(?:on|the|in))*|到达|抵达)\s*$/i.test(left)
    || /^\s*(?:arrival\b|到达|抵达)/i.test(right)
    || outbound && (/(?:\breturn(?:s|ing)?(?:\s+on)?|返程|返回)\s*$/i.test(left) || /^\s*(?:return\b|返程|返回)/i.test(right) && !/^\s*(?:return|返程|返回)\s*(?:on\s*)?$/i.test(right))) return;
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
const codeRoute = /(?<![a-z0-9])([a-z]{3})\s*(?:to\s+|->|→|[-–—]|至|到|飞往)\s*([a-z]{3})(?![a-z0-9])/gi;
const endpointBoundary = /^\s*(?:(?:via\s+|经\s*)[a-z]{3}\s*)?(?:$|[.;:；。：]|[,，]?\s*(?:\d|\b(?:round[- ]trip|return|fares?|departs?|outbound|on|leaving|nonstop|direct)\b|for\s+(?:[1-9]\d?|one|two|three|four|five|six|seven|eight|nine)\s+adults?\b|出发|的?往返|[年月日])|,?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/iu;
const onwardSegment = /(?:\b(?:then(?:\s+on(?:ward)?)?|onward|continu(?:es?|ing)(?:\s+on)?|connect(?:s|ing)?)\s+to\s+|(?:再|继续|接着|然后)(?:飞往|飞到|到|至))([a-z]{3})(?![a-z0-9])/giu;
function hasOnwardAirport(tail: string) {
  return [...tail.matchAll(onwardSegment)].some(m =>
    m[1] === m[1]!.toUpperCase() || endpointBoundary.test(tail.slice(m.index + m[0].length)));
}
function eligibleDestination(trip: Itinerary, text: string, search: boolean) {
  const { origin, destination, exclusions } = trip;
  if (!destination && !exclusions.length) return true;
  const routes = [...text.matchAll(codeRoute)].filter(m => {
    const from = m[1]!.toUpperCase(), to = m[2]!.toUpperCase();
    return from === origin || to === origin || from === destination || to === destination || (m[1] === from && m[2] === to);
  });
  const [out, back] = routes;
  if (out) {
    const endpoint = out[2]!.toUpperCase();
    if (out[1]!.toUpperCase() !== origin || (destination && endpoint !== destination)
      || hasOnwardAirport(text.slice(out.index + out[0].length))
      || /(?:\b(?:return(?:ing)?(?: leg)?|inbound)|返程)\s*[:：]?\s*$/iu.test(text.slice(0, out.index))) return false;
    // A second pair may describe the journey home, not a competing outbound fare.
    return routes.length <= 2 && (!back || (back[1]!.toUpperCase() === endpoint && back[2]!.toUpperCase() === origin))
      && routes.every(m => endpointBoundary.test(text.slice(m.index + m[0].length)))
      && exclusions.every(s => /^[A-Z]{3}$/.test(s) && s !== endpoint);
  }
  // Broad discovery may retain the original exclusions. Don't infer a metro area's airports from its name.
  if (destination || !search) return false;
  const negatives = excludedDestinations(text).map(s => s.toLowerCase());
  return exclusions.every(s => negatives.includes(s.toLowerCase()));
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
  const estimateRequested = /^(?:please\s+)?(?:estimate\b|(?:give|provide)\s+(?:me\s+)?(?:an?\s+)?(?:approximate|estimated|rough)\s+(?:fare|price|cost|total)\b)|^(?:请)?(?:估算|预估)/iu.test(request.trim())
    && !/\b(?:not an estimate|no estimates?|actual|confirmed|bookable)\b|不要估算|非估算|实际票价/iu.test(request);
  return { origin: route[1]!, destination: route[2], exclusions: excludedDestinations(request), count, legs,
    partyTotal: /\btotal\b|总价|合计|总票价/i.test(request), estimateRequested };
}

function matchesTrip(trip: Itinerary, text: string, search: boolean) {
  const codes: string[] = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const actual = travelDates(text);
  return codes.includes(trip.origin) && adultCount(text) === trip.count && eligibleDestination(trip, text, search)
    && actual.length === 2 && actual.every((group, i) => group.every(day => trip.legs[i]!.some(wanted =>
      wanted.month === day.month && wanted.day === day.day && (!wanted.year || wanted.year === day.year) && (!wanted.period || wanted.period === day.period))));
}

export function checkFareSearch(trip: Itinerary, query: string) {
  if (!matchesTrip(trip, query, true)) {
    throw new OxError("invalid_argument", "This fare search does not preserve the requested itinerary. No search was sent.",
      "Use the requested outbound origin and destination (not just a connection), or preserve the original destination exclusions for an open search. Keep one dated departure/return combination with its stated time of day and the adult count. Do not include private notes.");
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
const estimateBefore = /(?:\b(?:estimated?|indicative|projected|forecast|approx(?:imately|imate)?|roughly|about|around)\b(?:\.|:)?\s*(?:(?:round[- ]trip|party|group|total|airfare|fare|price|cost|only|of|at|is|the)\b[\s.:：-]*){0,6}|(?:预估|估算|预计|大约|约)(?:的|往返|票价|总价|为|是|[：:\s])*)$/iu;
const estimateAfter = /^\s*[,，:(（-]?\s*(?:(?:(?:is|was)\s+)?(?:an?\s+)?(?:estimate(?:d)?|forecast|projection|approximate(?:ly)?|indicative)(?:\s+only)?\b(?=\s*(?:[.,;:!?)）]|$))|(?:仅供参考|估算(?:值)?|预估(?:值)?|左右))/iu;
const estimatedPartyPrice = new RegExp(`${total}\\s*(?:[:：=]|is\\b|was\\b|of\\b|为)?\\s*(?:approximately|about|around|roughly|estimated\\s+at|预估|预计|约)\\s*${money}`, "iu");
function fareAmount(trip: Itinerary, text: string) {
  if (!trip.partyTotal && incidental.test(text)) return false;
  const matches = [...text.matchAll(new RegExp((trip.partyTotal ? partyPrice : cashAmount).source, "giu"))];
  if (!matches.length) return trip.estimateRequested && trip.partyTotal && estimatedPartyPrice.test(text);
  // Check qualifiers adjacent to the selected amounts; an estimate of baggage cost or flying time is not a fare estimate.
  return trip.estimateRequested || matches.every(m => !estimateBefore.test(text.slice(0, m.index)) && !estimateAfter.test(text.slice(m.index + m[0].length)));
}
// Rejection-only metro map for related fares: an unlisted metro name disables related fares rather than guessing.
const metroAirports: Record<string, string[]> = { "new york city": ["JFK", "LGA", "EWR"], "new york": ["JFK", "LGA", "EWR"], nyc: ["JFK", "LGA", "EWR"],
  "los angeles": ["LAX", "BUR", "LGB", "SNA", "ONT"], la: ["LAX", "BUR", "LGB", "SNA", "ONT"] };
function relatedFare(trip: Itinerary, text: string) {
  const out = [...text.matchAll(codeRoute)][0];
  if (!out || out[1]!.toUpperCase() !== trip.origin) return false;
  const endpoint = out[2]!.toUpperCase();
  if (trip.destination && endpoint !== trip.destination) return false;
  const excluded = new Set<string>();
  for (const name of trip.exclusions) {
    if (/^[A-Z]{3}$/.test(name)) { excluded.add(name); continue; }
    const airports = metroAirports[name.toLowerCase()];
    if (!airports) return false;
    for (const code of airports) excluded.add(code);
  }
  if (excluded.has(endpoint)) return false;
  const requested = trip.legs.flat();
  const days = travelDates(text).flat();
  const dated = days.length > 0 && days.every(day => requested.some(wanted => wanted.month === day.month && wanted.day === day.day
    && (!wanted.year || !day.year || wanted.year === day.year) && (!wanted.period || !day.period || wanted.period === day.period)));
  return dated && fareAmount({ ...trip, partyTotal: false, estimateRequested: false }, text);
}
export function relatedFareExcerpts(trip: Itinerary, excerpts: readonly string[]) {
  return excerpts.length > 0 && excerpts.every(text => relatedFare(trip, text));
}
export function checkFareExcerpts(trip: Itinerary, excerpts: readonly string[]) {
  if (!excerpts.every(text => matchesTrip(trip, text, false) && fareAmount(trip, text))) {
    throw new OxError("invalid_argument", "The selected excerpts do not establish a cash fare for the requested itinerary. No fare answer was finalized.",
      "Select a self-contained offer with the applicable route, dates, adult count and currency amount. Do not use an estimate as a quoted fare. A party total must identify the total, not a per-person price or fee. Otherwise use unverifiedSource for a page actually read this turn.");
  }
}
