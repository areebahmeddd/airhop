/**
 * @jest-environment node
 */
import { sharedRowID } from "../shared-row-id";

describe("sharedRowID", () => {
  it("collapses the two copies of one message", () => {
    expect(sharedRowID("m-1", "the gate is open")).toBe(
      sharedRowID("m-1", "the gate is open"),
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
