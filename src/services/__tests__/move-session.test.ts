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
// where a real transfer meets it.

import type * as IdentityModule from "@core/crypto/identity";
import type * as KeychainModule from "@core/crypto/keychain";
import type * as InviteModule from "@core/move/move-invite";
import type { MoveInvite } from "@core/move/move-invite";
import type * as MmkvModule from "@store/mmkv";
import type { MoveLinkEvent } from "../move-link";
import type * as MarkerModule from "../move-marker";
import type * as ReceiverModule from "../move-receiver";
import type * as SenderModule from "../move-sender";

type Side = "old" | "new";

// ---- The link between the two phones ----

interface Connection {
  id: Record<Side, string>;
  open: boolean;
}

class LinkBus {
  private readonly listeners: Record<Side, ((e: MoveLinkEvent) => void)[]> = {
    old: [],
    new: [],
  };
  private listening = false;
  private readonly connections: Connection[] = [];
  private seq = 0;
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
  private written: Record<Side, number> = { old: 0, new: 0 };

  private emit(side: Side, event: MoveLinkEvent): void {
    for (const l of [...this.listeners[side]]) l(event);
  }

  private find(side: Side, id: string): Connection | undefined {
    return this.connections.find((c) => c.id[side] === id);
  }

  private close(c: Connection): void {
    if (!c.open) return;
    c.open = false;
    setImmediate(() => {
      this.emit("old", { kind: "closed", connectionID: c.id.old });
      this.emit("new", { kind: "closed", connectionID: c.id.new });
    });
  }

  linkFor(side: Side) {
    const other: Side = side === "old" ? "new" : "old";
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
        return { port: 45000, hosts: ["192.168.1.20"] };
      },
      stopMoveLink: async () => {
        if (side === "new") this.listening = false;
        for (const c of this.connections) this.close(c);
      },
      dialMove: async (host: string, port: number) => {
        if (!this.listening || host !== "192.168.1.20" || port !== 45000) {
          const { MoveDialError } =
            jest.requireActual<typeof import("../move-link")>("../move-link");
          throw new MoveDialError("unreachable");
        }
        this.seq += 1;
        const c: Connection = {
          id: { old: `out-${this.seq}`, new: `in-${this.seq}` },
          open: true,
        };
        this.connections.push(c);
        setImmediate(() =>
          this.emit("new", { kind: "connected", connectionID: c.id.new }),
        );
        return c.id.old;
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
        const copy = bytes.slice();
        // Like TCP: bytes written before a close still arrive, ahead of it.
        const deliver = () =>
          setImmediate(() =>
            this.emit(other, {
              kind: "data",
              connectionID: c.id[other],
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
      MoveDialError:
        jest.requireActual<typeof import("../move-link")>("../move-link")
          .MoveDialError,
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
}

const g = globalThis as unknown as {
  __moveBus: LinkBus;
  __moveSide: Side;
  __moveVersion: Record<Side, string>;
};

// Factories run once per phone, inside that phone's registry, so each captures
// the side being built. They reach the shared rig through globalThis, the one
// thing both registries have in common.
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
        sender: lastRig.senderStates,
        receiver: lastRig.receiverStates.map((x) => x.phase),
      }),
    );
  }
  return ok;
}

interface Rig {
  oldPhone: Phone;
  newPhone: Phone;
  bus: LinkBus;
  peerID: string;
  senderStates: SenderModule.SenderState[];
  receiverStates: ReceiverModule.ReceiverState[];
  resumed: jest.Mock;
  receiver: ReceiverModule.MoveReceiver;
  invite: MoveInvite;
  send: (invite?: MoveInvite, history?: boolean) => SenderModule.MoveSender;
}

async function rig(versions = { old: "1.0.8", new: "1.0.8" }): Promise<Rig> {
  const bus = new LinkBus();
  g.__moveBus = bus;
  g.__moveVersion = versions;
  const oldPhone = phone("old");
  const newPhone = phone("new");

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

  const receiverStates: ReceiverModule.ReceiverState[] = [];
  const receiver = new newPhone.receiver.MoveReceiver((s) =>
    receiverStates.push(s),
  );
  await receiver.start();
  const waiting = receiverStates.find((s) => s.phase === "waiting");
  if (waiting?.phase !== "waiting") throw new Error("no code shown");
  const invite = newPhone.invite.decodeMoveInvite(waiting.code);
  if (invite === null) throw new Error("code does not decode");

  const senderStates: SenderModule.SenderState[] = [];
  const resumed = jest.fn();
  const send = (target: MoveInvite = invite, history = true) => {
    const sender = new oldPhone.sender.MoveSender(target, history, {
      onChange: (s) => senderStates.push(s),
      onResume: resumed,
    });
    void sender.start();
    return sender;
  };
  lastRig = {
    oldPhone,
    newPhone,
    bus,
    peerID: id.peerID,
    senderStates,
    receiverStates,
    resumed,
    receiver,
    invite,
    send,
  };
  return {
    oldPhone,
    newPhone,
    bus,
    peerID: id.peerID,
    senderStates,
    receiverStates,
    resumed,
    receiver,
    invite,
    send,
  };
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
    r.send(impostor);
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
    const r = await rig({ old: "1.1.0", new: "1.0.8" });
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
      // Its handshake reply is the first write; the commit is the second.
      return newWrites === 2 ? "drop-link" : "deliver";
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
    r.send(r.invite, false);
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
