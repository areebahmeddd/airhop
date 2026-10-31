// The LAN transport differs from the other two in a way worth pinning down: it
// does not run because the mesh is running, it runs because somebody asked for
// it. Publishing an mDNS record tells everyone on the network, and whoever runs
// the network, that this phone is carrying Airhop, so consent is a precondition
// rather than a preference.
//
// The properties that matter:
//   * Nothing is published until the user turns it on AND the mesh is up.
//   * Turning it off stops publishing, not just dialling.
//   * Who gets dialled is the ring's answer, capped, and never dialled twice.
//   * A device that cannot run it is asked once, not polled forever.

const mockStartLAN = jest.fn<Promise<void>, [string]>();
const mockStopLAN = jest.fn<Promise<void>, []>();
const mockConnectToPeer = jest.fn<Promise<void>, [string]>();

jest.mock("@bridge/NativeAirhopLAN", () => ({
  __esModule: true,
  default: {
    startLAN: (name: string) => mockStartLAN(name),
    stopLAN: () => mockStopLAN(),
    connectToPeer: (name: string) => mockConnectToPeer(name),
    writeToLANLink: () => Promise.resolve(),
    addListener: () => undefined,
    removeListeners: () => undefined,
  },
}));

import { LANController } from "../lan-controller";

const SELF = "5000000000000000";

function rejectWith(code: string): Promise<never> {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return Promise.reject(error);
}

// Let every pending microtask and every expired timer run, repeatedly, so a
// retry that schedules another retry is followed to its conclusion. The clock
// moves `ms` on each of the eight rounds, so settle(ms) is 8 * ms of fake time.
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 8; i++) {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }
}

// 4.8 s in all, past the 500 ms discovery settle window and short of the 15 s
// dial review.
const SETTLED = 600;

function running(): LANController {
  const lan = new LANController(() => SELF);
  lan.start();
  lan.setEnabled(true);
  return lan;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStartLAN.mockReset();
  mockStartLAN.mockResolvedValue(undefined);
  mockStopLAN.mockReset();
  mockStopLAN.mockResolvedValue(undefined);
  mockConnectToPeer.mockReset();
  mockConnectToPeer.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("consent", () => {
  test("publishes nothing until the user turns it on", async () => {
    const lan = new LANController(() => SELF);

    lan.start();
    await settle();

    expect(mockStartLAN).not.toHaveBeenCalled();
    expect(lan.isStarted).toBe(false);
  });

  test("publishes nothing while it is on but the mesh is not running", async () => {
    const lan = new LANController(() => SELF);

    lan.setEnabled(true);
    await settle();

    expect(mockStartLAN).not.toHaveBeenCalled();
  });

  test("publishes once both are true, under the name it was given", async () => {
    const lan = running();
    await settle();

    expect(mockStartLAN).toHaveBeenCalledWith(SELF);
    expect(lan.isStarted).toBe(true);
  });

  test("turning it off stops publishing, not just dialling", async () => {
    const lan = running();
    await settle();

    lan.setEnabled(false);
    await settle();

    expect(mockStopLAN).toHaveBeenCalled();
    expect(lan.isStarted).toBe(false);
  });

  test("going Away stops it even while the switch is still on", async () => {
    const lan = running();
    await settle();

    lan.stop();
    await settle();

    expect(mockStopLAN).toHaveBeenCalled();
    expect(lan.isStarted).toBe(false);
  });
});

// The privacy policy claims records from two networks cannot be matched to the
// same phone. That is only true while the published name changes, so it is
// pinned here rather than left to the comment.
describe("the published name", () => {
  test("is minted fresh for every publishing session", async () => {
    let n = 0;
    const lan = new LANController(() => `name-${String(++n)}`);

    lan.start();
    lan.setEnabled(true);
    await settle();
    expect(mockStartLAN).toHaveBeenLastCalledWith("name-1");

    // Walking out of the office and into a cafe: the transport comes down and
    // goes back up.
    lan.setEnabled(false);
    await settle();
    lan.setEnabled(true);
    await settle();

    expect(mockStartLAN).toHaveBeenLastCalledWith("name-2");
  });

  test("forgets peers found under the previous name", async () => {
    let n = 0;
    const lan = new LANController(() => `name-${String(++n)}`);
    lan.start();
    lan.setEnabled(true);
    await settle();

    lan.onPeerDiscovered("9000000000000000");
    expect(lan.discoveredCount).toBe(1);

    lan.setEnabled(false);
    await settle();
    lan.setEnabled(true);
    await settle();

    // A peer seen on the old network is not a peer on this one.
    expect(lan.discoveredCount).toBe(0);
  });
});

describe("dialling", () => {
  function discover(lan: LANController, names: readonly string[]): void {
    for (const serviceName of names) lan.onPeerDiscovered(serviceName);
  }

  test("dials nobody before the discovery burst settles", async () => {
    const lan = running();
    await settle();

    discover(lan, ["6000000000000000"]);
    await settle();

    expect(mockConnectToPeer).not.toHaveBeenCalled();
  });

  test("dials the peers the ring says are ours to open", async () => {
    const lan = running();
    await settle();

    // One below us and one above. Only the one above is ours to dial.
    discover(lan, ["1000000000000000", "9000000000000000"]);
    await settle(SETTLED);

    expect(mockConnectToPeer).toHaveBeenCalledTimes(1);
    expect(mockConnectToPeer).toHaveBeenCalledWith("9000000000000000");
  });

  test("a repeated discovery of a known peer dials nothing new", async () => {
    const lan = running();
    await settle();

    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);
    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);

    expect(mockConnectToPeer).toHaveBeenCalledTimes(1);
  });

  test("dials a peer again after a refused connect", async () => {
    mockConnectToPeer.mockRejectedValue(new Error("CONNECT_FAILED"));
    const lan = running();
    await settle();

    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);
    expect(mockConnectToPeer).toHaveBeenCalledTimes(1);

    // The peer never leaves mDNS; only the review comes round again (16 s).
    await settle(2_000);

    expect(mockConnectToPeer).toHaveBeenCalledTimes(2);
  });

  // A TCP link can drop while the peer's mDNS record stays perfectly visible.
  // Nothing about that is a discovery change, so without the periodic pass the
  // peer would be lost until it restarted.
  test("walks the plan again on a timer, so a dropped link is reopened", async () => {
    const lan = running();
    await settle();

    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);
    expect(mockConnectToPeer).toHaveBeenCalledTimes(1);

    // No discovery change at all: just time passing, 16 s of it.
    await settle(2_000);

    expect(mockConnectToPeer.mock.calls.length).toBeGreaterThan(1);
  });

  test("stops reviewing once the transport is off", async () => {
    const lan = running();
    await settle();
    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);
    const dialled = mockConnectToPeer.mock.calls.length;

    lan.setEnabled(false);
    await settle(60_000);

    expect(mockConnectToPeer.mock.calls.length).toBe(dialled);
  });

  test("ignores our own record coming back off the network", async () => {
    const lan = running();
    await settle();

    discover(lan, [SELF]);
    await settle(SETTLED);

    expect(mockConnectToPeer).not.toHaveBeenCalled();
    expect(lan.discoveredCount).toBe(0);
  });

  test("does not dial while the transport is not running", async () => {
    const lan = new LANController(() => SELF);
    lan.start();

    discover(lan, ["9000000000000000"]);
    await settle(SETTLED);

    expect(mockConnectToPeer).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  test("asks once on a device that will never support it", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("LAN_UNSUPPORTED"));
    const lan = running();

    await settle(60_000);

    expect(mockStartLAN).toHaveBeenCalledTimes(1);
    expect(lan.isUnsupported).toBe(true);
  });

  test("still says unsupported after a pause, so the switch stays explained", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("LAN_UNSUPPORTED"));
    const seen: string[] = [];
    const lan = new LANController(
      () => SELF,
      (s) => seen.push(s),
    );
    lan.start();
    lan.setEnabled(true);
    await settle();

    // Away and back, as the Network screen sees it.
    lan.stop();
    await settle();
    lan.start();
    await settle(60_000);

    expect(seen[seen.length - 1]).toBe("unsupported");
    expect(mockStartLAN).toHaveBeenCalledTimes(1);
  });

  test("keeps trying while the network is merely missing", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("LAN_UNAVAILABLE"));
    const lan = running();

    await settle(10_000);

    expect(mockStartLAN.mock.calls.length).toBeGreaterThan(1);
    expect(lan.isUnsupported).toBe(false);
  });

  test("asks again after a refused permission, since a grant can land just after", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("PERMISSION_DENIED"));
    const lan = running();

    await settle(10_000);

    expect(mockStartLAN.mock.calls.length).toBeGreaterThan(1);
    expect(lan.failure).toBe("permission");
  });

  test("stops asking after a refused permission, rather than polling for good", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("PERMISSION_DENIED"));
    running();

    await settle(10_000);
    const asked = mockStartLAN.mock.calls.length;
    await settle(60_000);

    expect(asked).toBeLessThanOrEqual(3);
    expect(mockStartLAN).toHaveBeenCalledTimes(asked);
  });

  test("a resume asks again after the ladder has stopped, and a grant starts it", async () => {
    mockStartLAN.mockImplementation(() => rejectWith("PERMISSION_DENIED"));
    const lan = running();
    await settle(60_000);
    const asked = mockStartLAN.mock.calls.length;

    // Back from Settings with access granted.
    mockStartLAN.mockResolvedValue(undefined);
    lan.refresh();
    await settle();

    expect(mockStartLAN.mock.calls.length).toBe(asked + 1);
    expect(lan.isStarted).toBe(true);
  });

  // iOS reports a Local Network refusal from the browser, after the listener
  // has already reached ready: the start resolves, the transport says it is
  // available, then dies, and the next start is the one refused. The
  // available edge in the middle must not reset the ladder, or this repeats
  // every couple of seconds for as long as the app runs.
  test("an iOS refusal that resolves first, then dies, does not loop", async () => {
    const seen: string[] = [];
    const lan = new LANController(
      () => SELF,
      (s) => seen.push(s),
    );
    let refusalPending = false;
    mockStartLAN.mockImplementation(() => {
      if (refusalPending) {
        refusalPending = false;
        return rejectWith("PERMISSION_DENIED");
      }
      setTimeout(() => {
        lan.onAvailabilityChanged(true);
        refusalPending = true;
        lan.onAvailabilityChanged(false);
      }, 100);
      return Promise.resolve();
    });
    lan.start();
    lan.setEnabled(true);

    for (let i = 0; i < 10; i++) await settle(10_000);
    const asked = mockStartLAN.mock.calls.length;
    for (let i = 0; i < 10; i++) await settle(10_000);

    expect(asked).toBeLessThanOrEqual(4);
    expect(mockStartLAN).toHaveBeenCalledTimes(asked);
    expect(lan.isStarted).toBe(false);
    expect(seen[seen.length - 1]).toBe("permission");
  });

  test("recovers when the network goes away and comes back", async () => {
    const lan = running();
    await settle();
    expect(lan.isStarted).toBe(true);

    lan.onAvailabilityChanged(false);
    await settle();
    expect(lan.isStarted).toBe(false);

    lan.onAvailabilityChanged(true);
    await settle();
    expect(lan.isStarted).toBe(true);
  });

  test("forgets the network it was on when that network goes away", async () => {
    const lan = running();
    await settle();
    lan.onPeerDiscovered("9000000000000000");
    expect(lan.discoveredCount).toBe(1);

    lan.onAvailabilityChanged(false);

    expect(lan.discoveredCount).toBe(0);
  });
});

describe("reported state", () => {
  test("says searching while running with nobody found", async () => {
    const seen: string[] = [];
    const lan = new LANController(
      () => SELF,
      (s) => seen.push(s),
    );

    lan.start();
    lan.setEnabled(true);
    await settle();

    expect(seen).toContain("searching");
  });

  test("says active once a link is up, and searching again when it drops", async () => {
    const seen: string[] = [];
    const lan = new LANController(
      () => SELF,
      (s) => seen.push(s),
    );
    lan.start();
    lan.setEnabled(true);
    await settle();

    lan.setLinkCount(1);
    expect(seen).toContain("active");

    lan.setLinkCount(0);
    expect(seen[seen.length - 1]).toBe("searching");
  });
});
