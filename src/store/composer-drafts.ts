// Unsent composer text per conversation, so leaving a chat or switching to
// another does not throw away what someone was typing. Keyed by the chat-store
// channel key (`#name`, `dm:<peer>`, `group:<id>`).
//
// Memory only, as bitchat keeps them: a draft is plaintext message content and
// must not reach disk, and losing one when the app is killed is acceptable.
// The panic wipe clears them all, and leaving a conversation clears its own.

// Bounds so a pasted wall of text or a long session cannot grow this forever.
const MAX_DRAFT_LENGTH = 8_000;
const MAX_DRAFTS = 64;

// Insertion-ordered, so the oldest draft is the first key.
const drafts = new Map<string, string>();

export function loadDraft(channel: string): string {
  return drafts.get(channel) ?? "";
}

// An empty draft removes the entry. Saving moves it to the newest end, so the
// cap drops whatever was left alone longest.
export function saveDraft(channel: string, text: string): void {
  drafts.delete(channel);
  if (text.length === 0) return;
  drafts.set(channel, text.slice(0, MAX_DRAFT_LENGTH));
  if (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) drafts.delete(oldest);
  }
}

export function clearDrafts(): void {
  drafts.clear();
}
