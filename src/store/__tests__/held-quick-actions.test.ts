// Replies typed into a notification before the mesh could send them, kept
// across the process ending.

import { getStorage } from "@store/mmkv";
import { OUTBOX_TTL_MS } from "@store/outbox-store";
import {
  clearHeldQuickActions,
  holdQuickAction,
  loadHeldQuickActions,
} from "../held-quick-actions";

const NOW = 1_700_000_000_000;

beforeEach(() => clearHeldQuickActions());

test("keeps answers in order until cleared", () => {
  holdQuickAction(
    { kind: "reply", channel: "dm:a", text: "hi", atMs: NOW },
    NOW,
  );
  holdQuickAction({ kind: "read", channel: "dm:b", atMs: NOW }, NOW);

  expect(loadHeldQuickActions(NOW).map((a) => a.channel)).toEqual([
    "dm:a",
    "dm:b",
  ]);
  clearHeldQuickActions();
  expect(loadHeldQuickActions(NOW)).toEqual([]);
});

// As a DM the outbox never delivered is dropped after its week.
test("drops a reply older than the outbox keeps mail", () => {
  holdQuickAction(
    { kind: "reply", channel: "dm:a", text: "hi", atMs: NOW },
    NOW,
  );
  expect(loadHeldQuickActions(NOW + OUTBOX_TTL_MS)).toEqual([]);
});

test("holds a bounded number", () => {
  let held = 0;
  for (let i = 0; i < 30; i++) {
    if (
      holdQuickAction(
        { kind: "read", channel: `dm:${String(i)}`, atMs: NOW },
        NOW,
      )
    ) {
      held++;
    }
  }
  expect(held).toBe(20);
});

test("reads damaged storage as nothing held", () => {
  const storage = getStorage("held-quick-actions");
  storage.set("actions", "{not json");
  expect(loadHeldQuickActions(NOW)).toEqual([]);
  storage.set("actions", JSON.stringify([{ kind: "reply", channel: 1 }, null]));
  expect(loadHeldQuickActions(NOW)).toEqual([]);
});
