import { BoundedIdSet } from "../bounded-id-set";

describe("BoundedIdSet", () => {
  it("holds up to its capacity", () => {
    const set = new BoundedIdSet(3);
    for (const id of ["a", "b", "c"]) set.add(id);

    expect(set.size).toBe(3);
    expect(["a", "b", "c"].every((id) => set.has(id))).toBe(true);
  });

  it("drops the oldest added once past it", () => {
    const set = new BoundedIdSet(3);
    for (const id of ["a", "b", "c", "d"]) set.add(id);

    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(false);
    expect(set.has("d")).toBe(true);
  });

  it("re-adding a held ID evicts nothing", () => {
    const set = new BoundedIdSet(2);
    set.add("a");
    set.add("b");
    set.add("a");

    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });

  it("clears", () => {
    const set = new BoundedIdSet(2);
    set.add("a");
    set.clear();

    expect(set.size).toBe(0);
    expect(set.has("a")).toBe(false);
  });
});
