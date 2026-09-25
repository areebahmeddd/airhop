// Cashu ecash, pure and offline: token detection, decoding, DLEQ verification,
// proof selection and encoding. Anything that talks to a mint lives in
// wallet-service. Formats (NUT-00): cashuA (V3 JSON), cashuB (V4 CBOR, what we
// emit), and the `cashu:` / `cashu://` URI forms.
//
// Detection matches bitchat's `MessageFormattingEngine.Patterns.cashu` exactly,
// down to the character class and the 40-character minimum body, so a string is
// a payment chip on both apps or on neither. Being more permissive would show a
// card where bitchat shows raw text.
//
// Offline DLEQ (NUT-12) proves the mint signed a proof, so it catches forged and
// tampered tokens, never that it is unspent: only the mint knows that. Offline
// proofs are stored unverified and redeemed at the first opportunity.

import {
  getDecodedToken,
  getEncodedToken,
  getSecretKind,
  getTokenMetadata,
  hasCorrespondingKey,
  hasValidDleq,
  isP2PKSpendAuthorised,
  KeyChain,
  signP2PKProofs,
  type KeyChainCache,
  type Proof,
  type ProofLike,
  type Token,
} from "@cashu/cashu-ts";
import type { StoredProof } from "@store/wallet-store";

// ---- Constants ----

// Real tokens are a few KiB.
const MAX_TOKEN_LENGTH = 60_000;

// Guards CPU on hostile input.
const MAX_SCAN_LENGTH = MAX_TOKEN_LENGTH * 2;

// Matches bitchat's cap.
const MAX_TOKENS_PER_MESSAGE = 3;

// More sats than will ever exist: above it, a token is malformed or hostile.
const MAX_AMOUNT = 2_100_000_000_000_000;

const TOKEN_HINTS = ["cashuA", "cashuB", "cashu:"];

// Byte-for-byte bitchat's. URI forms match from the embedded `cashuA`/`cashuB`.
const TOKEN_PATTERN = /\bcashu[AB][A-Za-z0-9._-]{40,}\b/g;

// ---- Types ----

export interface TokenInfo {
  version: "A" | "B";
  amount: number;
  // "sat" when the token does not declare one (NUT-00 default).
  unit: string;
  mintUrl: string;
  mintHost: string;
  memo?: string;
  proofCount: number;
  // Every proof carries a NUT-12 DLEQ witness; else trust only after a swap.
  hasDleq: boolean;
  token: Token;
}

export interface EmbeddedToken {
  info: TokenInfo;
  raw: string;
  offset: number;
}

// Codes, never copy: the caller picks the sentence.
export type DleqResult =
  // Every proof carries a witness and every witness verifies: the mint signed
  // all of it. Says nothing about whether it is spent.
  | { status: "valid" }
  // Forged or corrupted: refuse it.
  //   bad-witness            a witness that does not verify
  //   no-such-denomination   an amount the keyset has no key for
  //   wrong-unit             a keyset outside the token's unit
  | {
      status: "invalid";
      code: "bad-witness" | "no-such-denomination" | "wrong-unit";
    }
  // Not every proof could be checked. No offline assurance, not a failure.
  //   no-witness       no proof carries one
  //   partial-witness  some do, so the rest could be anything
  //   keys-missing     the keyset is known but its keys are not cached (a
  //                    rotated keyset, or no cache at all)
  //   keyset-unknown   the keyset is not in the cache
  | {
      status: "unchecked";
      code:
        "no-witness" | "partial-witness" | "keys-missing" | "keyset-unknown";
    };

// ---- Detection ----

// Cheap enough to call per message render before the full scan.
export function mayContainToken(text: string): boolean {
  return TOKEN_HINTS.some((hint) => text.includes(hint));
}

// Safe on hostile text: bounded scan window, at most MAX_TOKENS_PER_MESSAGE
// matches, and a decode failure drops the candidate rather than throwing.
// Deduplicated by bare string, so `cashu:cashuA...` beside the same `cashuA...`
// yields one card.
export function findTokensInText(
  text: string,
  keysets: readonly KeysetRef[] = [],
): EmbeddedToken[] {
  const results: EmbeddedToken[] = [];
  for (const { raw, offset } of tokenCandidates(text)) {
    const info = decodeToken(raw, keysets);
    if (!info) continue;
    results.push({ info, raw, offset });
    if (results.length >= MAX_TOKENS_PER_MESSAGE) break;
  }
  return results;
}

// Mints named by tokens in `text` whose keyset ids `keysets` cannot expand: a
// v2 short id expands only against the mint's current list, so a token under a
// keyset not fetched yet (after a rotation) reads only as metadata.
export function mintsOfUnresolvedTokens(
  text: string,
  keysets: readonly KeysetRef[] = [],
): { mintUrl: string; unit: string }[] {
  const out: { mintUrl: string; unit: string }[] = [];
  for (const { raw } of tokenCandidates(text)) {
    const read = readToken(raw, keysets);
    if (read.ok || read.reason !== "unresolved") continue;
    const { mintUrl, label: unit } = read;
    if (!out.some((m) => m.mintUrl === mintUrl && m.unit === unit)) {
      out.push({ mintUrl, unit });
    }
    if (out.length >= MAX_TOKENS_PER_MESSAGE) break;
  }
  return out;
}

// Distinct token-shaped strings in `text`, bounded in scan window and length.
function* tokenCandidates(
  text: string,
): Generator<{ raw: string; offset: number }> {
  if (!mayContainToken(text)) return;
  const scanned =
    text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  const seen = new Set<string>();
  // A fresh instance: exec mutates `lastIndex` on the shared /g literal.
  const pattern = new RegExp(TOKEN_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scanned)) !== null) {
    const raw = match[0];
    if (raw.length > MAX_TOKEN_LENGTH || seen.has(raw)) continue;
    seen.add(raw);
    yield { raw, offset: match.index };
  }
}

// Strips a URI wrapper and percent-encoding. Null when not token-shaped.
export function bareToken(raw: string): string | null {
  let token = raw.trim();
  const lower = token.toLowerCase();
  if (lower.startsWith("cashu://")) token = token.slice(8);
  else if (lower.startsWith("cashu:")) token = token.slice(6);

  if (token.includes("%")) {
    try {
      token = decodeURIComponent(token);
    } catch {
      // Malformed: the shape check below rejects it.
    }
  }

  if (token.length < 12 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!token.startsWith("cashuA") && !token.startsWith("cashuB")) return null;
  // The detection charset plus standard base64, which older wallets emit in
  // pasted tokens.
  if (!/^[A-Za-z0-9._\-+/=]+$/.test(token.slice(6))) return null;
  return token;
}

// ---- Decode ----

// A cached keyset, with the unit the mint issued it in.
export interface KeysetRef {
  id: string;
  unit: string;
}

export type TokenRead =
  | { ok: true; info: TokenInfo }
  | { ok: false; reason: "malformed" }
  // A v2 short keyset id that none of `keysets` expands: a rotation not
  // fetched yet, or a mint this wallet does not hold. Only metadata reads.
  | { ok: false; reason: "unresolved"; mintUrl: string; label: string }
  // NUT-00: the unit names the currency of the token's keysets and is for
  // display only. A label its own keysets contradict is malformed; trusting it
  // would show and file sats as dollars.
  | {
      ok: false;
      reason: "unit-mismatch";
      mintUrl: string;
      label: string;
      actual: string;
    };

const MALFORMED: TokenRead = { ok: false, reason: "malformed" };

// Null unless it cleanly parses with a positive amount. No permissive mode
// (bitchat shows a generic chip for V4 it cannot walk): a full CBOR decoder
// failing means the token is malformed; an unpriced card is worse than text.
export function decodeToken(
  raw: string,
  keysets: readonly KeysetRef[] = [],
): TokenInfo | null {
  const read = readToken(raw, keysets);
  return read.ok ? read.info : null;
}

// `decodeToken`, saying why a token is refused, so a receive can tell the
// user what a chat card shows only as plain text.
export function readToken(
  raw: string,
  keysets: readonly KeysetRef[] = [],
): TokenRead {
  const tokenStr = bareToken(raw);
  if (!tokenStr) return MALFORMED;

  let token: Token;
  try {
    // `keysets` resolves a V4 token's short ids. Passing none is not neutral:
    // `mapShortKeysetIds` throws on any v2 short id ("01..."), so a good token
    // reads as unreadable. NUT-00 requires the throw (an unresolved id can be
    // neither verified nor fee-priced), so never swallow it: callers pass the
    // keysets of every mint the wallet knows.
    token = getDecodedToken(
      tokenStr,
      keysets.map((k) => k.id),
    );
  } catch {
    // Metadata needs no keyset data, so it answers exactly when an
    // unresolved short id stopped the decode.
    try {
      const meta = getTokenMetadata(tokenStr);
      return {
        ok: false,
        reason: "unresolved",
        mintUrl: meta.mint,
        label: sanitizeUnit(meta.unit),
      };
    } catch {
      return MALFORMED;
    }
  }

  if (!Array.isArray(token.proofs) || token.proofs.length === 0) {
    return MALFORMED;
  }
  let amount = 0;
  for (const proof of token.proofs) {
    const value = proof.amount.toNumber();
    if (!Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) {
      return MALFORMED;
    }
    amount += value;
    if (amount > MAX_AMOUNT) return MALFORMED;
  }

  const mintUrl = typeof token.mint === "string" ? token.mint : "";
  if (mintUrl.length === 0 || mintUrl.length > 512) return MALFORMED;

  // Every proof whose keyset is known, so mixed units are caught too. An
  // unknown keyset (a v1 id from a rotation not fetched) leaves the label
  // standing: the mint refuses a wrong one at swap time.
  const label = sanitizeUnit(token.unit);
  const unitOf = new Map(keysets.map((k) => [k.id, k.unit.toLowerCase()]));
  for (const proof of token.proofs) {
    const actual = unitOf.get(proof.id);
    if (actual !== undefined && actual !== label) {
      return { ok: false, reason: "unit-mismatch", mintUrl, label, actual };
    }
  }

  return {
    ok: true,
    info: {
      version: tokenStr.startsWith("cashuA") ? "A" : "B",
      amount,
      unit: label,
      mintUrl,
      mintHost: mintHostOf(mintUrl),
      memo: sanitizeMemo(token.memo),
      proofCount: token.proofs.length,
      hasDleq: token.proofs.every((p) => p.dleq !== undefined),
      token,
    },
  };
}

// Attacker-controlled, so capped and lowercased; a non-URL mint falls back to
// a truncated raw string.
function mintHostOf(mintUrl: string): string {
  try {
    return new URL(mintUrl).hostname.toLowerCase().slice(0, 48);
  } catch {
    return mintUrl.slice(0, 48);
  }
}

// Alphanumeric codes only, never attacker-chosen text next to an amount.
function sanitizeUnit(unit: string | undefined): string {
  if (typeof unit !== "string") return "sat";
  if (unit.length === 0 || unit.length > 12) return "sat";
  if (!/^[a-zA-Z0-9]+$/.test(unit)) return "sat";
  return unit.toLowerCase();
}

// Shown verbatim in the card, so strip control characters and newlines (which
// would let a sender fake extra UI lines) and cap the length.
function sanitizeMemo(memo: string | undefined): string | undefined {
  if (typeof memo !== "string" || memo.length > 512) return undefined;
  const cleaned = memo.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : undefined;
}

// ---- Offline DLEQ verification ----

// NUT-12 against the mint's cached public keys (`keyChain.cache`, public only,
// so safe unencrypted and offline). "valid" means what CDK's
// `verify_token_dleq` means: every proof verified. One real coin cannot vouch
// for the others, or a single witnessed sat makes any forgery beside it read
// as genuine.
//
// One pass over every proof. Anything provably wrong refuses the token at
// once, whatever else is missing. What could not be checked is tallied, and
// the witness codes win over the key codes, since they are what the sender
// chose.
export function verifyTokenOffline(
  token: Token,
  keysetCache: KeyChainCache | undefined,
  unit: string,
): DleqResult {
  let keyChain: KeyChain | null = null;
  if (keysetCache !== undefined) {
    try {
      keyChain = KeyChain.fromCache(token.mint, unit, keysetCache);
    } catch {
      // Unreadable cache: nothing to check against.
    }
  }

  let witnessed = 0;
  let verified = 0;
  let keysMissing = false;
  for (const proof of token.proofs) {
    if (proof.dleq !== undefined) witnessed += 1;
    if (keyChain === null) {
      keysMissing = true;
      continue;
    }
    // Rotated away, or an unresolved short id.
    if (!keyChain.hasKeyset(proof.id)) continue;
    if (!keyChain.isUnitKeyset(proof.id)) {
      return { status: "invalid", code: "wrong-unit" };
    }
    const keyset = keyChain.getKeyset(proof.id);
    // An inactive keyset is listed without keys (NUT-01 serves only active
    // ones); the mint still honours it, so this is no evidence of forgery.
    if (!keyset.hasKeys) {
      keysMissing = true;
      continue;
    }
    // A throw on hostile input is a refusal: a check that passes whatever
    // it cannot evaluate can only ever say yes.
    try {
      if (!hasCorrespondingKey(proof.amount, keyset.keys)) {
        return { status: "invalid", code: "no-such-denomination" };
      }
      if (proof.dleq === undefined) continue;
      if (!hasValidDleq(proof, keyset)) {
        return { status: "invalid", code: "bad-witness" };
      }
    } catch {
      return { status: "invalid", code: "bad-witness" };
    }
    verified += 1;
  }

  if (token.proofs.length > 0 && verified === token.proofs.length) {
    return { status: "valid" };
  }
  if (witnessed === 0) return { status: "unchecked", code: "no-witness" };
  if (witnessed < token.proofs.length) {
    return { status: "unchecked", code: "partial-witness" };
  }
  return {
    status: "unchecked",
    code: keysMissing ? "keys-missing" : "keyset-unknown",
  };
}

// ---- Spending conditions (NUT-10, NUT-11) ----

// Who can spend a coin now:
//   "none"   a bearer coin: a plain secret, or a lock that no longer binds
//            (expired with no refund keys, or already carrying its signature).
//   "ours"   locked, and our key's signature is what unlocks it.
//   "other"  locked to anyone else, or to a condition we cannot meet (HTLC,
//            SIG_ALL, a malformed lock). Never money to this wallet.
export type CoinLock = "none" | "ours" | "other";

// Decided by cashu-ts itself, the same NUT-11 logic that signs our inputs, so
// its rules hold here unchanged: a NUT-28 blinded lock (`p2pk_e`) names a
// derived key a pubkey comparison would never match, and only signing tells.
// A secret that is not NUT-10 JSON is a plain secret to the mint too.
export function coinLock(proof: Proof, privkey?: string): CoinLock {
  let kind: string;
  try {
    kind = getSecretKind(proof.secret);
  } catch {
    return "none";
  }
  // HTLC needs a preimage this wallet never holds.
  if (kind !== "P2PK") return "other";
  try {
    if (isP2PKSpendAuthorised(proof)) return "none";
    if (privkey === undefined) return "other";
    const [signed] = signP2PKProofs([proof], privkey);
    return signed !== undefined && isP2PKSpendAuthorised(signed)
      ? "ours"
      : "other";
  } catch {
    return "other";
  }
}

// ---- Proof conversion ----

// `Amount` does not survive JSON, so it is flattened here. `verified` comes
// from the caller: only the mint can grant it.
export function toStoredProof(
  proof: Proof,
  opts?: { verified?: boolean; derived?: boolean; receivedAtMs?: number },
): StoredProof {
  return {
    id: proof.id,
    amount: proof.amount.toNumber(),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq
      ? { dleq: proof.dleq as unknown as StoredProof["dleq"] }
      : {}),
    ...(proof.witness !== undefined
      ? {
          witness:
            typeof proof.witness === "string"
              ? proof.witness
              : JSON.stringify(proof.witness),
        }
      : {}),
    verified: opts?.verified ?? false,
    derived: opts?.derived ?? false,
    receivedAtMs: opts?.receivedAtMs ?? Date.now(),
  };
}

export function toProofLike(proof: StoredProof): ProofLike {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq ? { dleq: proof.dleq as Proof["dleq"] } : {}),
    ...(proof.witness !== undefined
      ? { witness: proof.witness as Proof["witness"] }
      : {}),
  } as ProofLike;
}

// ---- Encode ----

// A `cashuB` string. No state change: the caller MUST reserve or remove the
// proofs before handing it out, or the value can be spent twice. DLEQ witnesses
// carry through, so the recipient can verify offline.
export function buildToken(
  mintUrl: string,
  proofs: StoredProof[],
  unit = "sat",
  memo?: string,
): string {
  const token = {
    mint: mintUrl,
    proofs: proofs.map(toProofLike),
    unit,
    ...(memo ? { memo } : {}),
  };
  return getEncodedToken(token as unknown as Token);
}

// ---- Fees ----

// NUT-02. The mint rounds up, so must we, or swaps underpay by one sat.
export function inputFeeFor(inputCount: number, feePpk: number): number {
  if (feePpk <= 0 || inputCount <= 0) return 0;
  return Math.ceil((inputCount * feePpk) / 1000);
}

// What the recipient pays to swap `proofs`: for an honest "they receive N",
// and for how much to over-send when the sender covers it.
export function feeForProofs(
  proofs: StoredProof[],
  feePpkByKeysetId: Record<string, number> | undefined,
): number {
  if (!feePpkByKeysetId) return 0;
  const ppk = proofs.reduce(
    (total, p) => total + (feePpkByKeysetId[p.id] ?? 0),
    0,
  );
  return ppk > 0 ? Math.ceil(ppk / 1000) : 0;
}

// ---- Offline proof selection ----

export interface ProofSelection {
  selected: StoredProof[];
  total: number;
  // What the recipient can claim after the input fee.
  receivable: number;
  fee: number;
  exact: boolean;
}

// Prefers an exact match on what the recipient receives. The fallback when
// the mint's keysets were never cached; otherwise cashu-ts `sendOffline` runs.
// A proof is taken only if it fits the remaining need, which finds the exact
// power-of-two subset when one exists. Pushing largest-first until the sum
// crosses the target overshoots badly: 10 from a single 64 spends all 64.
//
// `exact: false` means overpaying: offline there is no change, so the caller
// MUST get explicit consent before spending `total`.
export function selectProofsForAmount(
  proofs: StoredProof[],
  targetAmount: number,
  feePpkByKeysetId?: Record<string, number>,
): ProofSelection | null {
  if (targetAmount <= 0 || proofs.length === 0) return null;

  const describe = (selected: StoredProof[]): ProofSelection => {
    const total = selected.reduce((s, p) => s + p.amount, 0);
    const fee = feeForProofs(selected, feePpkByKeysetId);
    const receivable = total - fee;
    return {
      selected,
      total,
      receivable,
      fee,
      exact: receivable === targetAmount,
    };
  };

  // Unverified first, then largest: an unverified proof's double-spend risk
  // grows while held, so pass it on toward a mint sooner than we would reach
  // one (the recipient sees it as unverified). "They swap at once" does not
  // apply: this app is for recipients with no signal. Wrong for a melt, where
  // the mint checks every input and an unverified one only raises the failure
  // odds, so `payLightningInvoice` selects with cashu-ts instead.
  const ranked = [...proofs].sort(
    (a, b) =>
      Number(a.verified === true) - Number(b.verified === true) ||
      b.amount - a.amount,
  );

  // The fee grows with each pick, so the target moves as we select.
  const selected: StoredProof[] = [];
  let sum = 0;
  for (const proof of ranked) {
    const feeIfTaken = feeForProofs([...selected, proof], feePpkByKeysetId);
    const need = targetAmount + feeIfTaken;
    if (sum >= need) break;
    if (sum + proof.amount <= need) {
      selected.push(proof);
      sum += proof.amount;
    }
  }

  const exactAttempt = describe(selected);
  if (exactAttempt.exact) return exactAttempt;

  // No exact subset: the smallest selection covering target plus its own fee,
  // so the recipient is never short, flagged so the caller warns.
  const ascending = [...proofs].sort((a, b) => a.amount - b.amount);
  const covering: StoredProof[] = [];
  let coverSum = 0;
  for (const proof of ascending) {
    if (coverSum >= targetAmount + feeForProofs(covering, feePpkByKeysetId))
      break;
    covering.push(proof);
    coverSum += proof.amount;
  }
  if (coverSum - feeForProofs(covering, feePpkByKeysetId) < targetAmount) {
    return null;
  }

  // A later, larger pick can make an earlier small one redundant.
  for (let i = 0; i < covering.length; i++) {
    const trial = covering.filter((_, idx) => idx !== i);
    const trialSum = trial.reduce((s, p) => s + p.amount, 0);
    if (trialSum - feeForProofs(trial, feePpkByKeysetId) >= targetAmount) {
      covering.splice(i, 1);
      i--;
    }
  }

  return describe(covering);
}

// Test mints describe themselves as such, so no list to maintain; the hostname
// is a backstop. Only adds a warning label, so deliberately permissive: a false
// positive costs a badge, a false negative passes fake sats as real.
const TEST_MINT_WORDS =
  /\b(testnut|fakes?wallet|tests?mint|testing|testnet|regtest|signet)\b/i;

export function isLikelyTestMint(mint: {
  url: string;
  name?: string;
  description?: string;
}): boolean {
  if (TEST_MINT_WORDS.test(`${mint.name ?? ""} ${mint.description ?? ""}`)) {
    return true;
  }
  try {
    const host = new URL(mint.url).hostname.toLowerCase();
    return host.includes("testnut") || /(^|.)test./.test(host);
  } catch {
    return false;
  }
}

// ---- QR hand-off ----

// Size and capacity are one decision and move together. The limit is what one
// phone's camera reads off another's screen, not the format's capacity. Tokens
// are byte-mode (case-sensitive base64url, no upper-cased alphanumeric mode as
// bolt11 gets): 1159 bytes at EC level L is version 24 (113 modules), and
// 264 / 113 = 2.34 px per module, above the ~2 px floor. The format maximum
// (2953, version 40) would be 1.5 px: valid, unscannable. Level L because a
// bright screen needs little redundancy. A 10 sat token with DLEQ witnesses is
// already ~650 characters, so the ceiling is reached in ordinary use.
export const TOKEN_QR_SIZE = 264;
export const TOKEN_QR_MAX_CHARS = 1159;
export const TOKEN_QR_ERROR_CORRECTION = "L";

// Callers must check before rendering and offer copy instead: past the format
// limit the generator throws and takes the sheet down.
export function canEncodeTokenQr(token: string): boolean {
  return token.length > 0 && token.length <= TOKEN_QR_MAX_CHARS;
}

// Bare: every wallet reads the bare form, only some the `cashu:` URI, and the
// prefix spends capacity. Scanning still accepts a scheme (`bareToken`).
export function tokenQrPayload(token: string): string {
  return bareToken(token) ?? token;
}

// A denomination, not a currency: 1 BTC is exactly 100,000,000 sats, so this
// needs no price feed and cannot go stale.
export type BitcoinUnit = "sat" | "btc";

const SATS_PER_BTC_DIGITS = 8;

// Shifts the decimal point in the digits, which cannot round. Float division
// can round up, and a balance that rounds up lies.
export function satsToBtc(sats: number): string {
  const negative = sats < 0;
  const digits = String(Math.abs(Math.trunc(sats))).padStart(
    SATS_PER_BTC_DIGITS + 1,
    "0",
  );
  const whole = digits.slice(0, -SATS_PER_BTC_DIGITS);
  const fraction = digits.slice(-SATS_PER_BTC_DIGITS).replace(/0+$/, "");
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}
