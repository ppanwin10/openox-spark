import { Approvals } from "../approvals";
import type { FunctionCall } from "@openox/agent/linux";
import { museParityEnabled } from "../../config";
import type { BrowserCapability } from "../permissions";

export class SiteApprovals {
  private approvals: Approvals;

  constructor(state: string) { this.approvals = Approvals.for(state); }

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
    const stored = this.approvals.stored();
    const keys = [`ox.web.browser.${capability}`, ...(site ? [`ox.web.browser:${site}`, `ox.web.browser:${site}:${capability}`] : [])];
    for (const key of keys) if (this.approvals.policy(key, "ask") === "block") await this.approvals.require(call, key, "ask", { sourceURL });
    if (stored.sources.ox === "block") await this.approvals.require(call, "ox.web.browser.read", "ask", { sourceURL });
  }
  async capability(call: FunctionCall, site: string | null, capability: BrowserCapability, body: string, sourceURL?: string) {
    if (!museParityEnabled()) return;
    await this.blocked(call, capability, site ?? undefined, sourceURL);
    if (this.approvals.scheduled(call) && capability !== "background") await this.capability(call, site, "background", "Use Browser in this scheduled task.", sourceURL);
    const action = site ? `ox.web.browser:${site}:${capability}` : `ox.web.browser.${capability}`;
    await this.approvals.require(call, action, this.approvals.browserFallback(site ?? "", capability), {
      title: site ? `Browser - ${site}` : "Browser", body, sourceURL,
    });
  }
  guard(call: FunctionCall) { return this.approvals.guard(call); }
  async network(site: string | null, currentSite: string | null) {
    if (!museParityEnabled()) return true;
    await this.approvals.current();
    if (!site) return false;
    const stored = this.approvals.stored();
    for (const key of ["ox.web.browser.read", "ox.web.browser.visit", `ox.web.browser:${site}`, `ox.web.browser:${site}:read`, `ox.web.browser:${site}:visit`]) {
      if (this.approvals.policy(key, "ask") === "block") return false;
    }
    return site === currentSite || stored.actions[`ox.web.browser:${site}`] === "allow";
  }
}
