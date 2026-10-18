// The chat row a public message's Bluetooth and Nostr copies share.
import { sharedRowID } from "../shared-row-id";

describe("sharedRowID", () => {
  // Pinned from the current implementation: both copies, on every build, have
  // to land on this exact row.
  it("collapses the two copies of one message", () => {
    expect(sharedRowID("m-1", "the gate is open")).toBe(
      "ch-28a3cb71b70aecb7128d26151a48b998",
    );
  });

  // Anyone who read the ID can send other words under it; those must not
  // take the genuine message's row.
  it("gives other text under the same ID its own row", () => {
    expect(sharedRowID("m-1", "the gate is closed")).not.toBe(
      sharedRowID("m-1", "the gate is open"),
    );
  });

  it("keeps the ID and text apart, so no split of one collides with another", () => {
    expect(sharedRowID("a|b", "c")).not.toBe(sharedRowID("a", "b|c"));
  });

  it("is a ch- row of fixed length", () => {
    expect(sharedRowID("m", "x")).toMatch(/^ch-[0-9a-f]{32}$/);
  });
});
