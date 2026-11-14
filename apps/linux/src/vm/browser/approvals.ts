import { Approvals } from "../approvals";
import type { FunctionCall } from "@openox/agent/linux";

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
}
