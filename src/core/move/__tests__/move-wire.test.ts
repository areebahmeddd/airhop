/**
 * @jest-environment node
 */
import {
  canReadVersion,
  decodeMoveMessage,
  encodeAbort,
  encodeChunk,
  encodeCommit,
  encodeConfirm,
  encodeEnd,
  encodeOffer,
  encodeOfferBody,
  encodeReleased,
  MAX_MOVE_BYTES,
  MOVE_FORMAT,
  MoveAbortReason,
  type MoveOffer,
} from "../move-wire";

const HASH = "a".repeat(64);

function offer(overrides: Partial<MoveOffer> = {}): MoveOffer {
  return {
    format: MOVE_FORMAT,
    appVersion: "1.0.8",
    history: true,
    // Keychain item names are camelCase, so the name pattern must allow it.
    sections: [
      { name: "secret:identity", size: 10, sha256: HASH },
      { name: "secret:walletRecoveryPhrase", size: 12, sha256: HASH },
    ],
    ...overrides,
  };
}

describe("move wire", () => {
  it("round-trips every message", () => {
    const body = encodeOfferBody(offer());
    const decodedOffer = decodeMoveMessage(encodeOffer(body));
    expect(decodedOffer).toEqual({ type: "offer", offer: offer(), raw: body });

    expect(decodeMoveMessage(encodeChunk(Uint8Array.of(1, 2, 3)))).toEqual({
      type: "chunk",
      data: Uint8Array.of(1, 2, 3),
    });
    expect(decodeMoveMessage(encodeEnd())).toEqual({ type: "end" });
    const digest = new Uint8Array(32).fill(4);
    expect(decodeMoveMessage(encodeCommit(digest))).toEqual({
      type: "commit",
      digest,
    });
    expect(decodeMoveMessage(encodeReleased(false))).toEqual({
      type: "released",
      keysDestroyed: false,
    });
    expect(decodeMoveMessage(encodeAbort(MoveAbortReason.STORAGE))).toEqual({
      type: "abort",
      reason: MoveAbortReason.STORAGE,
    });
  });

  it("carries CONFIRM as a bare 0x07 and nothing else", () => {
    expect(encodeConfirm()).toEqual(Uint8Array.of(0x07));
    expect(decodeMoveMessage(encodeConfirm())).toEqual({ type: "confirm" });
    expect(decodeMoveMessage(Uint8Array.of(0x07, 0))).toBeNull();
  });

  it("refuses an offer it cannot trust", () => {
    const bad = (o: unknown): unknown =>
      decodeMoveMessage(
        encodeOffer(new TextEncoder().encode(JSON.stringify(o))),
      );
    expect(bad({ ...offer(), format: 2 })).toBeNull();
    expect(bad({ ...offer(), appVersion: "latest" })).toBeNull();
    expect(
      bad(
        offer({
          sections: [
            { name: "a", size: 1, sha256: HASH },
            { name: "a", size: 1, sha256: HASH },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      bad(offer({ sections: [{ name: "A B", size: 1, sha256: HASH }] })),
    ).toBeNull();
    expect(
      bad(offer({ sections: [{ name: "a", size: -1, sha256: HASH }] })),
    ).toBeNull();
    expect(
      bad(
        offer({
          sections: [{ name: "a", size: MAX_MOVE_BYTES + 1, sha256: HASH }],
        }),
      ),
    ).toBeNull();
  });

  it("drops malformed frames", () => {
    expect(decodeMoveMessage(new Uint8Array(0))).toBeNull();
    expect(decodeMoveMessage(Uint8Array.of(0x7f))).toBeNull();
    expect(decodeMoveMessage(Uint8Array.of(0x02))).toBeNull();
    expect(decodeMoveMessage(Uint8Array.of(0x04, 1, 2))).toBeNull();
    expect(decodeMoveMessage(Uint8Array.of(0x05, 2))).toBeNull();
    expect(decodeMoveMessage(Uint8Array.of(0x06, 0x09))).toBeNull();
  });

  it("reads data from the same or an older build, never a newer one", () => {
    expect(canReadVersion("1.0.8", "1.0.8")).toBe(true);
    expect(canReadVersion("1.1.0", "1.0.9")).toBe(true);
    expect(canReadVersion("1.0.8", "1.0.9")).toBe(false);
    expect(canReadVersion("1.9.0", "2.0.0")).toBe(false);
  });
});
