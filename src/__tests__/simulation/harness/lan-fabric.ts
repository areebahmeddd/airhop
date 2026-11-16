// The LAN transport, as a fabric.
//
// A network, not a set of pairs. That is what separates it from WifiFabric:
// mDNS reveals EVERY device at once, the shape Bluetooth cannot produce and the
// one `lan-dial-policy.ts` exists to survive. A fabric that revealed peers pair
// by pair would never exercise it.
//
// Three rules it models, all real and all easy to get wrong:
//
//   1. Discovery is a network. Joining reveals you to everyone already there,
//      and them to you, in one go.
//   2. Linking is a decision. The fabric never opens a link on its own: a
//      device dials, having been told who to. A wrong cap shows up here as a
//      wrong socket count.
//   3. Client isolation exists. Most venue WiFi passes mDNS and drops the TCP,
//      and nothing in the app can detect it before trying.
//   4. mDNS filtering exists too. Ships, hotels and conferences drop the
//      multicast and still pass the TCP, so only a dial at an address handed
//      over some other way gets through. Every device has an address on its
//      network's /24, and a publishing device a port.
//
// Deliberately NOT modeled: MTU, loss, per-hop latency. A LAN link is a TCP
// socket, up or not, carrying whole frames. Same reasoning WifiFabric records.

import type { World } from "./world";

// What the fabric needs from a device. Structural, so a SimDevice satisfies it
// without the fabric importing one.
export interface LanNode {
  readonly id: string;
  attachLanPort(port: LanPort): void;
}

export interface LanPort {
  // The app published under this name. Chosen by the app, random per session,
  // and never the peer ID.
  start(instanceName: string): void;
  stop(): void;
  // The app asked to open a link to a peer it was told about.
  connect(serviceName: string): void;
  listenPort(): number;
  // The app dialed an address under a link ID of its own choosing; returns
  // whether anything answered.
  connectAddress(host: string, port: number, linkID: string): boolean;
  closeLink(linkID: string): void;
  localSubnets(): { address: string; prefixLength: number }[];
  write(linkID: string, dataBase64: string): void;
  // Raise one of the `AirhopLAN.*` events on this device.
  emit(event: string, body: Record<string, unknown>): void;
}

// A link is named by the far side, matching how mesh-service treats a linkID as
// an opaque handle it writes back to.
function handleFor(farSideID: string): string {
  return `lan:${farSideID}`;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function base64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, (b64.length * 3) / 4 - padding);
}

interface Publisher {
  readonly deviceID: string;
  readonly instanceName: string;
  readonly network: string;
}

export class LanFabric {
  private readonly nodes = new Map<string, LanNode>();
  private readonly ports = new Map<string, LanPort>();
  // Which network each device is joined to, if any.
  private readonly joined = new Map<string, string>();
  // Devices currently publishing, by the name they publish under.
  private readonly publishers = new Map<string, Publisher>();
  // Networks whose access point refuses peer-to-peer traffic.
  private readonly isolated = new Set<string>();
  // Networks that drop mDNS and still pass the TCP.
  private readonly mdnsFiltered = new Set<string>();
  // Each device's address on its network, and a listening port per device.
  private readonly addresses = new Map<string, string>();
  private readonly listenPorts = new Map<string, number>();
  private readonly networkIndex = new Map<string, number>();
  // Link handles a device chose itself, by device and handle, to the far side.
  private readonly chosenHandles = new Map<string, string>();
  // Undirected pairs currently linked, keyed a|b with a < b.
  private readonly links = new Set<string>();
  private disposed = false;

  // Counters a scenario can assert on. `dialsRefused` is the client-isolation
  // one: peers were found and none of them could be reached.
  framesCarried = 0;
  bytesCarried = 0;
  dialsAttempted = 0;
  dialsRefused = 0;

  constructor(private readonly world: World) {
    world.onClose(() => {
      this.disposed = true;
    });
  }

  add(node: LanNode): void {
    this.nodes.set(node.id, node);
    const port: LanPort = {
      start: (instanceName) => this.onStart(node.id, instanceName),
      stop: () => this.onStop(node.id),
      connect: (serviceName) => this.onConnect(node.id, serviceName),
      listenPort: () =>
        this.nameOf(node.id) === undefined
          ? 0
          : (this.listenPorts.get(node.id) ?? 0),
      connectAddress: (host, port, linkID) =>
        this.onConnectAddress(node.id, host, port, linkID),
      closeLink: (linkID) => {
        const far = this.farSide(node.id, linkID);
        if (far !== undefined) this.unlink(node.id, far);
      },
      localSubnets: () => {
        const address = this.addresses.get(node.id);
        return address === undefined ? [] : [{ address, prefixLength: 24 }];
      },
      write: (linkID, dataBase64) => this.onWrite(node.id, linkID, dataBase64),
      // Replaced by the device when it attaches; this default keeps the type
      // honest for a node that never wires an emitter.
      emit: () => undefined,
    };
    node.attachLanPort(port);
    this.ports.set(node.id, port);
  }

  // Put a device on a network. Joining is not publishing: the app still has to
  // be running with the transport switched on before anything is announced.
  join(deviceID: string, network: string): void {
    this.joined.set(deviceID, network);
    if (!this.networkIndex.has(network)) {
      this.networkIndex.set(network, this.networkIndex.size + 1);
    }
    const onNetwork = [...this.joined.values()].filter(
      (n) => n === network,
    ).length;
    this.addresses.set(
      deviceID,
      `10.${String(this.networkIndex.get(network))}.0.${String(onNetwork + 1)}`,
    );
    if (!this.listenPorts.has(deviceID)) {
      this.listenPorts.set(deviceID, 40_000 + this.listenPorts.size);
    }
    this.world.say("LAN_JOINED", `${deviceID} joined ${network}`);
    // Already publishing on another network, or none: re-announce so the new
    // network sees it and the old one does not.
    const existing = this.publishers.get(this.nameOf(deviceID) ?? "");
    if (existing !== undefined) this.onStart(deviceID, existing.instanceName);
  }

  // Take a device off the network, as walking out of the building does.
  leave(deviceID: string): void {
    this.joined.delete(deviceID);
    this.addresses.delete(deviceID);
    this.onStop(deviceID);
    for (const key of [...this.links]) {
      const [a, b] = key.split("|");
      if (a === deviceID || b === deviceID) this.unlink(a, b);
    }
    this.world.say("LAN_LEFT", `${deviceID} left the network`);
  }

  // Make a network behave the way most guest WiFi does: mDNS crosses, TCP does
  // not. Cannot be detected before dialing, which is the point.
  setClientIsolation(network: string, isolated: boolean): void {
    if (isolated) this.isolated.add(network);
    else this.isolated.delete(network);
    this.world.say(
      "LAN_ISOLATION",
      `${network} peer-to-peer traffic ${isolated ? "blocked" : "allowed"}`,
    );
  }

  setMdnsFiltered(network: string, filtered: boolean): void {
    if (filtered) this.mdnsFiltered.add(network);
    else this.mdnsFiltered.delete(network);
    this.world.say(
      "LAN_MDNS",
      `${network} multicast ${filtered ? "filtered" : "passed"}`,
    );
  }

  addressOf(deviceID: string): string | undefined {
    return this.addresses.get(deviceID);
  }

  linkCount(): number {
    return this.links.size;
  }

  linkCountFor(deviceID: string): number {
    let count = 0;
    for (const key of this.links) {
      const [a, b] = key.split("|");
      if (a === deviceID || b === deviceID) count++;
    }
    return count;
  }

  isLinked(aID: string, bID: string): boolean {
    return this.links.has(pairKey(aID, bID));
  }

  private nameOf(deviceID: string): string | undefined {
    for (const p of this.publishers.values()) {
      if (p.deviceID === deviceID) return p.instanceName;
    }
    return undefined;
  }

  // The app started publishing. Everyone already on this network learns about
  // it, and it learns about them, in the one burst mDNS delivers.
  private onStart(deviceID: string, instanceName: string): void {
    if (this.disposed) return;
    const network = this.joined.get(deviceID);
    if (network === undefined) {
      // Publishing while on no network reaches nobody, which is exactly what
      // the real module reports as unavailable.
      this.world.say("LAN_NO_NETWORK", `${deviceID} published with no network`);
      return;
    }
    const previous = this.nameOf(deviceID);
    if (previous !== undefined) this.publishers.delete(previous);
    this.publishers.set(instanceName, { deviceID, instanceName, network });
    this.world.say("LAN_PUBLISHED", `${deviceID} as ${instanceName}`);

    if (this.mdnsFiltered.has(network)) return;
    for (const peer of this.publishers.values()) {
      if (peer.deviceID === deviceID || peer.network !== network) continue;
      this.reveal(deviceID, peer);
      this.reveal(peer.deviceID, {
        deviceID,
        instanceName,
        network,
      });
    }
  }

  private onStop(deviceID: string): void {
    const name = this.nameOf(deviceID);
    if (name === undefined) return;
    this.publishers.delete(name);
    for (const peer of this.publishers.values()) {
      this.ports.get(peer.deviceID)?.emit("AirhopLAN.peerLost", {
        serviceName: name,
      });
    }
    this.world.say("LAN_UNPUBLISHED", `${deviceID} stopped publishing`);
  }

  private reveal(toDeviceID: string, peer: Publisher): void {
    this.ports.get(toDeviceID)?.emit("AirhopLAN.peerDiscovered", {
      serviceName: peer.instanceName,
    });
  }

  // A device dialed a peer it was told about. This is the only way a link
  // comes up: the fabric never decides.
  private onConnect(fromID: string, serviceName: string): void {
    if (this.disposed) return;
    this.dialsAttempted++;
    const peer = this.publishers.get(serviceName);
    const network = this.joined.get(fromID);
    if (peer === undefined || network === undefined) {
      this.dialsRefused++;
      return;
    }
    if (peer.network !== network) {
      this.dialsRefused++;
      return;
    }
    if (this.isolated.has(network)) {
      // The access point drops it. Discovery worked and the connection does
      // not, which is exactly what a venue network does and what the app can
      // only find out by trying.
      this.dialsRefused++;
      this.world.say(
        "LAN_ISOLATED_DIAL",
        `${fromID} could not reach ${peer.deviceID}: client isolation`,
      );
      return;
    }
    this.linkUp(fromID, peer.deviceID);
  }

  // A dial at an address: the device listening there on this network, if
  // it publishes on that port and the network passes peer traffic.
  private onConnectAddress(
    fromID: string,
    host: string,
    port: number,
    linkID: string,
  ): boolean {
    if (this.disposed) return false;
    this.dialsAttempted++;
    const network = this.joined.get(fromID);
    const target = [...this.addresses].find(
      ([id, address]) =>
        address === host && this.joined.get(id) === network && id !== fromID,
    )?.[0];
    if (
      network === undefined ||
      target === undefined ||
      this.isolated.has(network) ||
      this.nameOf(target) === undefined ||
      this.listenPorts.get(target) !== port
    ) {
      this.dialsRefused++;
      return false;
    }
    this.world.say("LAN_ADDRESS_DIAL", `${fromID} dialed ${host}:${port}`);
    this.linkUp(fromID, target, linkID);
    return true;
  }

  private handleOf(deviceID: string, farID: string): string {
    for (const [key, far] of this.chosenHandles) {
      const [owner, handle] = key.split("|");
      if (owner === deviceID && far === farID) return handle;
    }
    return handleFor(farID);
  }

  private farSide(deviceID: string, linkID: string): string | undefined {
    const chosen = this.chosenHandles.get(`${deviceID}|${linkID}`);
    if (chosen !== undefined) return chosen;
    return linkID.startsWith("lan:") ? linkID.slice("lan:".length) : undefined;
  }

  private linkUp(aID: string, bID: string, aHandle?: string): void {
    const key = pairKey(aID, bID);
    if (this.links.has(key)) return;
    this.links.add(key);
    if (aHandle !== undefined) this.chosenHandles.set(`${aID}|${aHandle}`, bID);
    this.world.say("LAN_LINK_UP", `${aID} <-> ${bID}`);
    this.ports.get(aID)?.emit("AirhopLAN.linkConnected", {
      linkID: this.handleOf(aID, bID),
    });
    this.ports.get(bID)?.emit("AirhopLAN.linkConnected", {
      linkID: this.handleOf(bID, aID),
    });
  }

  unlink(aID: string, bID: string): void {
    const key = pairKey(aID, bID);
    if (!this.links.delete(key)) return;
    this.world.say("LAN_LINK_DOWN", `${aID} <-> ${bID}`);
    const aHandle = this.handleOf(aID, bID);
    const bHandle = this.handleOf(bID, aID);
    this.chosenHandles.delete(`${aID}|${aHandle}`);
    this.chosenHandles.delete(`${bID}|${bHandle}`);
    this.ports.get(aID)?.emit("AirhopLAN.linkDisconnected", {
      linkID: aHandle,
    });
    this.ports.get(bID)?.emit("AirhopLAN.linkDisconnected", {
      linkID: bHandle,
    });
  }

  private onWrite(fromID: string, linkID: string, dataBase64: string): void {
    if (this.disposed) return;
    const toID = this.farSide(fromID, linkID) ?? "";
    if (!this.links.has(pairKey(fromID, toID))) return;
    const to = this.ports.get(toID);
    if (to === undefined) return;

    this.framesCarried++;
    this.bytesCarried += base64ByteLength(dataBase64);

    // A whole frame in one piece, on a later tick so nothing in the app can
    // depend on a synchronous write.
    this.world.carry(1, () => {
      if (this.disposed) return;
      to.emit("AirhopLAN.packetReceived", {
        linkID: this.handleOf(toID, fromID),
        dataBase64,
      });
    });
  }
}
