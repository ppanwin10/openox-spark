import { connectorUpdatesSchema, discoveryInput, discoverySourceURL, OxError } from "@openox/agent/linux";
import { quietDiscoveryEnabled } from "../../config";
import { allowsURL } from "../net";
import type { Snapshot } from "./catalog";
import type { Services } from "./manager";
import { violations } from "./schema";
import { sha256 } from "./support";

const actionId = "listWorkspaceUpdates", interval = 30 * 60_000;
type Source = { snapshot: Snapshot; proof: string };
export function quietConnectorUpdates(services: Services) {
  const { context, preferences, approvals } = services, attempts = new Map<string, number>();
  const sources = async () => {
    const result = new Map<string, Source>();
    if (!quietDiscoveryEnabled(context.settings())) return result;
    await preferences.verify();
    const connected = preferences.connectedAPIs();
    if (!connected.length) return result;
    const policy = await approvals.current();
    if (policy.defaults.connectors !== "some" || approvals.policy("ox.feed.publish", "allow") !== "allow"
      || approvals.policy("ox.discovery.propose", "allow") !== "allow") return result;
    const allowed = connected.filter(({ domain }) => policy.actions[`ox.connector.background:${domain}`] === "allow"
      && (!policy.sources[domain] || policy.sources[domain] === "allow") && approvals.policy(`api:${domain}:${actionId}`, "allow") === "allow");
    if (!allowed.length) return result;
    await services.secrets.verify();
    const catalog = await services.catalog.load();
    for (const owner of allowed) {
      const candidate = catalog.selected.get(owner.domain);
      if (candidate?.kind !== "api" || candidate.repository.id !== owner.repository || await services.catalog.version(candidate) !== owner.definition) continue;
      const snapshot = await services.load(candidate), definition = snapshot.definition, action = definition.index.get(actionId);
      if (snapshot.version !== owner.definition || !action || action.requireApproval || !definition.baseUrl
        || violations({}, action.inputSchema, definition.defs).length) continue;
      if (services.api.requiresCredentials(definition) && (!action.requireAuth || services.api.loginState(definition) !== "signedIn")) continue;
      const proof = sha256(JSON.stringify([owner.domain, owner.revision, owner.repository, snapshot.version, services.api.credentialRevision(definition)]));
      result.set(owner.domain, { snapshot, proof });
    }
    return result;
  };
  return {
    quietConnectorProofs: async () => new Map([...(await sources())].map(([domain, entry]) => [domain, entry.proof])),
    pollQuietConnectors: async (signal: AbortSignal) => {
      const source = await sources(), store = context.profile().quietDiscovery, previous = await store.connectorState();
      const prior = new Map(previous.map(row => [row.domain, row]));
      for (const row of previous) if (source.get(row.domain)?.proof !== row.proof) await store.withdrawConnector(row.domain, row.proof);
      const current = new Set([...source.values()].map(entry => entry.proof));
      for (const key of attempts.keys()) if (!current.has(key)) attempts.delete(key);
      const lastCheck = (domain: string, proof: string) => {
        const row = prior.get(domain);
        return Math.max(attempts.get(proof) ?? 0, row?.proof === proof ? Date.parse(row.checkedAt) : 0);
      };
      let remaining = 4;
      for (const [domain, { snapshot, proof }] of [...source].sort(([a, x], [b, y]) => lastCheck(a, x.proof) - lastCheck(b, y.proof))) {
        if (Date.now() - lastCheck(domain, proof) < interval) continue;
        if (remaining === 0) break;
        remaining--;
        signal.throwIfAborted(); attempts.set(proof, Date.now());
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
        const guard = async () => {
          timeout.throwIfAborted();
          if (context.contentBlocked?.() || (await sources()).get(domain)?.proof !== proof)
            throw new OxError("permission_denied", "Connector update access changed.");
        };
        try {
          let requests = 0;
          const raw = await services.api.invoke({ signal: timeout }, snapshot, actionId, {}, async () => {
            if (++requests > 1) throw new OxError("limit_exceeded", "A discovery check permits one read-only request.");
            await guard();
          });
          if (requests !== 1) throw new OxError("invalid_state", "The connector did not read a source.");
          const updates = discoveryInput(connectorUpdatesSchema, raw);
          const origin = new URL(snapshot.definition.baseUrl!).origin;
          if (new Set(updates.items.map(item => item.id)).size !== updates.items.length ||
            updates.items.some(item => !item.title.trim() || !item.body.trim() || !discoverySourceURL(item.url) || !allowsURL(item.url) || new URL(item.url).origin !== origin))
            throw new OxError("invalid_output", "The connector supplied ambiguous updates or invalid source links.");
          await guard();
          await store.saveConnector(domain, proof, updates);
        } catch (error) {
          if (signal.aborted) return;
          context.logs.warning("quiet-discovery", `connector=${domain} update not accepted: ${error instanceof OxError ? error.code : "unavailable"}`);
        }
      }
    },
  };
}
