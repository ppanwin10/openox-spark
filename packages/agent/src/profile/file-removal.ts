export const fileRemovalLimits = { files: 20, selectedBytes: 32 * 1024 * 1024, requestBytes: 32 * 1024, receipts: 1_000 } as const;
export type FileRemovalTarget = { id: string; path: string; size: number; sha256: string; revision: string };
export type FileRemovalScope = { version: 1; hostId: string; profileId: string; callerId: string; epoch: number };
export type FileRemovalRequest = FileRemovalScope & { requestId: string; confirmed: true; files: FileRemovalTarget[] };
export type FileRemovalReceipt = FileRemovalScope & {
  requestId: string; fingerprint: string; files: FileRemovalTarget[]; status: "committed" | "conflict";
};
export const fileRemovalInput = (input: FileRemovalRequest) => JSON.stringify([
  input.version, input.hostId, input.profileId, input.callerId, input.epoch, input.requestId,
  input.files.map(file => [file.id, file.path, file.size, file.sha256, file.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
]);
export const sameRemovalScope = (left: FileRemovalScope, right: FileRemovalScope) =>
  left.version === right.version && left.hostId === right.hostId && left.profileId === right.profileId && left.callerId === right.callerId && left.epoch === right.epoch;
