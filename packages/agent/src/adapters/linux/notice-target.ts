export function noticeConversationID(targetUrl: string): number | null {
  const match = /^\/#\/c\/(0|[1-9]\d*)$/.exec(targetUrl);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export function noticeTask(tag: string): { kind: "todo" | "goal-schedule"; id: string } | null {
  const match = /^(todo|goal)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(tag);
  return match ? { kind: match[1]!.toLowerCase() === "todo" ? "todo" : "goal-schedule", id: match[2]! } : null;
}
