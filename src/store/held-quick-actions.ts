// Reply and Mark as read taken from a notification before anything could act
// on them: an iOS background launch that never got as far as the mesh, or a
// tap that arrived while the mesh was down. Kept on disk until the next mesh
// start sends them, so a reply typed into a card is not lost to the process
// ending. An Android process the OS reclaimed is not covered: the tray wakes
// it with no JavaScript to take the action, so the reply waits in that
// process's memory, sent only if the app opens before the process ends
// (expo-notifications runs only TaskManager tasks headless).
// A reply is message content, so it lives where messages do, and the panic
// wipe clears this partition with theirs.

import { getStorage } from "./mmkv";
import { OUTBOX_TTL_MS } from "./outbox-store";

export type QuickAction =
  | { kind: "reply"; channel: string; text: string; atMs: number }
  | { kind: "read"; channel: string; atMs: number };

// Bounded, since nothing drains this until a mesh starts.
const MAX_HELD = 20;
const KEY = "actions";

const storage = getStorage("held-quick-actions");

function isQuickAction(value: unknown): value is QuickAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.channel !== "string" || typeof v.atMs !== "number") {
    return false;
  }
  return (
    v.kind === "read" || (v.kind === "reply" && typeof v.text === "string")
  );
}

// What is still held, oldest first. Past the outbox's week a reply is dropped,
// as a DM the outbox never delivered is.
export function loadHeldQuickActions(nowMs: number): QuickAction[] {
  const raw = storage.getString(KEY);
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isQuickAction)
    .filter((a) => nowMs - a.atMs < OUTBOX_TTL_MS);
}

// Returns false when the bound is reached and the action was not held.
export function holdQuickAction(action: QuickAction, nowMs: number): boolean {
  const held = loadHeldQuickActions(nowMs);
  if (held.length >= MAX_HELD) return false;
  held.push(action);
  storage.set(KEY, JSON.stringify(held));
  return true;
}

export function clearHeldQuickActions(): void {
  storage.remove(KEY);
}
