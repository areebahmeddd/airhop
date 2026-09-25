/**
 * @jest-environment node
 */
// The background reconcile pass: what it does on its own once the network is
// back, and what stops it.
//
// Runs the real wallet service against the simulated mint.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { useSettingsStore } from "@store/settings-store";
import {
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import { Platform } from "react-native";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  initWalletService,
  receiveToken,
  reconcile,
  resetWalletService,
} from "../wallet-service";

jest.mock("@core/crypto/keychain", () => {
  const secrets = new Map<string, string>();
  return {
    ...jest.requireActual("@core/crypto/keychain"),
    readSecret: jest.fn((item: string) =>
      Promise.resolve(secrets.get(item) ?? null),
    ),
    writeSecret: jest.fn((item: string, value: string) => {
      secrets.set(item, value);
      return Promise.resolve();
    }),
  };
});

jest.mock("react-native-mmkv", () => {
  class MockMMKV {
    private store = new Map<string, string>();
    getString(key: string): string | undefined {
      return this.store.get(key);
    }
    set(key: string, value: string): void {
      this.store.set(key, value);
    }
    remove(key: string): void {
      this.store.delete(key);
    }
    encrypt(): void {}
    clearAll(): void {
      this.store.clear();
    }
  }
  const instances = new Map<string, MockMMKV>();
  return {
    createMMKV: ({ id = "default" }: { id?: string } = {}) => {
      if (!instances.has(id)) instances.set(id, new MockMMKV());
      return instances.get(id)!;
    },
    deleteMMKV: jest.fn(() => true),
  };
});

jest.setTimeout(60_000);

const UNIT = "sat";

let world: World;
let fabric: MintFabric;

async function strangersToken(sats: number): Promise<string> {
  const sender = new Wallet(new Mint(fabric.url), { unit: UNIT });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(sats);
  const proofs = await sender.mintProofsBolt11(sats, quote);
  return getEncodedToken({
    mint: fabric.url,
    unit: UNIT,
    proofs,
  } as unknown as Token);
}

function pendingPreviews(): number {
  return useWalletStore
    .getState()
    .history.filter((t) => t.status === "pending" && t.swapPreview).length;
}

// Every mint request from here on, by path, with a hook that runs as each one
// leaves (before the mint answers).
function watchRequests(onRequest: (path: string) => void): {
  paths: string[];
  stop: () => void;
} {
  const inner = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith(fabric.url)) {
      const path = url.slice(fabric.url.length);
      paths.push(path);
      onRequest(path);
    }
    return inner(input as RequestInfo, init as RequestInit);
  }) as typeof globalThis.fetch;
  return {
    paths,
    stop: () => {
      globalThis.fetch = inner;
    },
  };
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 31, name: "wallet-reconcile" });
  fabric = new MintFabric(world, "https://reconcile.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({
    offline: false,
    latencyMs: 0,
    swapResponseLost: false,
  });
  useSettingsStore.setState({
    internetEnabled: true,
    torEnabled: false,
    allowMintOverClearnet: false,
  });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("Tor switched on while a pass is running (iOS)", () => {
  it("lets no further mint request out once the gate closes", async () => {
    // The gate that refuses a clear-net mint call applies on iOS only; the
    // test environment reports iOS.
    expect(Platform.OS).toBe("ios");

    // Two swaps whose answers were lost, so the pass has two replays to make.
    fabric.setConditions({ swapResponseLost: true });
    for (const sats of [8, 16]) {
      const received = await receiveToken(await strangersToken(sats));
      expect(received.outcome).toBe("stored");
    }
    fabric.setConditions({ swapResponseLost: false });
    expect(pendingPreviews()).toBe(2);

    let gateClosedAt = -1;
    const watch = watchRequests((path) => {
      if (gateClosedAt < 0 && path.startsWith("/v1/swap")) {
        useSettingsStore.setState({ torEnabled: true });
        gateClosedAt = watch.paths.length;
      }
    });
    try {
      await reconcile();
    } finally {
      watch.stop();
    }

    // The replay already on the wire lands and is written; nothing follows.
    expect(gateClosedAt).toBeGreaterThan(0);
    expect(watch.paths.length).toBe(gateClosedAt);
    expect(pendingPreviews()).toBe(1);
  });
});
