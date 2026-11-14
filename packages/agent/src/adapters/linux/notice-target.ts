export function noticeConversationID(targetUrl: string): number | null {
  const match = /^\/#\/c\/(0|[1-9]\d*)$/.exec(targetUrl);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
