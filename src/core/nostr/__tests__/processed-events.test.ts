// The record of inbox deliveries already acted on, and when it reaches disk.
//
// An ID on disk before the chat row it filed would, after a kill between the
// two, have the next launch skip a message this phone never kept. So an ID is
// held in memory at once and written after chat-store's 400 ms throttle, and a
// panic wipe drops what is still waiting rather than letting it land after.

import { getStorage } from "@store/mmkv";
import {
  dropPendingProcessedEvents,
  flushProcessedEvents,
  PROCESSED_EVENTS_STORAGE_ID,
  ProcessedEvents,
} from "../processed-events";

const storage = getStorage(PROCESSED_EVENTS_STORAGE_ID);
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

beforeEach(() => {
  jest.useFakeTimers();
  dropPendingProcessedEvents();
  storage.clearAll();
});

afterEach(() => {
  jest.useRealTimers();
});

test("an ID is known at once and written only after the chat row's throttle", () => {
  const inbox = new ProcessedEvents("dm", LOOKBACK_SECONDS);
  inbox.add("wrap-1");
  expect(inbox.has("wrap-1")).toBe(true);
  jest.advanceTimersByTime(400);
  expect(storage.getString("dm:wrap-1")).toBeUndefined();
  jest.advanceTimersByTime(600);
  expect(storage.getString("dm:wrap-1")).toBeDefined();
  expect(new ProcessedEvents("dm", LOOKBACK_SECONDS).has("wrap-1")).toBe(true);
});

test("a flush writes what is waiting, for an app leaving the foreground", () => {
  const inbox = new ProcessedEvents("dm", LOOKBACK_SECONDS);
  inbox.add("wrap-1");
  flushProcessedEvents();
  expect(storage.getString("dm:wrap-1")).toBeDefined();
});

test("an inbox rebuilt before the write still knows the ID", () => {
  new ProcessedEvents("dm", LOOKBACK_SECONDS).add("wrap-1");
  expect(new ProcessedEvents("dm", LOOKBACK_SECONDS).has("wrap-1")).toBe(true);
});

test("a panic wipe drops what is waiting, and nothing recorded later lands", () => {
  const inbox = new ProcessedEvents("dm", LOOKBACK_SECONDS);
  inbox.add("wrap-1");
  dropPendingProcessedEvents();
  storage.clearAll();
  // An inbox from before the wipe still running.
  inbox.add("wrap-2");
  jest.advanceTimersByTime(5_000);
  flushProcessedEvents();
  expect(storage.getAllKeys()).toEqual([]);

  // One built after it writes as usual.
  new ProcessedEvents("dm", LOOKBACK_SECONDS).add("wrap-3");
  jest.advanceTimersByTime(1_000);
  expect(storage.getAllKeys()).toEqual(["dm:wrap-3"]);
});
