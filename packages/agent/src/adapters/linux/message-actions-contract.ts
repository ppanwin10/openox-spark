export const reactionEmojis = ["👍", "❤️", "😂", "🎉", "😮", "🙏"] as const;
export type ReactionEmoji = typeof reactionEmojis[number];
export type MessageRef = { profileId: string; conversationId: number; source: string; revision: string; epoch: number };
export type MessageTarget = { ref: MessageRef; role: "user" | "assistant"; emoji: ReactionEmoji | null };
export type MessageActionsView = { revision: number; targets: Record<string, MessageTarget> };
export type MessageSource = MessageTarget & { text: string; excerpt: string; truncated: boolean; actionRevision: number };
export type SubmissionProof = { requestId: string; status: string; replayed: boolean; inputApplied: boolean };
export const messageActionLimits = { targets: 1_000, requests: 5_000, metadataBytes: 2 * 1_048_576,
  sourceBytes: 1_048_576, reactionBodyBytes: 4_096, messageBodyBytes: 512 * 1_024, quoteScalars: 4_000, excerptScalars: 160 };
