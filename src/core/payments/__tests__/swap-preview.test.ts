/**
 * @jest-environment node
 */
// A persisted swap preview must replay byte for byte.
//
// The mint keys its NUT-19 cache on the request body, so a replay that differs
// by one byte is a fresh spend of inputs already taken, which fails and loses
// the money. Pinned here: input key order (`JSON.stringify` follows insertion
// order, so rebuilding an input field by field changes the body; the module
// keeps inputs as an opaque round trip for this), and the whole request,
// replayed against a real mint.

import {
  Amount,
  Mint,
  normalizeProofAmounts,
  OutputData,
  Wallet,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { MintFabric } from "../../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../../__tests__/simulation/harness/world";
import {
  rebuildSwapPreview,
  serializeSwapPreview,
  swapPreviewKeepCount,
  swapPreviewOutputs,
} from "../swap-preview";

jest.setTimeout(60_000);

const KEYSET_ID = "00689535d0769db7";

function fakePreview(): SwapPreview {
  return {
    amount: Amount.from(8),
    fees: Amount.from(0),
    keysetId: KEYSET_ID,
    inputs: normalizeProofAmounts([
      {
        id: KEYSET_ID,
        amount: 8,
        C: "02".padEnd(66, "a"),
        secret: "b".repeat(64),
      },
    ]),
    keepOutputs: [
      OutputData.createSingleRandomData(4, KEYSET_ID),
      OutputData.createSingleRandomData(4, KEYSET_ID),
    ],
  };
}

// A preview travels through the transaction record, so what is actually
// rebuilt is whatever survived MMKV's JSON, not the object handed to
// `serializeSwapPreview`.
function throughStorage(preview: SwapPreview): unknown {
  return JSON.parse(JSON.stringify(serializeSwapPreview(preview)));
}

describe("swap preview round trip", () => {
  it("rebuilds every field completeSwap reads", () => {
    const original = fakePreview();
    const rebuilt = rebuildSwapPreview(throughStorage(original));

    expect(rebuilt).not.toBeNull();
    if (rebuilt === null) return;
    expect(rebuilt.keysetId).toBe(original.keysetId);
    expect(rebuilt.inputs.map((p) => p.secret)).toEqual(
      original.inputs.map((p) => p.secret),
    );
    expect(rebuilt.inputs.map((p) => p.amount.toNumber())).toEqual([8]);
    // The blinding factor is the whole point: without it the mint's signatures
    // cannot be unblinded and the outputs are just numbers.
    expect(swapPreviewOutputs(rebuilt).map((o) => o.blindingFactor)).toEqual(
      swapPreviewOutputs(original).map((o) => o.blindingFactor),
    );
    expect(swapPreviewOutputs(rebuilt).map((o) => o.blindedMessage.B_)).toEqual(
      swapPreviewOutputs(original).map((o) => o.blindedMessage.B_),
    );
    expect(swapPreviewKeepCount(rebuilt)).toBe(2);
  });

  it("keeps the send outputs distinguishable from the keeps", () => {
    const original = fakePreview();
    original.sendOutputs = [OutputData.createSingleRandomData(2, KEYSET_ID)];
    const rebuilt = rebuildSwapPreview(throughStorage(original));

    expect(rebuilt).not.toBeNull();
    if (rebuilt === null) return;
    // `swapPreviewOutputs` lays keeps out first, which is what lets a recovery
    // tell our own change apart from proofs locked to somebody else.
    expect(swapPreviewKeepCount(rebuilt)).toBe(2);
    expect(swapPreviewOutputs(rebuilt)).toHaveLength(3);
    expect(swapPreviewOutputs(rebuilt)[2]?.blindedMessage.B_).toBe(
      original.sendOutputs[0]?.blindedMessage.B_,
    );
  });

  it("preserves the field order of an input, not merely its values", () => {
    // The order cashu-ts happens to use is not the order anybody would write
    // out by hand, which is the point: rebuilding these field by field would
    // pass every value assertion above and still miss the mint's cache.
    const odd = normalizeProofAmounts([
      {
        id: KEYSET_ID,
        amount: 8,
        C: "02".padEnd(66, "a"),
        secret: "b".repeat(64),
      },
    ]);
    const rebuilt = rebuildSwapPreview(
      throughStorage({ ...fakePreview(), inputs: odd }),
    );

    expect(rebuilt).not.toBeNull();
    if (rebuilt === null) return;
    expect(Object.keys(rebuilt.inputs[0] ?? {})).toEqual(
      Object.keys(odd[0] ?? {}),
    );
  });

  it("refuses a record it cannot faithfully rebuild", () => {
    const stored = throughStorage(fakePreview()) as Record<string, unknown>;

    expect(rebuildSwapPreview(undefined)).toBeNull();
    expect(rebuildSwapPreview("not a preview")).toBeNull();
    // A record written by a build that meant something else by these fields.
    expect(rebuildSwapPreview({ ...stored, v: 99 })).toBeNull();
    expect(rebuildSwapPreview({ ...stored, inputs: [] })).toBeNull();
    expect(
      rebuildSwapPreview({
        ...stored,
        keepOutputs: [],
        sendOutputs: undefined,
      }),
    ).toBeNull();
    // A blinding factor that is not a canonical scalar. cashu-ts throws rather
    // than clamping, and a half-built preview must never reach the mint.
    expect(
      rebuildSwapPreview({
        ...stored,
        keepOutputs: [
          {
            blindedMessage: {
              amount: "4",
              B_: "02".padEnd(66, "a"),
              id: KEYSET_ID,
            },
            blindingFactor: "not-a-number",
            secret: "aa",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("replaying a stored preview", () => {
  it("sends the mint a byte-identical /v1/swap request", async () => {
    const world = new World({ seed: 1 });
    const fabric = new MintFabric(world);
    fabric.setConditions({ latencyMs: 0 });
    fabric.install();

    const bodies: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      if (String(input).includes("/v1/swap")) {
        bodies.push(String((init as { body?: unknown } | undefined)?.body));
      }
      return (inner as typeof globalThis.fetch)(
        input as RequestInfo,
        init as RequestInit,
      );
    }) as typeof globalThis.fetch;

    try {
      const wallet = new Wallet(new Mint(fabric.url), {
        unit: "sat",
        bip39seed: new Uint8Array(64).fill(7),
        secretsPolicy: "deterministic",
      });
      await wallet.loadMint(true);
      const quote = await wallet.createMintQuoteBolt11(64);
      const proofs = await wallet.mintProofsBolt11(64, quote);

      const preview = await wallet.prepareSwapToReceive(proofs);
      const rebuilt = rebuildSwapPreview(throughStorage(preview));
      expect(rebuilt).not.toBeNull();
      if (rebuilt === null) return;

      const first = await wallet.completeSwap(preview);
      expect(first.keep.length).toBeGreaterThan(0);

      // The mint caches by request, so an identical replay is answered from the
      // cache rather than treated as a second spend. That the outputs come back
      // the same is the recovery working; that the BODY is the same is why it
      // could.
      const replayed = await wallet.completeSwap(rebuilt);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(replayed.keep.map((p) => p.secret)).toEqual(
        first.keep.map((p) => p.secret),
      );
      expect(replayed.keep.map((p) => p.C)).toEqual(first.keep.map((p) => p.C));
    } finally {
      globalThis.fetch = inner;
      world.close();
    }
  });
});
