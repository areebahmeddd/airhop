// Refreshing an account swaps each offline receipt on its own. A receipt is
// the unit of refusal, as in CDK and Nutshell: a token the mint will not take
// can cost only itself, never block the honest receipts beside it or every
// later refresh. And a coin is verified only by a swap that completed, never by a
// state check (NUT-07 calls a coin it has never seen unspent).
//
// Runs the real wallet service against the simulated mint, which verifies
// every input it is handed.

import {
  getDecodedToken,
  getEncodedToken,
  Mint,
  Wallet,
  type Token,
} from "@cashu/cashu-ts";
import type { StoredProof } from "@core/payments/stored-proof";
import { t } from "@i18n";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useSettingsStore } from "@store/settings-store";
import {
  accountKey,
  bootstrapWalletStorage,
  keysetRefsOf,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  claimLightningDeposit,
  confirmSend,
  createLightningDeposit,
  initWalletService,
  prepareSend,
  receiveToken,
  reclaimSend,
  refreshAccount,
  resetWalletService,
  settleReclaim,
} from "../wallet-service";
import { receiveOffline, strangersTokenAt } from "./wallet-test-helpers";

jest.setTimeout(60_000);

const UNIT = "sat";

let world: World;
let fabric: MintFabric;

function held(): StoredProof[] {
  return useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? [];
}

function sum(proofs: StoredProof[]): number {
  return proofs.reduce((s, p) => s + p.amount, 0);
}

// Every coin this account holds, spendable or reserved.
function everyCoin(): StoredProof[] {
  const reserved = Object.values(useWalletStore.getState().reserved).flatMap(
    (entry) => entry.proofs,
  );
  return [...held(), ...reserved];
}

function row(id: string) {
  return useWalletStore.getState().history.find((t) => t.id === id);
}

function receiptOf(sats: number): string | undefined {
  return held().find((p) => p.amount === sats)?.receiptTxId;
}

function strangersToken(sats: number): Promise<string> {
  return strangersTokenAt(fabric.url, sats);
}

// Coins the mint signed and now refuses to swap: the DLEQ checks out offline,
// and only the mint can tell.
async function refusedToken(sats: number): Promise<string> {
  const token = await strangersToken(sats);
  const ids = keysetRefsOf(useWalletStore.getState().mints).map((k) => k.id);
  for (const proof of getDecodedToken(token, ids).proofs) {
    fabric.disown(proof.secret);
  }
  return token;
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 41, name: "wallet-receipts" });
  fabric = new MintFabric(world, "https://receipts.test");
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
    inputFeePpk: 0,
  });
  useSettingsStore.setState({ internetEnabled: true, torEnabled: false });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("one refused receipt among honest ones", () => {
  it("is refused on its own, and the honest ones are swapped", async () => {
    await receiveOffline(await strangersToken(8));
    await receiveOffline(await strangersToken(16));
    await receiveOffline(await refusedToken(32));
    const honest = [receiptOf(8)!, receiptOf(16)!];
    const refused = receiptOf(32)!;
    expect(sum(held())).toBe(56);

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.swapped).toBe(24);
    expect(result.refused).toBe(32);
    expect(result.receipts[refused]).toBe("refused");
    expect(sum(held())).toBe(24);
    expect(held().every((p) => p.verified === true)).toBe(true);
    for (const id of honest) expect(row(id)?.status).toBe("completed");
    // Not destroyed: the row keeps them as a token to hand back.
    expect(row(refused)?.status).toBe("failed");
    expect(row(refused)?.token).toMatch(/^cashuB/);
  });

  it("is no longer called taken in, so its token goes back to the mint", async () => {
    const refused = await refusedToken(32);
    await receiveOffline(refused);
    await refreshAccount(fabric.url, UNIT);

    expect(useWalletStore.getState().claimedTokens).toHaveLength(0);
    // Pasted again it is refused by the mint, not read as already held.
    await expect(receiveToken(refused)).rejects.toMatchObject({
      code: "mint-error",
    });
  });

  it("leaves the next refresh with nothing to fail on", async () => {
    await receiveOffline(await refusedToken(32));
    await refreshAccount(fabric.url, UNIT);

    await receiveOffline(await strangersToken(8));
    const second = await refreshAccount(fabric.url, UNIT);
    expect(second.refused).toBe(0);
    expect(second.swapped).toBe(8);
  });
});

describe("verified", () => {
  it("is never granted by a state check while the swap is in doubt", async () => {
    await receiveOffline(await strangersToken(8));
    fabric.setConditions({ swapResponseLost: true });

    await expect(refreshAccount(fabric.url, UNIT)).rejects.toMatchObject({
      code: "offline",
    });

    // Held against the staged swap for `reconcile`, and still unconfirmed.
    expect(everyCoin().length).toBeGreaterThan(0);
    expect(everyCoin().every((p) => p.verified !== true)).toBe(true);
  });

  it("is never granted to coins that cannot be checked offline", async () => {
    // A keyset this phone has no keys for, so no DLEQ can be checked: the
    // claim waits for the mint rather than being taken on trust.
    const token = getEncodedToken({
      mint: fabric.url,
      unit: UNIT,
      proofs: [
        {
          id: "00" + "ee".repeat(7),
          amount: 8,
          secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
          C: bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(4))),
        },
      ],
    } as unknown as Token);
    useSettingsStore.setState({ internetEnabled: false });
    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "offline",
      copy: { key: "wallet.svc.offline_unchecked" },
    });
    expect(everyCoin()).toHaveLength(0);
    expect(useWalletStore.getState().claimedTokens).toHaveLength(0);
  });

  it("is never granted to coins the mint will not take", async () => {
    await receiveOffline(await refusedToken(16));
    await refreshAccount(fabric.url, UNIT);
    expect(everyCoin()).toHaveLength(0);
  });
});

describe("a receipt worth no more than its fee", () => {
  it("is left unconfirmed rather than swapped at a loss or refused", async () => {
    fabric.setConditions({ inputFeePpk: 1000 });
    await addMint(fabric.url);
    await receiveOffline(await strangersToken(1));
    const dust = receiptOf(1)!;

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.receipts[dust]).toBe("skipped");
    expect(result.stillUnverified).toBe(1);
    expect(row(dust)?.status).toBe("pending");
  });
});

describe("a receipt whose coins are paid on", () => {
  it("closes once they are delivered, with no swap left to confirm it", async () => {
    await receiveOffline(await strangersToken(8));
    const receipt = receiptOf(8)!;

    const send = await prepareSend({ amount: 8 });
    expect(row(receipt)?.status).toBe("pending");
    confirmSend(send.txId);

    expect(row(receipt)?.status).toBe("completed");
  });

  it("closes once a reclaim files its coins under the send", async () => {
    await receiveOffline(await strangersToken(8));
    const receipt = receiptOf(8)!;

    const send = await prepareSend({ amount: 8 });
    expect(reclaimSend(send.txId)).toBe(true);

    expect(row(receipt)?.status).toBe("completed");
    expect(row(send.txId)?.status).toBe("reclaimed");
  });
});

describe("settling a reclaim", () => {
  it("keeps a refused reclaim's token to copy, saying the coins were its own", async () => {
    await receiveOffline(await refusedToken(32));
    const send = await prepareSend({ amount: 32 });
    expect(reclaimSend(send.txId)).toBe(true);

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.receipts[send.txId]).toBe("refused");
    expect(row(send.txId)?.status).toBe("failed");
    expect(row(send.txId)?.token).toMatch(/^cashuB/);
    expect(row(send.txId)?.error).toBe(t("wallet.svc.reclaim_refused"));
    // Airhop's words, so kept by key for the language the wallet is read in.
    expect(row(send.txId)?.errorKey).toBe("wallet.svc.reclaim_refused");
  });

  it("reads as sent when the refresh finds the recipient redeemed it first", async () => {
    // A stranger's coins, so the ones the recipient spends are not secrets
    // this wallet's phrase derives again in the next test.
    await receiveOffline(await strangersToken(8));
    const send = await prepareSend({ amount: 8 });
    const recipient = new Wallet(new Mint(fabric.url), { unit: UNIT });
    await recipient.loadMint();
    await recipient.receive(send.token);

    // Reclaimed with nothing asked of the mint, as offline; the refresh
    // learns the rest.
    expect(reclaimSend(send.txId)).toBe(true);
    await refreshAccount(fabric.url, UNIT);

    expect(row(send.txId)?.status).toBe("completed");
    expect(sum(held())).toBe(0);
    // The send is the debit; a second "spent proofs removed" would count it
    // twice.
    expect(
      useWalletStore.getState().history.some((t) => t.spentRemoved === true),
    ).toBe(false);
  });

  it("swaps the reclaimed coins even behind a queue of older receipts", async () => {
    // Nine older receipts, one more than a refresh swaps in one go.
    for (let i = 0; i < 9; i++) {
      await receiveOffline(await strangersToken(1));
    }
    const deposit = await createLightningDeposit({
      amount: 64,
      mintUrl: fabric.url,
    });
    await claimLightningDeposit(fabric.url, UNIT, deposit.quoteId);
    const send = await prepareSend({ amount: 64 });
    expect(reclaimSend(send.txId)).toBe(true);

    expect(await settleReclaim(send.txId)).toBe("secured");
    expect(
      held()
        .filter((p) => p.amount === 64)
        .every((p) => p.verified === true),
    ).toBe(true);
  });
});

// Answers 429 to every request for one keyset's keys, as a rate-limited mint
// does, until stopped.
function rateLimitKeysetKeys(): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    if (String(input).startsWith(`${fabric.url}/v1/keys/`)) {
      return Promise.resolve(new Response("", { status: 429 }));
    }
    return inner(input as RequestInfo, init as RequestInit);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = inner;
  };
}

describe("a mint that gives no answer about a receipt", () => {
  it("leaves it pending on a rate limit, never refused", async () => {
    // Coins from a keyset rotated out, so preparing the swap fetches its keys.
    await receiveOffline(await strangersToken(8));
    fabric.rotateKeyset();
    await addMint(fabric.url);
    const receipt = receiptOf(8)!;

    const stop = rateLimitKeysetKeys();
    try {
      await expect(refreshAccount(fabric.url, UNIT)).rejects.toBeDefined();
    } finally {
      stop();
    }
    expect(row(receipt)?.status).toBe("pending");
    expect(sum(held())).toBe(8);

    const result = await refreshAccount(fabric.url, UNIT);
    expect(result.receipts[receipt]).toBe("swapped");
    expect(row(receipt)?.status).toBe("completed");
  });
});
