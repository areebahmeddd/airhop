// The one table of links the mesh holds.
//
// Ordering is asserted rather than assumed: couriers are chosen by taking the
// first few `directPeers()`, so a reshuffle silently changes who carries the
// mail.
import {
  LinkRegistry,
  TRANSPORT_KINDS,
  type LinkWriteFn,
  type TransportKind,
} from "../link-registry";

interface Recorder {
  readonly writes: { linkID: string; data: string }[];
  readonly writers: Record<TransportKind, LinkWriteFn>;
  fail(linkID: string): void;
}

function recorder(): Recorder {
  const writes: { linkID: string; data: string }[] = [];
  const failing = new Set<string>();
  const write = (): LinkWriteFn => (linkID, data) => {
    if (failing.has(linkID)) return Promise.reject(new Error("refused"));
    writes.push({ linkID, data });
    return Promise.resolve();
  };
  return {
    writes,
    writers: { ble: write(), wifi: write(), lan: write() },
    fail: (linkID) => failing.add(linkID),
  };
}

describe("LinkRegistry", () => {
  let rec: Recorder;
  let links: LinkRegistry;

  beforeEach(() => {
    rec = recorder();
    links = new LinkRegistry(rec.writers);
  });

  describe("lifecycle", () => {
    it("counts open links per radio and in total", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:2");
      links.open("wifi", "wifi-1");

      expect(links.size()).toBe(3);
      expect(links.size("ble")).toBe(2);
      expect(links.size("wifi")).toBe(1);
    });

    it("kindOf() names a held link's radio and nothing for any other", () => {
      links.open("ble", "c:1");
      links.open("lan", "lan-in-1");

      expect(links.kindOf("c:1")).toBe("ble");
      expect(links.kindOf("lan-in-1")).toBe("lan");
      links.close("c:1");
      expect(links.kindOf("c:1")).toBeUndefined();
    });

    it("open() is idempotent and keeps an existing binding", () => {
      links.open("ble", "c:1");
      links.bind("c:1", "peer-a");
      links.open("ble", "c:1");

      expect(links.size()).toBe(1);
      expect(links.peerOf("c:1")).toBe("peer-a");
    });

    it("close() returns the bound peer and forgets it", () => {
      links.open("ble", "c:1");
      links.bind("c:1", "peer-a");

      expect(links.close("c:1")).toBe("peer-a");
      expect(links.hasPeer("peer-a")).toBe(false);
      expect(links.peerOf("c:1")).toBeUndefined();
      expect(links.size()).toBe(0);
    });

    it("close() returns undefined for a link nobody announced on", () => {
      links.open("ble", "c:1");
      expect(links.close("c:1")).toBeUndefined();
    });

    it("close() on one radio leaves the peer reachable on the other", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      links.close("c:1");

      expect(links.hasPeer("peer-a")).toBe(true);
      expect(links.linkFor("peer-a")).toEqual({ id: "wifi-1", kind: "wifi" });
    });

    it("closeAll() drops one radio and leaves the other untouched", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("wifi-1", "peer-a");

      links.closeAll("wifi");

      expect(links.size()).toBe(1);
      expect(links.size("ble")).toBe(1);
      expect(links.hasPeer("peer-a")).toBe(false);
    });

    it("bind() on a link we do not hold is ignored", () => {
      links.bind("c:missing", "peer-a");
      expect(links.hasPeer("peer-a")).toBe(false);
    });
  });

  describe("bindings", () => {
    it("unbind() forgets a peer on every radio but keeps the links open", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      links.unbind("peer-a");

      expect(links.hasPeer("peer-a")).toBe(false);
      expect(links.size()).toBe(2);
    });

    it("unbind() with a kind clears every link on that radio", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("p:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      links.unbind("peer-a", "ble");

      expect(links.hasPeer("peer-a")).toBe(true);
      expect(links.linkFor("peer-a", "ble")).toBeUndefined();
      expect(links.linkFor("peer-a", "wifi")).toEqual({
        id: "wifi-1",
        kind: "wifi",
      });
    });

    it("a peer bound on a second link of the same radio keeps both", () => {
      links.open("ble", "c:1");
      links.open("ble", "c:2");
      links.bind("c:1", "peer-a");
      links.bind("c:2", "peer-a");

      // Most recently bound first, so the newest is what a send picks.
      expect(links.linksFor("peer-a")).toEqual([
        { id: "c:2", kind: "ble" },
        { id: "c:1", kind: "ble" },
      ]);
    });

    // The ordinary dual-role case: two phones that meet each dial the other, so
    // one peer is held as both `c:<id>` and `p:<id>`. Closing either must leave
    // the peer reachable on the survivor.
    it("closing one of a peer's two links on the same radio keeps the other", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:1");
      links.bind("c:1", "peer-a");
      links.bind("p:1", "peer-a");

      links.close("c:1");

      expect(links.hasPeer("peer-a")).toBe(true);
      expect(links.linkFor("peer-a")).toEqual({ id: "p:1", kind: "ble" });
      expect(links.size("ble")).toBe(1);
    });

    it("rebinding a link to a different peer moves it rather than sharing it", () => {
      links.open("ble", "c:1");
      links.bind("c:1", "peer-a");
      links.bind("c:1", "peer-b");

      expect(links.hasPeer("peer-a")).toBe(false);
      expect(links.peerOf("c:1")).toBe("peer-b");
      expect(links.linkFor("peer-b")).toEqual({ id: "c:1", kind: "ble" });
    });
  });

  // A link closing and a peer leaving are different events. Only the second
  // owes the caller anything, so `close` reports the peer only when it was its
  // last link.
  describe("departure", () => {
    it("reports nothing while the peer still holds another link on the same radio", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:1");
      links.bind("c:1", "peer-a");
      links.bind("p:1", "peer-a");

      expect(links.close("c:1")).toBeUndefined();
      expect(links.close("p:1")).toBe("peer-a");
    });

    it("reports nothing while the peer is still held on another radio", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      expect(links.close("c:1")).toBeUndefined();
      expect(links.hasPeer("peer-a")).toBe(true);
    });
  });

  describe("selection", () => {
    it("prefers WiFi when a peer is held on both radios", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      expect(links.linkFor("peer-a")).toEqual({ id: "wifi-1", kind: "wifi" });
      expect(links.linksFor("peer-a")).toEqual([
        { id: "wifi-1", kind: "wifi" },
        { id: "c:1", kind: "ble" },
      ]);
    });

    it("linkFor() with a kind pins the radio", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      expect(links.linkFor("peer-a", "ble")).toEqual({
        id: "c:1",
        kind: "ble",
      });
    });

    it("fastestLinks() keeps one link per peer, its fastest", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:1");
      links.open("lan", "lan-in-1");
      links.open("ble", "c:2");
      links.bind("c:1", "peer-a");
      links.bind("p:1", "peer-a");
      links.bind("lan-in-1", "peer-a");
      links.bind("c:2", "peer-b");

      expect(links.fastestLinks()).toEqual([
        { id: "lan-in-1", kind: "lan" },
        { id: "c:2", kind: "ble" },
      ]);
    });

    it("fastestLinks() keeps every link no peer has announced on", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:9");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-a");

      expect(links.fastestLinks()).toEqual([
        { id: "wifi-1", kind: "wifi" },
        { id: "p:9", kind: "ble" },
      ]);
    });

    it("reports nothing for an unknown peer", () => {
      expect(links.linkFor("peer-a")).toBeUndefined();
      expect(links.linksFor("peer-a")).toEqual([]);
      expect(links.hasPeer("peer-a")).toBe(false);
    });
  });

  describe("enumeration order", () => {
    it("lists links by radio in TRANSPORT_KINDS order, then by when they came up", () => {
      links.open("wifi", "wifi-1");
      links.open("ble", "c:1");
      links.open("wifi", "wifi-2");
      links.open("ble", "c:2");

      expect(TRANSPORT_KINDS).toEqual(["ble", "wifi", "lan"]);
      expect(links.linkIDs()).toEqual(["c:1", "c:2", "wifi-1", "wifi-2"]);
    });

    it("lists direct peers in link order, deduplicating one peer on two radios", () => {
      links.open("ble", "c:1");
      links.open("ble", "c:2");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("c:2", "peer-b");
      links.bind("wifi-1", "peer-a");

      expect(links.directPeers()).toEqual(["peer-a", "peer-b"]);
    });

    it("directPeers() with a kind lists only peers reachable on it", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-b");

      expect(links.directPeers("ble")).toEqual(["peer-a"]);
      expect(links.directPeers("wifi")).toEqual(["peer-b"]);
      expect(links.directPeers()).toEqual(["peer-a", "peer-b"]);
    });

    it("omits links nobody has announced on from direct peers", () => {
      links.open("ble", "c:1");
      links.open("ble", "c:2");
      links.bind("c:2", "peer-b");

      expect(links.directPeers()).toEqual(["peer-b"]);
    });
  });

  // Matches bitchat's `peerRegistry.connectedCount`: how crowded the Bluetooth
  // room is, which is what relay jitter and the time-critical TTL cap scale by.
  describe("degree", () => {
    it("counts a dual-role peer once, not once per link", () => {
      links.open("ble", "c:1");
      links.open("ble", "p:1");
      links.bind("c:1", "peer-a");
      links.bind("p:1", "peer-a");

      expect(links.size("ble")).toBe(2);
      expect(links.degree()).toBe(1);
    });

    it("ignores transports that do not share the Bluetooth radio", () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      links.bind("c:1", "peer-a");
      links.bind("wifi-1", "peer-b");

      expect(links.size()).toBe(2);
      expect(links.degree()).toBe(1);
    });

    it("ignores a link nobody has announced on yet", () => {
      links.open("ble", "c:1");

      expect(links.size("ble")).toBe(1);
      expect(links.degree()).toBe(0);
    });

    it("is zero with no links at all", () => {
      expect(links.degree()).toBe(0);
    });
  });

  describe("writes", () => {
    it("send() routes to the radio that owns the link", async () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");

      await links.send("c:1", "AAAA");
      await links.send("wifi-1", "BBBB");

      expect(rec.writes).toEqual([
        { linkID: "c:1", data: "AAAA" },
        { linkID: "wifi-1", data: "BBBB" },
      ]);
    });

    it("send() to a link we do not hold resolves without writing", async () => {
      await expect(links.send("c:gone", "AAAA")).resolves.toBeUndefined();
      expect(rec.writes).toHaveLength(0);
    });

    it("send() propagates a refusal so callers keep their own handling", async () => {
      links.open("ble", "c:1");
      rec.fail("c:1");

      await expect(links.send("c:1", "AAAA")).rejects.toThrow("refused");
    });

    it("counts bytes for every write that reached a radio", async () => {
      links.open("ble", "c:1");

      await links.send("c:1", "AAAA");
      await links.send("c:gone", "AAAA");

      expect(links.bytesSent).toBe(3);
    });

    it("broadcast() writes to every open link and reports success", async () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");

      await expect(links.broadcast("AAAA")).resolves.toBe(true);
      expect(rec.writes.map((w) => w.linkID)).toEqual(["c:1", "wifi-1"]);
    });

    it("broadcast() reports true while any one link took the bytes", async () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");
      rec.fail("c:1");

      await expect(links.broadcast("AAAA")).resolves.toBe(true);
      expect(rec.writes.map((w) => w.linkID)).toEqual(["wifi-1"]);
    });

    it("broadcast() reports false when every link refused", async () => {
      links.open("ble", "c:1");
      rec.fail("c:1");

      await expect(links.broadcast("AAAA")).resolves.toBe(false);
    });

    it("broadcast() reports false when there are no links at all", async () => {
      await expect(links.broadcast("AAAA")).resolves.toBe(false);
    });

    it("broadcastFastest() writes each peer's fastest link and counts refusals", async () => {
      links.open("ble", "c:1");
      links.open("lan", "lan-out-1");
      links.open("ble", "c:2");
      links.bind("c:1", "peer-a");
      links.bind("lan-out-1", "peer-a");
      links.bind("c:2", "peer-b");
      rec.fail("c:2");

      await expect(links.broadcastFastest("AAAA")).resolves.toEqual({
        sent: 1,
        refused: 1,
      });
      expect(rec.writes.map((w) => w.linkID)).toEqual(["lan-out-1"]);
    });

    it("a refused write never closes the link", async () => {
      links.open("ble", "c:1");
      rec.fail("c:1");

      await links.broadcast("AAAA");

      expect(links.size()).toBe(1);
    });

    it("broadcast() with a kind stays on that radio", async () => {
      links.open("ble", "c:1");
      links.open("wifi", "wifi-1");

      await links.broadcast("AAAA", { kind: "ble" });

      expect(rec.writes.map((w) => w.linkID)).toEqual(["c:1"]);
    });

    it("relay() writes to every link except the one the bytes arrived on", async () => {
      links.open("ble", "c:1");
      links.open("ble", "c:2");
      links.open("wifi", "wifi-1");

      links.relay("AAAA", "c:1");
      await Promise.resolve();

      expect(rec.writes.map((w) => w.linkID)).toEqual(["c:2", "wifi-1"]);
    });

    it("relay() over a single link writes nothing, so a two-node mesh cannot spin", async () => {
      links.open("ble", "c:1");

      links.relay("AAAA", "c:1");
      await Promise.resolve();

      expect(rec.writes).toHaveLength(0);
    });
  });

  // Two phones that meet each dial the other, so a Bluetooth neighbour is
  // usually two links. Writing both doubles the airtime of everything flooded,
  // and relaying down the second one echoes a packet back to its sender.
  describe("dual-role fanout", () => {
    beforeEach(() => {
      links.open("ble", "c:a");
      links.open("ble", "p:a");
      links.open("ble", "c:b");
      links.open("ble", "p:b");
      links.bind("c:a", "peer-a");
      links.bind("p:a", "peer-a");
      links.bind("c:b", "peer-b");
      links.bind("p:b", "peer-b");
    });

    it("broadcast() writes once per peer, on its most recently bound link", async () => {
      links.open("ble", "c:new");

      await links.broadcast("AAAA");

      // And still every link nobody has announced on.
      expect(rec.writes.map((w) => w.linkID)).toEqual(["p:a", "p:b", "c:new"]);
    });

    it("relay() sends nothing back to the peer it came from, on either link", async () => {
      links.relay("AAAA", "c:a");
      await Promise.resolve();

      expect(rec.writes.map((w) => w.linkID)).toEqual(["p:b"]);
    });

    it("a refused write falls back to the peer's other link", async () => {
      rec.fail("p:a");

      await expect(links.broadcast("AAAA", { kind: "ble" })).resolves.toBe(
        true,
      );

      expect(rec.writes.map((w) => w.linkID)).toEqual(["p:b", "c:a"]);
    });

    it("everyLink writes every link, so a second link still hears an announce", async () => {
      await links.broadcast("AAAA", { everyLink: true });

      expect(rec.writes.map((w) => w.linkID)).toEqual([
        "c:a",
        "p:a",
        "c:b",
        "p:b",
      ]);
    });

    it("keeps one copy per transport for a peer held on two", async () => {
      links.open("lan", "lan-out-1");
      links.bind("lan-out-1", "peer-a");

      await links.broadcast("AAAA");

      expect(rec.writes.map((w) => w.linkID)).toEqual([
        "p:a",
        "p:b",
        "lan-out-1",
      ]);
    });

    it("excludes the ingress peer on every transport", async () => {
      links.open("lan", "lan-out-1");
      links.bind("lan-out-1", "peer-a");

      await links.broadcast("AAAA", { kind: "lan", exclude: "c:a" });

      expect(rec.writes).toHaveLength(0);
    });

    it("fanoutLinks() names the first link of every write", () => {
      expect(links.fanoutLinks({ kind: "ble", exclude: "p:b" })).toEqual([
        "p:a",
      ]);
      links.unbind("peer-a");
      expect(links.fanoutLinks({ kind: "ble", exclude: "p:b" })).toEqual([
        "c:a",
        "p:a",
      ]);
    });
  });
});
