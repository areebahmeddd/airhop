/**
 * @jest-environment node
 */
// A whole transfer, old phone to new, with nothing between them but a socket.
//
// Each phone is its own module registry (jest.isolateModules), so each has its
// own keychain, its own MMKV and its own stores, exactly as two devices would.
// The real sender and receiver run against each other over an in-memory link
// that behaves like the native one: ordered frames, a connected event on both
// ends, a closed event on both ends. Chaos is injected at the link, which is
// where a real transfer meets it. A third phone, "evil", can dial the same code
// to race the real old phone.

import type * as IdentityModule from "@core/crypto/identity";
import type * as KeychainModule from "@core/crypto/keychain";
import type * as InviteModule from "@core/move/move-invite";
import type { MoveInvite } from "@core/move/move-invite";
import type * as MmkvModule from "@store/mmkv";
import type { MoveLinkEvent } from "../move-link";
import type * as MarkerModule from "../move-marker";
import type * as ReceiverModule from "../move-receiver";
import type * as SenderModule from "../move-sender";

type Side = "old" | "new" | "evil";
type Dialer = Exclude<Side, "new">;

// ---- The link between the phones ----

// The new phone's listening address, and the subnet every dialer is on.
const NEW_PHONE_HOST = "192.168.1.20";
const LOCAL_SUBNET = { address: "192.168.1.30", prefixLength: 24 };

interface Connection {
  dialer: Dialer;
  id: { dialer: string; new: string };
  open: boolean;
}

class LinkBus {
  private readonly listeners: Record<Side, ((e: MoveLinkEvent) => void)[]> = {
    old: [],
    new: [],
    evil: [],
  };
  private listening = false;
  private readonly connections: Connection[] = [];
  private seq = 0;
  dials = 0;
  // Chaos: called with every frame the named side writes. "drop-link" cuts the
  // connection instead of delivering it; "hold" parks the frame, and every
  // frame after it, until release().
  intercept:
    ((from: Side, index: number) => "deliver" | "drop-link" | "hold") | null =
    null;
  private held: (() => void)[] = [];
  private holding = false;

  release(): void {
    this.holding = false;
    for (const deliver of this.held.splice(0)) deliver();
  }
  private written: Record<Side, number> = { old: 0, new: 0, evil: 0 };

  private emit(side: Side, event: MoveLinkEvent): void {
    for (const l of [...this.listeners[side]]) l(event);
  }

  private find(side: Side, id: string): Connection | undefined {
    return this.connections.find((c) =>
      side === "new"
        ? c.id.new === id
        : c.dialer === side && c.id.dialer === id,
    );
  }

  private close(c: Connection): void {
    if (!c.open) return;
    c.open = false;
    setImmediate(() => {
      this.emit(c.dialer, { kind: "closed", connectionID: c.id.dialer });
      this.emit("new", { kind: "closed", connectionID: c.id.new });
    });
  }

  linkFor(side: Side) {
    const { MoveDialError } =
      jest.requireActual<typeof import("../move-link")>("../move-link");
    return {
      isMoveLinkAvailable: () => true,
      subscribeMoveLink: (l: (e: MoveLinkEvent) => void) => {
        this.listeners[side].push(l);
        return () => {
          this.listeners[side] = this.listeners[side].filter((x) => x !== l);
        };
      },
      startMoveListener: async () => {
        this.listening = true;
        return { port: 45000, hosts: [NEW_PHONE_HOST] };
      },
      localSubnets: async () => [LOCAL_SUBNET],
      stopMoveLink: async () => {
        if (side === "new") this.listening = false;
        for (const c of this.connections) {
          if (side === "new" || c.dialer === side) this.close(c);
        }
      },
      dialMove: async (host: string, port: number) => {
        this.dials += 1;
        if (
          side === "new" ||
          !this.listening ||
          host !== NEW_PHONE_HOST ||
          port !== 45000
        ) {
          throw new MoveDialError("unreachable");
        }
        this.seq += 1;
        const c: Connection = {
          dialer: side,
          id: { dialer: `out-${this.seq}`, new: `in-${this.seq}` },
          open: true,
        };
        this.connections.push(c);
        setImmediate(() =>
          this.emit("new", { kind: "connected", connectionID: c.id.new }),
        );
        return c.id.dialer;
      },
      writeMove: async (connectionID: string, bytes: Uint8Array) => {
        const c = this.find(side, connectionID);
        if (c === undefined || !c.open) throw new Error("closed");
        const index = this.written[side]++;
        const verdict = this.intercept?.(side, index) ?? "deliver";
        if (verdict === "drop-link") {
          this.close(c);
          throw new Error("closed");
        }
        const to: Side = side === "new" ? c.dialer : "new";
        const copy = bytes.slice();
        // Like TCP: bytes written before a close still arrive, ahead of it.
        const deliver = () =>
          setImmediate(() =>
            this.emit(to, {
              kind: "data",
              connectionID: to === "new" ? c.id.new : c.id.dialer,
              bytes: copy,
            }),
          );
        if (verdict === "hold") this.holding = true;
        if (this.holding) {
          // Parked like a full socket buffer: the write itself waits too, and
          // the frame is only still in flight if the link is.
          await new Promise<void>((resolve) =>
            this.held.push(() => {
              if (c.open) deliver();
              resolve();
            }),
          );
          if (!c.open) throw new Error("closed");
        } else {
          deliver();
        }
      },
      closeMove: (connectionID: string) => {
        const c = this.find(side, connectionID);
        if (c !== undefined) this.close(c);
      },
      MoveDialError,
    };
  }
}

// ---- A phone ----

interface Phone {
  identity: typeof IdentityModule;
  keychain: typeof KeychainModule;
  mmkv: typeof MmkvModule;
  marker: typeof MarkerModule;
  invite: typeof InviteModule;
  sender: typeof SenderModule;
  receiver: typeof ReceiverModule;
  secureStore: { setItemAsync: jest.Mock };
  mesh: { destroyMeshService: jest.Mock };
}

const g = globalThis as unknown as {
  __moveBus: LinkBus;
  __moveSide: Side;
  __moveVersion: Record<Side, string>;
};

// Factories run once per phone, inside that phone's registry, so each captures
// the side being built. They reach the shared rig through globalThis, the one
// thing every registry has in common.
jest.mock("../move-link", () => {
  const rigState = globalThis as unknown as {
    __moveBus: { linkFor: (side: string) => unknown };
    __moveSide: string;
  };
  return rigState.__moveBus.linkFor(rigState.__moveSide);
});
jest.mock("../mesh-service", () => ({ destroyMeshService: jest.fn() }));
jest.mock("../file-transfer-service", () => ({
  wipeCacheDirectory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../notification-service", () => ({
  dismissAllNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../notification-pipeline", () => ({
  stopNotificationPipeline: jest.fn(),
}));
jest.mock("@i18n", () => ({
  ...jest.requireActual("@i18n"),
  applyLayoutDirection: jest.fn(),
}));
jest.mock("@data/app-info", () => {
  const rigState = globalThis as unknown as {
    __moveSide: string;
    __moveVersion: Record<string, string>;
  };
  return {
    ...jest.requireActual<object>("@data/app-info"),
    APP_VERSION: rigState.__moveVersion[rigState.__moveSide],
  };
});

// A real panic wipe and a real Noise handshake per case, twice over.
jest.setTimeout(60_000);

function phone(side: Side): Phone {
  let loaded: Phone | null = null;
  g.__moveSide = side;
  jest.isolateModules(() => {
    loaded = {
      identity: require("@core/crypto/identity"),
      keychain: require("@core/crypto/keychain"),
      mmkv: require("@store/mmkv"),
      marker: require("../move-marker"),
      invite: require("@core/move/move-invite"),
      sender: require("../move-sender"),
      receiver: require("../move-receiver"),
      secureStore: require("expo-secure-store"),
      mesh: require("../mesh-service"),
    };
  });
  if (loaded === null) throw new Error("phone did not load");
  return loaded;
}

let lastRig: Rig | null = null;

async function until(predicate: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ok = predicate();
  if (!ok && lastRig !== null) {
    console.log(
      JSON.stringify({
        sender: lastRig.senderStates.map((x) => x.phase),
        receiver: lastRig.receiverStates.map((x) => x.phase),
      }),
    );
  }
  return ok;
}

// Lets every frame in flight land, for asserting that nothing more happens.
async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface SendOptions {
  invite?: MoveInvite;
  history?: boolean;
  // Taps Transfer as soon as the words show.
  autoProceed?: boolean;
  from?: Dialer;
  states?: SenderModule.SenderState[];
}

interface Rig {
  oldPhone: Phone;
  newPhone: Phone;
  evilPhone: Phone;
  bus: LinkBus;
  peerID: string;
  senderStates: SenderModule.SenderState[];
  receiverStates: ReceiverModule.ReceiverState[];
  resumed: jest.Mock;
  receiver: ReceiverModule.MoveReceiver;
  invite: MoveInvite;
  send: (options?: SendOptions) => SenderModule.MoveSender;
}

async function rig(
  versions = { old: "1.0.8", new: "1.0.8", evil: "1.0.8" },
  // Taps They match as soon as the words show.
  autoConfirm = true,
): Promise<Rig> {
  const bus = new LinkBus();
  g.__moveBus = bus;
  g.__moveVersion = versions;
  const oldPhone = phone("old");
  const newPhone = phone("new");
  const evilPhone = phone("evil");

  g.__moveSide = "old";
  const id = await oldPhone.identity.generateIdentity();
  await oldPhone.identity.saveIdentity(id);
  await oldPhone.keychain.writeSecret(
    oldPhone.keychain.KEYCHAIN_ITEMS.walletRecoveryPhrase,
    "twelve words",
  );
  oldPhone.mmkv.getStorage("chat-store").set(
    "airhop-chat",
    JSON.stringify({
      state: {
        messages: { "#treehouse": [{ id: "m1", text: "hello" }] },
        channelKeys: { "#treehouse": "a2V5" },
      },
      version: 0,
    }),
  );
  oldPhone.mmkv
    .getStorage("contacts-store")
    .set(
      "contacts-store",
      JSON.stringify({ state: { contacts: { a: { nickname: "sam" } } } }),
    );
  await evilPhone.identity.saveIdentity(
    await evilPhone.identity.generateIdentity(),
  );

  const receiverStates: ReceiverModule.ReceiverState[] = [];
  const receiver: ReceiverModule.MoveReceiver =
    new newPhone.receiver.MoveReceiver((s) => {
      receiverStates.push(s);
      if (autoConfirm && s.phase === "confirm") {
        setImmediate(() => receiver.confirm());
      }
    });
  await receiver.start();
  const waiting = receiverStates.find((s) => s.phase === "waiting");
  if (waiting?.phase !== "waiting") throw new Error("no code shown");
  const invite = newPhone.invite.decodeMoveInvite(waiting.code);
  if (invite === null) throw new Error("code does not decode");

  const senderStates: SenderModule.SenderState[] = [];
  const resumed = jest.fn();
  const send = ({
    invite: target = invite,
    history = true,
    autoProceed = true,
    from = "old",
    states = senderStates,
  }: SendOptions = {}) => {
    const sending = from === "old" ? oldPhone : evilPhone;
    const sender: SenderModule.MoveSender = new sending.sender.MoveSender(
      target,
      history,
      {
        onChange: (s) => {
          states.push(s);
          if (autoProceed && s.phase === "verify") {
            setImmediate(() => sender.proceed());
          }
        },
        onResume: resumed,
      },
    );
    void sender.connect();
    return sender;
  };
  const built: Rig = {
    oldPhone,
    newPhone,
    evilPhone,
    bus,
    peerID: id.peerID,
    senderStates,
    receiverStates,
    resumed,
    receiver,
    invite,
    send,
  };
  lastRig = built;
  return built;
}

const lastPhase = <T extends { phase: string }>(states: T[]): string =>
  states[states.length - 1]?.phase ?? "none";

async function identityOf(p: Phone): Promise<string | null> {
  return (await p.identity.loadIdentity())?.peerID ?? null;
}

describe("device transfer, end to end", () => {
  it("moves the identity, erases the old phone, and leaves no markers", async () => {
    const r = await rig();
    r.send();
    const ok = await until(
      () =>
        lastPhase(r.senderStates) === "done" &&
        lastPhase(r.receiverStates) === "done",
    );
    expect(ok).toBe(true);

    // DEBUG
    const done = r.receiverStates[r.receiverStates.length - 1];
    expect(done).toEqual({ phase: "done", peerID: r.peerID, released: true });
    expect(await identityOf(r.newPhone)).toBe(r.peerID);
    expect(
      await r.newPhone.keychain.readSecret(
        r.newPhone.keychain.KEYCHAIN_ITEMS.walletRecoveryPhrase,
      ),
    ).toBe("twelve words");
    expect(
      r.newPhone.mmkv.getStorage("contacts-store").getString("contacts-store"),
    ).toContain("sam");
    // The old phone let go of everything, and neither phone owes a question.
    expect(await identityOf(r.oldPhone)).toBeNull();
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(r.newPhone.marker.readMoveMarker()).toBeNull();
    expect(r.resumed).not.toHaveBeenCalled();
    r.receiver.dispose();
  });

  it("refuses a phone other than the one scanned, and never stops the mesh", async () => {
    const r = await rig();
    const impostor = { ...r.invite, publicKey: new Uint8Array(32).fill(1) };
    r.send({ invite: impostor });
    expect(await until(() => lastPhase(r.senderStates) === "failed")).toBe(
      true,
    );
    expect(r.senderStates[r.senderStates.length - 1]).toEqual({
      phase: "failed",
      reason: "wrong-phone",
    });
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(await identityOf(r.newPhone)).toBeNull();
    r.receiver.dispose();
  });

  it("cancelled on the new phone mid-stream: nothing moves, the old phone runs again", async () => {
    const r = await rig();
    // Park the first chunk (frames 0-1 are the handshake, 2 the offer), so the
    // cancel lands while the stream is still coming in.
    r.bus.intercept = (from, index) =>
      from === "old" && index === 3 ? "hold" : "deliver";
    r.send();
    expect(await until(() => lastPhase(r.receiverStates) === "receiving")).toBe(
      true,
    );
    r.receiver.cancel();
    r.bus.release();
    expect(await until(() => lastPhase(r.senderStates) === "failed")).toBe(
      true,
    );
    expect(r.resumed).toHaveBeenCalledTimes(1);
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(await identityOf(r.newPhone)).toBeNull();
  });

  it("a newer old phone is refused by an older new one, and nothing moves", async () => {
    const r = await rig({ old: "1.1.0", new: "1.0.8", evil: "1.0.8" });
    r.send();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "failed" &&
          lastPhase(r.receiverStates) === "failed",
      ),
    ).toBe(true);
    expect(r.senderStates[r.senderStates.length - 1]).toEqual({
      phase: "failed",
      reason: "incompatible",
    });
    expect(r.receiverStates[r.receiverStates.length - 1]).toEqual({
      phase: "failed",
      reason: "incompatible",
    });
    expect(r.resumed).toHaveBeenCalledTimes(1);
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
  });

  it("the new phone cannot store it: it wipes itself, the old phone runs again", async () => {
    const r = await rig();
    const identityItem = r.newPhone.keychain.KEYCHAIN_ITEMS.identity;
    const real = r.newPhone.secureStore.setItemAsync.getMockImplementation();
    r.newPhone.secureStore.setItemAsync.mockImplementation(
      async (key: string, value: string) => {
        if (key === identityItem) throw new Error("keystore refused");
        return real?.(key, value);
      },
    );
    r.send();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "failed" &&
          lastPhase(r.receiverStates) === "failed",
      ),
    ).toBe(true);
    expect(r.receiverStates[r.receiverStates.length - 1]).toEqual({
      phase: "failed",
      reason: "storage",
    });
    expect(r.senderStates[r.senderStates.length - 1]).toEqual({
      phase: "failed",
      reason: "storage",
    });
    // Everything half-written went with the wipe, the marker included.
    expect(r.newPhone.marker.readMoveMarker()).toBeNull();
    // What the wipe leaves is the store's own empty state, not what arrived.
    expect(
      r.newPhone.mmkv
        .getStorage("contacts-store")
        .getString("contacts-store") ?? "",
    ).not.toContain("sam");
    expect(await identityOf(r.newPhone)).toBeNull();
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(r.resumed).toHaveBeenCalledTimes(1);
  });

  it("the link dies mid-stream: nothing moves, the old phone runs again", async () => {
    const r = await rig();
    // Frames 0-1 are the handshake, 2 the offer; cut on the first chunk.
    r.bus.intercept = (from, index) =>
      from === "old" && index === 3 ? "drop-link" : "deliver";
    r.send();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "failed" &&
          lastPhase(r.receiverStates) === "failed",
      ),
    ).toBe(true);
    expect(r.resumed).toHaveBeenCalledTimes(1);
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(await identityOf(r.newPhone)).toBeNull();
  });

  it("the link dies after the commit: the new phone asks, the old one stays frozen and asks", async () => {
    const r = await rig();
    // The new phone's commit never arrives.
    let newWrites = 0;
    r.bus.intercept = (from) => {
      if (from !== "new") return "deliver";
      newWrites += 1;
      // Its handshake reply, then the confirm, then the commit.
      return newWrites === 3 ? "drop-link" : "deliver";
    };
    r.send();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "unconfirmed" &&
          lastPhase(r.receiverStates) === "done",
        15_000,
      ),
    ).toBe(true);
    expect(r.receiverStates[r.receiverStates.length - 1]).toEqual({
      phase: "done",
      peerID: r.peerID,
      released: false,
    });
    // Both phones hold the identity, and neither may act on it alone.
    expect(await identityOf(r.newPhone)).toBe(r.peerID);
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(r.newPhone.marker.readMoveMarker()).toBe("committed");
    expect(r.oldPhone.marker.readMoveMarker()).toBe("sent");
    expect(r.resumed).not.toHaveBeenCalled();
  });

  it("cancelled on the old phone mid-stream: it runs again, the new phone says so", async () => {
    const r = await rig();
    r.bus.intercept = (from, index) =>
      from === "old" && index === 3 ? "hold" : "deliver";
    const sender = r.send();
    expect(
      await until(() => r.senderStates.some((x) => x.phase === "sending")),
    ).toBe(true);
    sender.cancel();
    r.bus.release();
    expect(
      await until(
        () =>
          lastPhase(r.receiverStates) === "failed" &&
          r.resumed.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(r.receiverStates[r.receiverStates.length - 1]).toEqual({
      phase: "failed",
      reason: "cancelled",
    });
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(await identityOf(r.newPhone)).toBeNull();
  });

  it("without chat history the rooms and their keys move, the messages do not", async () => {
    const r = await rig();
    r.send({ history: false });
    expect(await until(() => lastPhase(r.receiverStates) === "done")).toBe(
      true,
    );
    const chat =
      r.newPhone.mmkv.getStorage("chat-store").getString("airhop-chat") ?? "";
    expect(chat).toContain("a2V5");
    expect(chat).not.toContain("hello");
    r.receiver.dispose();
  });
});

describe("device transfer, the words both phones show", () => {
  const wordsOf = <T extends { phase: string }>(states: T[]): unknown =>
    (
      states.find((s) => s.phase === "verify" || s.phase === "confirm") as
        { words?: string[] } | undefined
    )?.words;

  it("installs nothing and freezes nothing until the new phone's person matches the words", async () => {
    const r = await rig(undefined, false);
    r.send();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "awaiting" &&
          lastPhase(r.receiverStates) === "confirm",
      ),
    ).toBe(true);
    await settle();
    // Six untranslated words, the same on both screens.
    const words = wordsOf(r.senderStates);
    expect(words).toHaveLength(6);
    expect(wordsOf(r.receiverStates)).toEqual(words);
    // A kill here leaves both phones as they were: no marker, mesh running.
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(r.newPhone.marker.readMoveMarker()).toBeNull();
    expect(r.oldPhone.mesh.destroyMeshService).not.toHaveBeenCalled();
    expect(await identityOf(r.newPhone)).toBeNull();

    r.receiver.confirm();
    expect(await until(() => lastPhase(r.receiverStates) === "done")).toBe(
      true,
    );
    expect(await identityOf(r.newPhone)).toBe(r.peerID);
    r.receiver.dispose();
  });

  it("holds a confirm that lands before the Transfer tap, and freezes only on the tap", async () => {
    const r = await rig();
    const sender = r.send({ autoProceed: false });
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "verify" &&
          lastPhase(r.receiverStates) === "receiving",
      ),
    ).toBe(true);
    await settle();
    expect(lastPhase(r.senderStates)).toBe("verify");
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(r.oldPhone.mesh.destroyMeshService).not.toHaveBeenCalled();

    sender.proceed();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "done" &&
          lastPhase(r.receiverStates) === "done",
      ),
    ).toBe(true);
    // Straight from the tap to the stream: the held confirm was enough.
    expect(r.senderStates.map((s) => s.phase)).not.toContain("awaiting");
    expect(await identityOf(r.newPhone)).toBe(r.peerID);
    r.receiver.dispose();
  });

  it("cancel on the new phone at the words: the old phone was never frozen, and a fresh code replaces the one read", async () => {
    const r = await rig(undefined, false);
    r.send();
    expect(await until(() => lastPhase(r.receiverStates) === "confirm")).toBe(
      true,
    );
    r.receiver.decline();
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "failed" &&
          lastPhase(r.receiverStates) === "waiting",
      ),
    ).toBe(true);
    expect(r.senderStates[r.senderStates.length - 1]).toEqual({
      phase: "failed",
      reason: "cancelled",
    });
    const first = r.receiverStates.find((s) => s.phase === "waiting");
    const next = r.receiverStates[r.receiverStates.length - 1];
    expect(next).not.toEqual(first);
    expect(r.resumed).not.toHaveBeenCalled();
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(r.oldPhone.mesh.destroyMeshService).not.toHaveBeenCalled();
    expect(await identityOf(r.oldPhone)).toBe(r.peerID);
    expect(await identityOf(r.newPhone)).toBeNull();
    r.receiver.dispose();
  });

  it("cancel on the old phone at the words: nothing was frozen, the new phone says so", async () => {
    const r = await rig(undefined, false);
    const sender = r.send({ autoProceed: false });
    expect(
      await until(
        () =>
          lastPhase(r.senderStates) === "verify" &&
          lastPhase(r.receiverStates) === "confirm",
      ),
    ).toBe(true);
    sender.cancel();
    expect(await until(() => lastPhase(r.receiverStates) === "failed")).toBe(
      true,
    );
    expect(r.receiverStates[r.receiverStates.length - 1]).toEqual({
      phase: "failed",
      reason: "cancelled",
    });
    expect(r.resumed).not.toHaveBeenCalled();
    expect(r.oldPhone.mesh.destroyMeshService).not.toHaveBeenCalled();
    expect(await identityOf(r.newPhone)).toBeNull();
  });

  it("never dials a code whose address is on no network this phone is on", async () => {
    const r = await rig();
    r.send({ invite: { ...r.invite, hosts: ["203.0.113.7"] } });
    expect(await until(() => lastPhase(r.senderStates) === "failed")).toBe(
      true,
    );
    expect(r.senderStates[r.senderStates.length - 1]).toEqual({
      phase: "failed",
      reason: "unreachable",
    });
    expect(r.bus.dials).toBe(0);
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    r.receiver.dispose();
  });

  it("I04 someone who read the code races the real old phone: the new phone installs nothing unless its person confirms", async () => {
    const r = await rig(undefined, false);
    const evilStates: SenderModule.SenderState[] = [];
    r.send({ from: "evil", states: evilStates });
    expect(await until(() => lastPhase(r.receiverStates) === "confirm")).toBe(
      true,
    );
    // The real old phone arrives second and is turned away before any words.
    r.send();
    expect(await until(() => lastPhase(r.senderStates) === "failed")).toBe(
      true,
    );
    expect(r.senderStates.map((s) => s.phase)).not.toContain("verify");
    expect(r.oldPhone.marker.readMoveMarker()).toBeNull();
    expect(r.oldPhone.mesh.destroyMeshService).not.toHaveBeenCalled();

    // The new phone shows the intruder's words, which the old phone never shows.
    await settle();
    expect(lastPhase(r.receiverStates)).toBe("confirm");
    expect(await identityOf(r.newPhone)).toBeNull();
    const confirm = r.receiverStates[r.receiverStates.length - 1];
    expect(confirm.phase === "confirm" && confirm.peerID).not.toBe(r.peerID);

    r.receiver.decline();
    expect(await until(() => lastPhase(evilStates) === "failed")).toBe(true);
    expect(await until(() => lastPhase(r.receiverStates) === "waiting")).toBe(
      true,
    );
    expect(await identityOf(r.newPhone)).toBeNull();

    // The code that was read no longer opens anything.
    const retried: SenderModule.SenderState[] = [];
    r.send({ from: "evil", states: retried });
    expect(await until(() => lastPhase(retried) === "failed")).toBe(true);
    expect(retried[retried.length - 1]).toEqual({
      phase: "failed",
      reason: "wrong-phone",
    });

    // The person scans the fresh code with the real old phone and confirms.
    const fresh = r.receiverStates[r.receiverStates.length - 1];
    const invite =
      fresh.phase === "waiting"
        ? r.newPhone.invite.decodeMoveInvite(fresh.code)
        : null;
    if (invite === null) throw new Error("no fresh code");
    const states: SenderModule.SenderState[] = [];
    r.send({ invite, states });
    expect(await until(() => lastPhase(r.receiverStates) === "confirm")).toBe(
      true,
    );
    r.receiver.confirm();
    expect(
      await until(
        () =>
          lastPhase(states) === "done" &&
          lastPhase(r.receiverStates) === "done",
      ),
    ).toBe(true);
    expect(await identityOf(r.newPhone)).toBe(r.peerID);
    r.receiver.dispose();
  });
});
