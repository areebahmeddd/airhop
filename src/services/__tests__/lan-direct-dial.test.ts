// Direct dial on the local network: a session peer's LAN address, dialed only
// by the lower peer ID, only at a private address on this phone's own subnet,
// rate limited, inside the link cap, and kept only if the peer proves itself
// on the link before anything is written to it.

import { MAX_LAN_LINKS } from "../lan-dial-policy";
import { LanDirectDial, type LanDirectDialDeps } from "../lan-direct-dial";

const SELF = "1000000000000000";
const PEER = "2000000000000000";
const OTHER = "3000000000000000";
const HOME = [{ address: "192.168.1.10", prefixLength: 24 }];
const ENDPOINT = { port: 40_123, hosts: ["192.168.1.23"] };

interface Harness {
  dial: LanDirectDial;
  connects: { host: string; port: number; linkID: string }[];
  closed: string[];
  linked: Set<string>;
  links: { count: number };
}

function harness(overrides: Partial<LanDirectDialDeps> = {}): Harness {
  const connects: Harness["connects"] = [];
  const closed: string[] = [];
  const linked = new Set<string>();
  const links = { count: 0 };
  const dial = new LanDirectDial({
    selfPeerID: () => SELF,
    isLinked: (peerID) => linked.has(peerID),
    linkCount: () => links.count,
    localSubnets: () => Promise.resolve(HOME),
    connect: (host, port, linkID) => {
      connects.push({ host, port, linkID });
      return Promise.resolve();
    },
    close: (linkID) => closed.push(linkID),
    // mDNS's turn is tested on its own below.
    mdnsFirstMs: 0,
    ...overrides,
  });
  return { dial, connects, closed, linked, links };
}

async function settle(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("who dials", () => {
  test("the lower peer ID dials the address it was handed", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    expect(h.connects).toEqual([
      { host: "192.168.1.23", port: 40_123, linkID: "lan-direct-1" },
    ]);
    h.dial.dispose();
  });

  test("the higher one waits to be dialed", async () => {
    const h = harness({ selfPeerID: () => OTHER });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(60_000);
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });

  // A listener restart on the same network leaves the address good.
  test("an address heard while not listening is dialed once listening starts", async () => {
    const h = harness();
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    expect(h.connects).toEqual([]);
    h.dial.setListening(true);
    await settle();
    expect(h.connects).toHaveLength(1);
    h.dial.dispose();
  });

  test("an address that keeps coming to nothing is dropped until sent again", async () => {
    let attempts = 0;
    const h = harness({
      connect: () => {
        attempts += 1;
        return Promise.reject(new Error("refused"));
      },
    });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(10 * 60_000);
    expect(attempts).toBe(3);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    expect(attempts).toBe(4);
    h.dial.dispose();
  });

  test("a clock moved back does not hold off the next dial", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    expect(h.connects).toHaveLength(1);
    // The link never proves itself, so it closes and the peer is due again.
    await settle(15_000);
    jest.setSystemTime(Date.now() - 2 * 60 * 60_000);
    await settle(60_000);
    expect(h.connects.length).toBeGreaterThan(1);
    h.dial.dispose();
  });

  // The budget across peers too: dials stamped before the clock went back
  // must not hold every new peer off until it catches up.
  test("a clock moved back does not use up the connect budget", async () => {
    const h = harness();
    h.dial.setListening(true);
    for (let i = 0; i < MAX_LAN_LINKS; i++) {
      h.dial.offer(`20000000000000${String(10 + i)}`, {
        port: 40_123,
        hosts: [`192.168.1.${String(30 + i)}`],
      });
    }
    await settle();
    expect(h.connects).toHaveLength(MAX_LAN_LINKS);
    // The links never prove themselves, so they close and free their slots.
    await settle(15_000);
    jest.setSystemTime(Date.now() - 2 * 60 * 60_000);
    h.dial.offer("2000000000000099", {
      port: 40_123,
      hosts: ["192.168.1.99"],
    });
    await settle();
    expect(h.connects.map((c) => c.host)).toContain("192.168.1.99");
    h.dial.dispose();
  });

  // Peers on another subnet, or gone without a goodbye, must not use up the
  // dials a reachable one needs.
  test("addresses that never answer cannot starve one that would", async () => {
    let reachable = 0;
    const h = harness({
      localSubnets: () => Promise.resolve(HOME),
      connect: (host) => {
        if (host === "192.168.1.99") reachable += 1;
        return host === "192.168.1.99"
          ? Promise.resolve()
          : Promise.reject(new Error("timeout"));
      },
    });
    h.dial.setListening(true);
    for (let i = 0; i < MAX_LAN_LINKS; i++) {
      h.dial.offer(`20000000000000${String(i).padStart(2, "0")}`, {
        port: 1,
        hosts: [i % 2 === 0 ? "10.9.9.9" : `192.168.1.${String(50 + i)}`],
      });
    }
    await settle(5_000);
    h.dial.offer("3000000000000001", { port: 2, hosts: ["192.168.1.99"] });
    await settle(2 * 60_000);
    expect(reachable).toBeGreaterThan(0);
    h.dial.dispose();
  });

  test("a stop and start while a dial looks up its host abandons it", async () => {
    let release: (subnets: typeof HOME) => void = () => {};
    let first = true;
    const h = harness({
      localSubnets: () =>
        first
          ? new Promise((resolve) => {
              first = false;
              release = resolve;
            })
          : Promise.resolve(HOME),
    });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    h.dial.setListening(false);
    h.dial.setListening(true);
    release(HOME);
    await settle();
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });

  test("a dial proven after mDNS linked the pair meanwhile is closed", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    const linkID = h.connects[0].linkID;
    h.linked.add(PEER);
    expect(h.dial.judge(linkID, PEER)).toBe("refused");
    expect(h.closed).toContain(linkID);
    h.dial.dispose();
  });

  test("an offer says whether the endpoint is new", () => {
    const h = harness();
    expect(h.dial.offer(PEER, ENDPOINT)).toBe(true);
    expect(h.dial.offer(PEER, { ...ENDPOINT })).toBe(false);
    expect(h.dial.offer(PEER, { port: 1, hosts: ENDPOINT.hosts })).toBe(true);
    h.dial.dispose();
  });

  test("a peer already on a LAN link is not dialed again", async () => {
    const h = harness();
    h.linked.add(PEER);
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(60_000);
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });

  // Endpoints are traded as the listener comes up, before mDNS has found
  // anyone: on a network it works on, its link must land first, not beside
  // this one.
  test("mDNS gets its turn before a new address is dialed", async () => {
    const h = harness({ mdnsFirstMs: undefined });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(15_000);
    expect(h.connects).toEqual([]);
    h.linked.add(PEER);
    await settle(30_000);
    expect(h.connects).toEqual([]);
    h.linked.delete(PEER);
    await settle(15_000);
    expect(h.connects).toHaveLength(1);
    h.dial.dispose();
  });

  // mDNS slower than its head start: its link lands beside the dialed one,
  // and the dialer, the only side that acts, closes its own.
  test("an mDNS link to a peer already dialed replaces the dialed one", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    const { linkID } = h.connects[0];
    expect(h.dial.judge(linkID, PEER)).toBe("proven");
    h.dial.onLanLinkBound(PEER, linkID);
    expect(h.closed).toEqual([]);
    h.dial.onLanLinkBound(PEER, "lan-out-4");
    expect(h.closed).toEqual([linkID]);
    h.dial.onLanLinkBound(PEER, "lan-out-4");
    expect(h.closed).toEqual([linkID]);
    h.dial.dispose();
  });

  test("the link cap is shared with mDNS links", async () => {
    const h = harness();
    h.links.count = MAX_LAN_LINKS;
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(60_000);
    expect(h.connects).toEqual([]);
    h.links.count = MAX_LAN_LINKS - 1;
    await settle(15_000);
    expect(h.connects).toHaveLength(1);
    h.dial.dispose();
  });
});

describe("which address", () => {
  test("a public, off-subnet or own address is never dialed", async () => {
    const h = harness();
    h.dial.setListening(true);
    for (const host of ["8.8.8.8", "10.0.0.5", "192.168.2.9", "192.168.1.10"]) {
      h.dial.offer(PEER, { port: 1, hosts: [host] });
      await settle();
    }
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });

  test("a peer's own endpoint is never taken for another's", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(SELF, ENDPOINT);
    await settle(60_000);
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });
});

describe("rate", () => {
  test("one dial per peer every 30 s, however often the review runs", async () => {
    const attempts: number[] = [];
    const dial = new LanDirectDial({
      selfPeerID: () => SELF,
      isLinked: () => false,
      linkCount: () => 0,
      localSubnets: () => Promise.resolve(HOME),
      connect: () => {
        attempts.push(Date.now());
        return Promise.reject(new Error("refused"));
      },
      close: () => undefined,
      mdnsFirstMs: 0,
    });
    dial.setListening(true);
    dial.offer(PEER, ENDPOINT);
    await settle(89_000);
    expect(attempts).toHaveLength(3);
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i] - attempts[i - 1]).toBeGreaterThanOrEqual(30_000);
    }
    dial.dispose();
  });

  test("a new address waits out the rate, so a peer cannot drive a sweep", async () => {
    const h = harness({
      connect: (host) => {
        h.connects.push({ host, port: 0, linkID: "" });
        return Promise.reject(new Error("refused"));
      },
    });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(1_000);
    for (let i = 30; i < 40; i++) {
      h.dial.offer(PEER, { port: 40_124, hosts: [`192.168.1.${i}`] });
    }
    await settle(1_000);
    expect(h.connects.map((c) => c.host)).toEqual(["192.168.1.23"]);
    await settle(29_000);
    expect(h.connects.map((c) => c.host)).toEqual([
      "192.168.1.23",
      "192.168.1.39",
    ]);
    h.dial.dispose();
  });
});

describe("proving the link", () => {
  test("a dialed link is held apart until its peer announces", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    const { linkID } = h.connects[0];
    expect(h.dial.onConnected(linkID)).toBe("hold");
    expect(h.dial.onConnected("lan-in-7")).toBe("open");
    expect(h.dial.judge(linkID, PEER)).toBe("proven");
    expect(h.closed).toEqual([]);
    // Proven once: later announces on it are ordinary.
    expect(h.dial.judge(linkID, PEER)).toBe("other");
    h.dial.dispose();
  });

  test("a dialed link whose announce names someone else is closed", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    const { linkID } = h.connects[0];
    expect(h.dial.judge(linkID, OTHER)).toBe("refused");
    expect(h.closed).toEqual([linkID]);
    h.dial.dispose();
  });

  test("a dialed link that never proves itself is closed", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    const { linkID } = h.connects[0];
    await settle(9_999);
    expect(h.closed).toEqual([]);
    await settle(1);
    expect(h.closed).toEqual([linkID]);
    h.dial.dispose();
  });

  test("an mDNS link is judged by nothing here", () => {
    const h = harness();
    expect(h.dial.judge("lan-out-3", OTHER)).toBe("other");
    expect(h.closed).toEqual([]);
  });
});

describe("lifecycle", () => {
  test("a forgotten peer is not dialed", async () => {
    const h = harness();
    h.dial.offer(PEER, ENDPOINT);
    h.dial.forget(PEER);
    h.dial.setListening(true);
    await settle(60_000);
    expect(h.connects).toEqual([]);
    h.dial.dispose();
  });

  test("turning the transport off drops pending proofs and stops the review", async () => {
    const h = harness();
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    h.dial.setListening(false);
    await settle(60_000);
    expect(h.closed).toEqual(["lan-direct-1"]);
    expect(h.connects).toHaveLength(1);
  });

  test("no more dials across peers than the link cap allows in 30 s", async () => {
    const h = harness();
    h.dial.setListening(true);
    for (let i = 0; i < 100; i++) {
      h.dial.offer(`2${i.toString(16).padStart(15, "0")}`, ENDPOINT);
    }
    await settle();
    expect(h.connects.length).toBeLessThanOrEqual(MAX_LAN_LINKS);
    h.dial.dispose();
  });

  test("a peer that leaves and comes back keeps its rate", async () => {
    let calls = 0;
    const h = harness({
      connect: () => {
        calls++;
        return Promise.reject(new Error("refused"));
      },
    });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle(1_000);
    h.dial.forget(PEER);
    h.dial.offer(PEER, { port: 2, hosts: ["192.168.1.40"] });
    await settle(1_000);
    expect(calls).toBe(1);
    h.dial.dispose();
  });

  test("a stop closes dials still open, and one that connects late is closed", async () => {
    let finish: () => void = () => undefined;
    const h = harness({
      connect: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    await settle();
    h.dial.setListening(false);
    expect(h.closed).toEqual(["lan-direct-1"]);
    expect(h.dial.onConnected("lan-direct-1")).toBe("close");
    finish();
    h.dial.dispose();
  });

  test("dials still open count against the cap, and proof checks it again", async () => {
    const h = harness({ connect: () => new Promise<void>(() => undefined) });
    h.links.count = MAX_LAN_LINKS - 1;
    h.dial.setListening(true);
    h.dial.offer(PEER, ENDPOINT);
    h.dial.offer(OTHER.replace("3", "4"), ENDPOINT);
    await settle();
    expect(h.dial.onConnected("lan-direct-1")).toBe("hold");
    expect(h.dial.onConnected("lan-direct-2")).toBe("close");
    h.links.count = MAX_LAN_LINKS;
    expect(h.dial.judge("lan-direct-1", PEER)).toBe("refused");
    expect(h.closed).toEqual(["lan-direct-1"]);
    h.dial.dispose();
  });
});
