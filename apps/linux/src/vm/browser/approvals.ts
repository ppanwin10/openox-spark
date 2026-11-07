import { Approvals } from "../approvals";

export class SiteApprovals {
  private approvals: Approvals;

  constructor(state: string) { this.approvals = Approvals.for(state); }

  private key(site: string) { return `ox.web.browser:${site}`; }
  async policy(site: string) { await this.approvals.load(); return this.approvals.policy(this.key(site), "ask"); }
  async allow(site: string) { await this.approvals.load(); await this.approvals.set(this.key(site), "allow"); }
}
