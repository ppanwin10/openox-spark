import { OxError } from "@openox/agent/linux";
import { Value } from "typebox/value";
import { messageRefSchema } from "../../../packages/agent/src/adapters/linux/message-actions";
import { messageActionLimits as limits, type MessageRef, type SubmissionProof } from "../../../packages/agent/src/adapters/linux/message-actions-contract";
import type { Host } from "./host";
import { sameOrigin } from "./auth";
import { museParityEnabled } from "./config";
import { HTTPError, json, payload } from "./http";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function messageActionError(error: OxError) {
  const status = error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400
    : error.code === "limit_exceeded" ? error.message.includes("source budget") ? 413 : 507 : 503;
  return new HTTPError(status, error.message);
}
function admission(request: Request) {
  if (!museParityEnabled()) throw new HTTPError(404, "Not found");
  if (!sameOrigin(request)) throw new HTTPError(403, "Use the paired workspace origin for message actions.");
}
export async function messageActionRoute(host: Host, request: Request, url: URL, id: number, parts: string[], owner: string) {
  admission(request);
  const action = parts[0], receipt = parts[1];
  if (action === "message-source" && parts.length === 1 && request.method === "GET") {
    for (const key of url.searchParams.keys()) if (!["source", "revision", "profileId", "epoch", "window"].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HTTPError(400, "Invalid or repeated message source parameter.");
    }
    const epoch = url.searchParams.get("epoch"), window = url.searchParams.get("window");
    const ref = { profileId: url.searchParams.get("profileId"), conversationId: id, source: url.searchParams.get("source"),
      revision: url.searchParams.get("revision"), epoch: epoch && /^(0|[1-9]\d*)$/.test(epoch) ? Number(epoch) : null };
    if (!Value.Check(messageRefSchema, ref) || window !== null && window !== "1") throw new HTTPError(400, "Choose an original canonical message source.");
    const source = await host.profile.messageActionsOwner().readSource(ref as MessageRef, host.contentEpoch);
    return json({ ...source, ...(window ? { view: await host.profile.searchView(id, Number(ref.source!.split(":")[0]), request.signal) } : {}) });
  }
  if (action === "reactions" && parts.length === 1 && request.method === "POST" && !url.search) {
    const input = await payload<Parameters<typeof host.profile.react>[1]>(request, limits.reactionBodyBytes);
    return json(await host.profile.react(id, input, owner, host.contentEpoch));
  }
  if (parts.length === 2 && receipt && uuid.test(receipt) && request.method === "GET" && !url.search) {
    if (action === "reactions") return json(await host.profile.messageActionsOwner().reactionStatus(id, receipt, owner, host.contentEpoch));
    if (action === "submissions") return json(await host.profile.messageActionsOwner().submissionStatus(id, receipt, owner));
  }
  throw new HTTPError(404, "Not found");
}

export async function messageSubmission(host: Host, request: Request, id: number, body: Record<string, unknown>, owner: string, timeZone?: string) {
  admission(request);
  if (Object.keys(body).some(key => !["text", "attachments", "reply", "requestId"].includes(key))
    || typeof body.requestId !== "string" || !uuid.test(body.requestId)
    || body.reply !== undefined && !Value.Check(messageRefSchema, body.reply)
    || body.text !== undefined && typeof body.text !== "string" || body.attachments !== undefined && (!Array.isArray(body.attachments)
      || body.attachments.length > 10 || body.attachments.some(path => typeof path !== "string" || path.length > 4_096 || /[\r\n\0]/.test(path)))) {
    throw new HTTPError(400, "Send only the new request, original attachment paths, canonical Reply ref and UUID request identity.");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "", files = body.attachments as string[] | undefined ?? [];
  if (text.length > 100_000) throw new HTTPError(413, "Messages are limited to 100,000 characters");
  if (!text && !files.length) throw new HTTPError(400, "Write a message or attach a file");
  const requestId = body.requestId, reply = body.reply as MessageRef | undefined, content = text || "Please review the attached files.";
  const previous = await host.profile.messageActionsOwner().replayedSubmission(id, content, files, requestId, reply, owner);
  if (previous) return json({ accepted: true, ...previous });
  if (host.profile.busy(id)) throw new HTTPError(409, "This conversation is still working. Read the original submission receipt; do not resend.");
  await host.profile.ready(id);
  const proof = await new Promise<SubmissionProof>((resolve, reject) => {
    let confirmed = false;
    host.submit(id, content, files, undefined, requestId, undefined, { owner, epoch: host.contentEpoch, reply,
      admitted: value => { confirmed = true; resolve(value); }, refused: reject }, timeZone).then(outcome => {
      if (!confirmed) reject(new HTTPError(503, "Original submission admission is unconfirmed. Read its receipt before another send."));
      if (outcome.outcome === "failed") host.logs.warning("conversation", `message run failed conversation=${id} request=${requestId}`);
    }, reject);
  });
  host.logs.info("conversation", `message admission conversation=${id} request=${requestId} replayed=${proof.replayed} characters=${text.length} attachments=${files.length}`);
  return json({ accepted: true, ...proof }, { status: proof.inputApplied ? 202 : 200 });
}
