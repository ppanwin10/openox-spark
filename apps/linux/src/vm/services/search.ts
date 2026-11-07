import type { FunctionCall, FunctionHandler } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import { actionDetail, exposedActions, findAction, searchMaximum } from "./catalog";
import type { Services } from "./manager";
import { violations } from "./schema";
import { asOxError } from "./errors";
import { fail, isObject, type JSONObject } from "./support";

const defaultDomains = ["search.brave.com", "duckduckgo.com", "google.com", "reddit.com", "x.com", "en.wikipedia.org"];
const sessionSchema = { type: "object", properties: { id: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, url: { type: "string", minLength: 1 } },
  required: ["id", "label", "url"], additionalProperties: false };
const resultSchema = {
  type: "object", properties: {
    service: { type: "string" },
    items: { type: "array", maxItems: 50, items: { type: "object", properties: { title: { type: "string", minLength: 1 }, url: { type: ["string", "null"] },
      snippet: { type: ["string", "null"] }, id: { type: "string" }, data: { type: "object" } }, required: ["title", "url", "snippet"], additionalProperties: false } },
    nextCursor: { type: ["string", "null"] }, scope: { type: "string", minLength: 1 }, coverage: { type: "string", enum: ["complete", "partial", "unknown"] },
  }, required: ["service", "items", "nextCursor", "scope", "coverage"], additionalProperties: false,
};
const searchFailure = (code: string, message: string) => fail(code, message, "Inspect the service search contract before retrying.");

const urlCharacters = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?#[\]]|%[0-9A-Fa-f]{2})*$/;
const urlParts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;

export function canonicalSearchURL(value: unknown) {
  if (typeof value !== "string" || !urlCharacters.test(value)) return undefined;
  const match = urlParts.exec(value);
  if (!match) return undefined;
  const [, rawScheme, authority, path, rawQuery, fragment] = match;
  const scheme = rawScheme!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return undefined;
  const at = authority!.lastIndexOf("@");
  const userinfo = at >= 0 ? authority!.slice(0, at + 1) : "", hostPort = authority!.slice(at + 1);
  const hostEnd = hostPort.startsWith("[") ? hostPort.indexOf("]") + 1 : hostPort.lastIndexOf(":") >= 0 ? hostPort.lastIndexOf(":") : hostPort.length;
  if (hostEnd <= 0) return undefined;
  const host = hostPort.slice(0, hostEnd), portText = hostPort.slice(hostEnd);
  if (!host || (portText && !/^:\d*$/.test(portText))) return undefined;
  const port = portText.length > 1 ? Number(portText.slice(1)) : undefined;
  if (port !== undefined && port > 65_535) return undefined;
  let query = rawQuery ?? "";
  if (query.length > 1) {
    const parts = query.slice(1).split("&");
    const retained = parts.filter(part => {
      const encoded = part.split("=")[0]!;
      let name = encoded;
      try { name = decodeURIComponent(encoded); } catch {}
      name = name.toLowerCase();
      return !name.startsWith("utm_") && !["gclid", "dclid", "fbclid", "msclkid"].includes(name);
    });
    if (retained.length !== parts.length) query = retained.length ? `?${retained.join("&")}` : "";
  }
  const keepPort = port !== undefined && port !== (scheme === "https" ? 443 : 80);
  return `${scheme}://${userinfo}${host.toLowerCase()}${keepPort ? `:${port}` : ""}${path}${query}${fragment ?? ""}`;
}

interface Source { service: string; rank: number; title: string; url: unknown; snippet: unknown }
const text = (value: unknown) => typeof value === "string" ? value : "";
const precedes = (a: Source, b: Source) => a.rank !== b.rank ? a.rank - b.rank : a.service !== b.service ? (a.service < b.service ? -1 : 1)
  : text(a.url) !== text(b.url) ? (text(a.url) < text(b.url) ? -1 : 1) : a.title !== b.title ? (a.title < b.title ? -1 : 1)
  : text(a.snippet) < text(b.snippet) ? -1 : text(a.snippet) > text(b.snippet) ? 1 : 0;

export function mergeSearchResults(pages: JSONObject[]) {
  const canonical = new Map<string, Source[]>(), groups: Source[][] = [];
  for (const page of pages) {
    const service = page.service;
    if (typeof service !== "string") continue;
    (Array.isArray(page.items) ? page.items as JSONObject[] : []).forEach((item, index) => {
      const source: Source = { service, rank: index + 1, title: text(item.title), url: item.url ?? null, snippet: item.snippet ?? null };
      const key = canonicalSearchURL(source.url);
      if (key) canonical.set(key, [...canonical.get(key) ?? [], source]); else groups.push([source]);
    });
  }
  groups.push(...canonical.values());
  return groups.map(group => {
    const sources = [...group].sort(precedes);
    const best = new Map<string, number>();
    for (const source of sources) best.set(source.service, Math.min(best.get(source.service) ?? source.rank, source.rank));
    const score = [...best.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).reduce((total, [, rank]) => total + 1 / (60 + rank), 0);
    return { score, display: sources[0]!, sources };
  }).sort((a, b) => a.score !== b.score ? b.score - a.score : precedes(a.display, b.display))
    .map(result => ({ score: result.score, sources: result.sources.map(source => ({ service: source.service, rank: source.rank })) }));
}

export function searchFunction(services: Services): FunctionHandler {
  async function page(call: FunctionCall, domain: string, options: JSONObject) {
    const service = `web:${domain}`;
    const candidate = (await services.catalog.load()).selected.get(domain);
    if (!candidate || candidate.kind !== "web") {
      throw searchFailure("search_unsupported", `${domain} has no available web service. Use Evolve to build and verify its standard search action, then retry this domain.`);
    }
    let snapshot;
    try { snapshot = await services.load(candidate); }
    catch (error) { throw searchFailure("operation_failed", `${service} capabilities are unavailable: ${asOxError(error).message}`); }
    const definition = snapshot.definition;
    const action = findAction(definition, "search");
    if (!action || !exposedActions(definition).some(entry => entry.id === "search") || !actionDetail(definition, "search")) {
      throw searchFailure("search_unsupported", `${domain} does not expose standard search. Use Evolve to extend and verify its search action, then retry this domain.`);
    }
    if (action.requireApproval) throw searchFailure("invalid_contract", "Standard search must be read-only and requireApproval must be false.");
    const maximum = searchMaximum(definition, action);
    const limit = Math.min(typeof options.limit === "number" ? options.limit : 10, maximum);
    const cursor = isObject(options.cursors) ? options.cursors[domain] : undefined;
    const args: JSONObject = { query: options.query, limit, ...(cursor !== undefined ? { cursor } : {}) };
    const session = isObject(options.sessions) ? options.sessions[domain] : undefined;
    const value = await services.invoke(call, snapshot, "search", args, session);
    const result: JSONObject = { ...(isObject(value) ? value : {}), service };
    const issues = violations(result, resultSchema);
    const items = Array.isArray(result.items) ? result.items : [];
    if (issues.length || items.length > limit || !(result.nextCursor === null || result.coverage === "partial")) {
      throw searchFailure("invalid_output", `Search returned invalid results, too many items, or inconsistent coverage: ${issues.join("; ")}`);
    }
    if (cursor !== undefined && result.nextCursor === cursor) throw searchFailure("invalid_output", "Search cursor did not advance.");
    if (JSON.stringify(result).length > 1_000_000) throw searchFailure("resource_limit", "Search page exceeds the bounded response size.");
    return result;
  }

  return call => call.untimed(async () => {
    const options = call.args;
    const query = String(options.query ?? "");
    const domains = Array.isArray(options.domains) ? options.domains.map(String) : defaultDomains;
    if (!query.trim()) throw searchFailure("invalid_argument", "Search query must not be blank.");
    if (domains.length < 1 || domains.length > 6 || new Set(domains).size !== domains.length || domains.some(domain => !/^[a-z0-9.-]+$/.test(domain))) {
      throw searchFailure("invalid_argument", "Use one to six unique bare domains.");
    }
    for (const field of ["cursors", "sessions"] as const) {
      const values = isObject(options[field]) ? options[field] as JSONObject : {};
      if (!Object.keys(values).every(key => domains.includes(key))) throw searchFailure("invalid_argument", `${field} contains an unselected domain.`);
      for (const value of Object.values(values)) {
        const issues = violations(value, field === "sessions" ? sessionSchema : { type: "string", minLength: 1 });
        if (issues.length) throw searchFailure("invalid_argument", `${field}: ${issues.join("; ")}`);
      }
    }
    await services.approvals.require(call, "ox.web.search", "allow", { args: { ...options, domains } });
    const outcomes = await Promise.all(domains.map(async domain => {
      try { return { domain, page: await page(call, domain, options) }; }
      catch (error) {
        const failure = asOxError(error);
        if (["cancelled", "permission_denied", "handoff_incomplete"].includes(failure.code)) throw failure;
        services.context.logs.warning("services", `web.search service=web:${domain} code=${failure.code}`);
        return { domain, error: failure };
      }
    }));
    const results = outcomes.flatMap(outcome => outcome.page ? [outcome.page] : []);
    const errors = outcomes.flatMap(outcome => outcome.error ? [{ service: `web:${outcome.domain}`, code: outcome.error.code, message: outcome.error.message, recovery: outcome.error.recovery }] : []);
    if (!results.length) {
      throw new OxError("all_searches_failed", errors.map(error => `${error.service}: ${error.code}: ${error.message}`).join("; "),
        `${errors.map(error => `${error.service}: ${error.recovery}`).join("; ")} Do not substitute domains or report that no matches exist.`);
    }
    return { query, results, errors, mergedResults: mergeSearchResults(results) };
  });
}
