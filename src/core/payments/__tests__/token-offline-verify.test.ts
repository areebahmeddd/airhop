/**
 * @jest-environment node
 */
// `verifyTokenOffline`: the only check between a forged token and the balance
// when no mint is reachable. A NUT-12 DLEQ witness proves the mint signed a
// proof, using its public keys alone.
//
// "invalid" (provably forged) is refused outright. "unchecked" (cannot tell)
// is stored unverified and redeemed at the first chance. "valid" is the one
// offline claim the app makes to a person, so it requires every coin to be
// witnessed and to verify: one genuine coin must not vouch for the rest.

import {
  blindMessage,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  KeyChain,
  unblindSignature,
  type KeyChainCache,
  type MintKeys,
  type MintKeyset,
  type Proof,
  type Token,
} from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyTokenOffline, type DleqResult } from "../cashu";

const MINT = "https://mint.example.com";
const UNIT = "sat";
const DENOMINATIONS = [1, 2, 4, 8, 16, 32];

// Deterministic per denomination, so a failure is reproducible.
function mintKey(amount: number): Uint8Array {
  const priv = new Uint8Array(32).fill(0);
  priv[31] = amount;
  return priv;
}

// A keyset with real secp256k1 public keys. They are real because
// `deriveKeysetId` hashes them and `hasValidDleq` does curve arithmetic with
// them: made-up hex would fail for the wrong reason and prove nothing.
function buildCache(opts: { inactive?: MintKeyset } = {}): {
  cache: KeyChainCache;
  keysetId: string;
} {
  const publicKeys: Record<string, string> = {};
  for (const amount of DENOMINATIONS) {
    publicKeys[String(amount)] = bytesToHex(
      secp256k1.getPublicKey(mintKey(amount), true),
    );
  }
  const keysetId = deriveKeysetId(publicKeys, { versionByte: 0 });
  const keysets: MintKeyset[] = [
    { id: keysetId, unit: UNIT, active: true, input_fee_ppk: 0 },
    ...(opts.inactive !== undefined ? [opts.inactive] : []),
  ];
  const keys: MintKeys[] = [{ id: keysetId, unit: UNIT, keys: publicKeys }];
  return { cache: KeyChain.mintToCacheDTO(MINT, keysets, keys), keysetId };
}

const { cache, keysetId } = buildCache();

// Built loosely and cast once: cashu-ts models an amount as a wrapper type, and
// the point here is the verifier's behaviour on hand-made proofs, not our
// ability to satisfy its constructors.
function proof(
  over: {
    id?: string;
    amount?: number;
    secret?: string;
    dleq?: { e: string; s: string; r: string };
  } = {},
): Proof {
  return {
    id: over.id ?? keysetId,
    amount: over.amount ?? 8,
    secret: over.secret ?? "a".repeat(64),
    C: bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)),
    ...(over.dleq === undefined ? {} : { dleq: over.dleq }),
  } as unknown as Proof;
}

// A coin the mint really signed, witness and blinding factor included: the
// BDHKE a mint runs, with its own private key for the amount.
function signedProof(amount: number, secret: string): Proof {
  const priv = mintKey(amount);
  const { B_, r } = blindMessage(new TextEncoder().encode(secret));
  const { C_ } = createBlindSignature(B_, priv, keysetId);
  const dleq = createDLEQProof(B_, priv);
  const K = secp256k1.Point.fromHex(
    bytesToHex(secp256k1.getPublicKey(priv, true)),
  );
  return {
    id: keysetId,
    amount,
    secret,
    C: unblindSignature(C_, r, K).toHex(true),
    dleq: {
      e: bytesToHex(dleq.e),
      s: bytesToHex(dleq.s),
      r: r.toString(16).padStart(64, "0"),
    },
  } as unknown as Proof;
}

function token(proofs: Proof[]): Token {
  return { mint: MINT, unit: UNIT, proofs } as unknown as Token;
}

// A witness that is structurally a witness and cryptographically nonsense. This
// is what a forgery looks like: the attacker can put any bytes in the field,
// they just cannot make them verify.
const FORGED_DLEQ = {
  e: "11".repeat(32),
  s: "22".repeat(32),
  r: "33".repeat(32),
};

function verify(proofs: Proof[], using = cache): DleqResult {
  return verifyTokenOffline(token(proofs), using, UNIT);
}

describe("a token the mint signed throughout", () => {
  it("is genuine when every coin carries a witness that verifies", () => {
    expect(
      verify([signedProof(8, "real-one"), signedProof(2, "real-two")]),
    ).toEqual({ status: "valid" });
  });

  it("carries no English, only codes the screen turns into copy", () => {
    const results = [
      verify([signedProof(8, "real")]),
      verify([proof()]),
      verify([proof({ dleq: FORGED_DLEQ })]),
    ];
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(
        result.status === "valid" ? ["status"] : ["code", "status"],
      );
    }
  });
});

describe("a real coin cannot vouch for forged ones", () => {
  it("reads one witnessed coin beside bare ones as unchecked", () => {
    // The attack: one genuine 1 sat coin, any number of made-up coins with no
    // witness. The made-up amounts are real denominations, which costs nothing.
    const result = verify([
      signedProof(1, "genuine"),
      proof({ amount: 32, secret: "b".repeat(64) }),
      proof({ amount: 32, secret: "c".repeat(64) }),
    ]);
    expect(result).toEqual({ status: "unchecked", code: "partial-witness" });
  });

  it("reads a token with no witness at all as unchecked", () => {
    expect(verify([proof()])).toEqual({
      status: "unchecked",
      code: "no-witness",
    });
  });

  it("refuses the token when one bad witness sits among bare coins", () => {
    expect(
      verify([proof(), proof({ secret: "b".repeat(64), dleq: FORGED_DLEQ })]),
    ).toEqual({ status: "invalid", code: "bad-witness" });
  });
});

describe("when the check cannot reach a conclusion", () => {
  // Every one of these must be "unchecked" rather than "invalid", because a
  // legitimate offline transfer looks exactly like this. Treating it as forged
  // would break the feature the wallet exists for.
  it("reports unchecked when this device has never cached the mint's keys", () => {
    expect(
      verifyTokenOffline(token([signedProof(8, "real")]), undefined, UNIT),
    ).toEqual({
      status: "unchecked",
      code: "keys-missing",
    });
  });

  it("reports unchecked when the cached keys are unreadable", () => {
    // A corrupted or half-written cache must not be read as a forgery verdict.
    const corrupt = { keysets: [], mintUrl: MINT } as unknown as KeyChainCache;
    expect(verify([proof({ dleq: FORGED_DLEQ })], corrupt).status).toBe(
      "unchecked",
    );
  });

  it("skips a proof from a keyset the mint has since rotated away", () => {
    // We know the mint but not this keyset, so there is nothing to check. It
    // must not be called a forgery: rotation is normal mint behaviour.
    const rotated = proof({ id: "00" + "ff".repeat(7), dleq: FORGED_DLEQ });
    expect(verify([rotated])).toEqual({
      status: "unchecked",
      code: "keyset-unknown",
    });
  });

  it("reads a listed keyset whose keys are not cached as unchecked, not forged", () => {
    // NUT-01 serves keys for active keysets only, so after a rotation the old
    // keyset is listed with no keys. The mint still honours its coins.
    const inactiveId = "00" + "aa".repeat(7);
    const { cache: withInactive } = buildCache({
      inactive: { id: inactiveId, unit: UNIT, active: false },
    });
    expect(
      verify([proof({ id: inactiveId, dleq: FORGED_DLEQ })], withInactive),
    ).toEqual({ status: "unchecked", code: "keys-missing" });
  });
});

describe("when the token is provably forged", () => {
  it("refuses a witness that does not verify against the mint's keys", () => {
    // The case the function exists for: someone hands over a token in a dead
    // zone with a witness they made up.
    expect(verify([proof({ dleq: FORGED_DLEQ })])).toEqual({
      status: "invalid",
      code: "bad-witness",
    });
  });

  it("refuses a proof claiming a denomination the mint does not issue", () => {
    // Cashu amounts are powers of two and the mint holds one key per
    // denomination. A proof for 999 matches no key, witness or not.
    expect(verify([proof({ amount: 999 })])).toEqual({
      status: "invalid",
      code: "no-such-denomination",
    });
  });

  it("refuses a coin from a keyset in another unit", () => {
    const usdId = "00" + "bb".repeat(7);
    const { cache: mixed } = buildCache({
      inactive: { id: usdId, unit: "usd", active: true },
    });
    expect(verify([proof({ id: usdId })], mixed)).toEqual({
      status: "invalid",
      code: "wrong-unit",
    });
  });
});
