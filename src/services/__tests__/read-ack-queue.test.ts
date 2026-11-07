import { MAX_PER_CHANNEL } from "@store/chat-store";
import { ReadAckQueue } from "../read-ack-queue";

describe("ReadAckQueue", () => {
  // A thread shows its newest 200 messages, so no more receipts than that are
  // owed, and opening it sends each once.
  test("250 messages from one sender leave 200 owed, the newest", () => {
    const q = new ReadAckQueue(MAX_PER_CHANNEL);
    for (let i = 0; i < 250; i++) q.add("alice", `m${i}`);
    const sent = q.take("alice");
    expect(sent).toHaveLength(200);
    expect(sent[0]).toBe("m50");
    expect(sent[199]).toBe("m249");
    expect(q.take("alice")).toEqual([]);
  });

  test("a repeated ID is owed once", () => {
    const q = new ReadAckQueue(3);
    q.add("alice", "a");
    q.add("alice", "a");
    q.add("alice", "b");
    expect(q.take("alice")).toEqual(["a", "b"]);
  });

  test("conversations are bounded separately", () => {
    const q = new ReadAckQueue(2);
    for (const id of ["1", "2", "3"]) q.add("alice", id);
    q.add("bob", "x");
    expect(q.take("alice")).toEqual(["2", "3"]);
    expect(q.take("bob")).toEqual(["x"]);
  });

  test("retain drops the conversations that are gone", () => {
    const q = new ReadAckQueue(10);
    q.add("alice", "a");
    q.add("bob", "b");
    q.retain((key) => key === "bob");
    expect(q.take("alice")).toEqual([]);
    expect(q.take("bob")).toEqual(["b"]);
  });
});

describe("ReadAckQueue.forget", () => {
  // A message disappearing messages removed was never read here, and a receipt
  // for it would say it was.
  test("drops the given IDs from every conversation, and empty ones", () => {
    const q = new ReadAckQueue(10);
    q.add("alice", "a1");
    q.add("alice", "a2");
    q.add("bob", "b1");
    q.forget(new Set(["a1", "b1"]));
    expect(q.has("bob")).toBe(false);
    expect(q.take("alice")).toEqual(["a2"]);
  });
});
