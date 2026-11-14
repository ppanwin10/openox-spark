import { OxError, type FunctionCall } from "@openox/agent/linux";
import { Approvals, approvalAnswer, recordApproval } from "./approvals";
import { museParityEnabled } from "../config";

export interface ApprovalRequest { action: string; title: string; disclosure?: string; args?: Record<string, unknown>; detailLimit?: 4_000 | 32_768 }

const stores = new Map<string, FunctionApprovals>();
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;

export class FunctionApprovals {
  private approvals: Approvals;

  private constructor(state: string) { this.approvals = Approvals.for(state); }

  static for(state: string) {
    let store = stores.get(state);
    if (!store) { store = new FunctionApprovals(state); stores.set(state, store); }
    return store;
  }

  async require(call: FunctionCall, request: ApprovalRequest) {
    await this.approvals.load();
    if (museParityEnabled()) {
      const { purpose, ...rest } = request.args ?? call.args;
      const body = [typeof purpose === "string" ? purpose : "", request.disclosure ?? ""].filter(Boolean).join("\n") || request.title;
      return this.approvals.require(call, request.action, "ask", { title: request.title, body,
        ...(Object.keys(rest).length ? { detail: JSON.stringify(sorted(rest), null, 2).slice(0, request.detailLimit ?? 4000) } : {}) });
    }
    const { policy, scope } = this.approvals.resolution(request.action, "ask");
    if (policy === "block") {
      await recordApproval(call, request.action, "blockedByPolicy", scope);
      throw new OxError("permission_denied", `${request.action}: the user blocked this Action in Settings.`, "Do not bypass the policy. Ask the user to change it in Settings only if they want to allow this action.");
    }
    if (policy === "allow") { await recordApproval(call, request.action, "allowedByPolicy", scope); return; }
    const { purpose, ...rest } = request.args ?? call.args;
    const body = [typeof purpose === "string" ? purpose : "", request.disclosure ?? ""].filter(Boolean).join("\n") || request.title;
    const detail = Object.keys(rest).length ? JSON.stringify(sorted(rest), null, 2).slice(0, request.detailLimit ?? 4_000) : undefined;
    const answer = await approvalAnswer(call, request.action, scope, { kind: "approval", title: request.title, body, ...(detail ? { detail } : {}) });
    if (answer.kind !== "answer") {
      await recordApproval(call, request.action, "cancelled", scope);
      throw new OxError("cancelled", `${request.action}: the user stopped before answering.`, "Stop. Do not reopen the request unless the user asks.");
    }
    if (answer.text === "Always approve") { await this.approvals.set(request.action, "allow"); await recordApproval(call, request.action, "alwaysApproved", scope); return; }
    if (answer.text !== "Approve") {
      await recordApproval(call, request.action, "denied", scope);
      throw new OxError("permission_denied", `${request.action}: the user declined.`, "Stop. Do not repeat the action unless the user asks.");
    }
    await recordApproval(call, request.action, "approved", scope);
  }
}
