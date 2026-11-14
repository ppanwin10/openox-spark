import { Approvals } from "../approvals";
import type { FunctionCall } from "@openox/agent/linux";
import { museParityEnabled } from "../../config";
import type { BrowserCapability } from "../permissions";

export class SiteApprovals {
  private approvals: Approvals;
  private familiar: (url: string) => Promise<boolean>;

  constructor(state: string, familiar: (url: string) => Promise<boolean> = async () => false) {
    this.approvals = Approvals.for(state); this.familiar = familiar;
  }

  private key(site: string) { return `ox.web.browser:${site}`; }
  async policy(site: string) { await this.approvals.load(); return this.approvals.policy(this.key(site), "ask"); }
  async allow(site: string) { await this.approvals.load(); await this.approvals.set(this.key(site), "allow"); }
  async require(call: FunctionCall, site: string, body: string, sourceURL?: string) {
    await this.approvals.load();
    await this.approvals.require(call, this.key(site), "ask", { title: `Browser - ${site}`, body, sourceURL });
  }
  async blocked(call: FunctionCall, capability: BrowserCapability, site?: string, sourceURL?: string) {
    if (!museParityEnabled()) return;
    await this.approvals.current();
    const target = site ?? null;
    if (this.approvals.browserResolution(target, capability).policy === "block") {
      await this.approvals.require(call, target ? `ox.web.browser:${target}:${capability}` : `ox.web.browser.${capability}`, "ask",
        { sourceURL, browser: { site: target, capability, familiar: false } });
    }
  }
  async capability(call: FunctionCall, site: string | null, capability: BrowserCapability, body: string, sourceURL?: string) {
    if (!museParityEnabled()) return;
    await this.blocked(call, capability, site ?? undefined, sourceURL);
    if (this.approvals.scheduled(call) && capability !== "background") await this.capability(call, site, "background", "Use Browser in this scheduled task.", sourceURL);
    const action = site ? `ox.web.browser:${site}:${capability}` : `ox.web.browser.${capability}`;
    const resolution = this.approvals.browserResolution(site, capability);
    const familiar = capability === "visit" && this.approvals.defaults.web === "some" && resolution.scope === "fallback"
      && resolution.policy === "ask" && !!sourceURL && await this.familiar(sourceURL);
    await this.approvals.require(call, action, "ask", {
      title: site ? `Browser - ${site}` : "Browser", body, sourceURL, browser: { site, capability, familiar },
    });
  }
  guard(call: FunctionCall) { return this.approvals.guard(call); }
  async network(site: string | null, currentSite: string | null) {
    if (!museParityEnabled()) return true;
    await this.approvals.current();
    if (!site) return false;
    const stored = this.approvals.stored();
    if (this.approvals.browserResolution(site, "read").policy === "block" || this.approvals.browserResolution(site, "visit").policy === "block") return false;
    return site === currentSite || stored.actions[`ox.web.browser:${site}`] === "allow";
  }
}
