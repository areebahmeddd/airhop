// Wallet recovery phrase: 12 BIP-39 words that can rebuild the ecash balance.
// A proof is a secret plus the mint's signature; a random secret exists only on
// this phone, so losing the phone loses the money even though the mint still
// holds it. Derived secrets (NUT-13) come from one seed in a fixed counter
// order, so a restore re-derives #0, #1, #2... and asks the mint which it
// signed (NUT-09), and the balance reassembles from the mint's own records.
//
// It restores money only. Not the Airhop identity (a separate key), not chat,
// contacts or memos, not the mint list (recovery asks a specific mint, so the
// list is shown with the words and kept with them), and not coins received
// but never swapped, which carry the sender's secrets until swapped. The phrase
// is the money: keychain only, never in the proof store, sent or logged.

import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "../crypto/keychain";

const PHRASE_ITEM = KEYCHAIN_ITEMS.walletRecoveryPhrase;

// 128 bits is 12 words: guessing is hopeless, short enough that people write
// it down, and the length every other wallet uses.
const ENTROPY_BITS = 128;

export const RECOVERY_WORD_COUNT = 12;

export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

// Accepts whatever shape a paste from notes, photos or a password manager
// arrives in: case, runs of whitespace and newlines, stray punctuation.
export function normalizeRecoveryPhrase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
}

// Checks the BIP-39 checksum, so a one-word typo fails here rather than
// silently restoring an empty wallet.
export function isValidRecoveryPhrase(raw: string): boolean {
  const phrase = normalizeRecoveryPhrase(raw);
  if (phrase.split(" ").length !== RECOVERY_WORD_COUNT) return false;
  try {
    return validateMnemonic(phrase, wordlist);
  } catch {
    return false;
  }
}

// Words not in the BIP-39 list, so the UI can point at the typo.
export function unknownWordsIn(raw: string): string[] {
  const known = new Set(wordlist);
  return normalizeRecoveryPhrase(raw)
    .split(" ")
    .filter((word) => word.length > 0 && !known.has(word));
}

// The 64-byte seed cashu-ts derives from. Throws on an invalid phrase: a seed
// from garbage yields secrets no mint ever signed, and a restore that silently
// finds nothing.
export function recoveryPhraseToSeed(raw: string): Uint8Array {
  const phrase = normalizeRecoveryPhrase(raw);
  if (!isValidRecoveryPhrase(phrase)) {
    throw new Error("invalid recovery phrase");
  }
  return mnemonicToSeedSync(phrase);
}

export async function loadStoredPhrase(): Promise<string | null> {
  try {
    const stored = await readSecret(PHRASE_ITEM);
    if (typeof stored !== "string" || stored.length === 0) return null;
    return isValidRecoveryPhrase(stored)
      ? normalizeRecoveryPhrase(stored)
      : null;
  } catch {
    // Keychain unavailable: fall back to random secrets rather than fail.
    return null;
  }
}

export async function storePhrase(raw: string): Promise<void> {
  const phrase = normalizeRecoveryPhrase(raw);
  if (!isValidRecoveryPhrase(phrase)) {
    throw new Error("refusing to store an invalid recovery phrase");
  }
  await writeSecret(PHRASE_ITEM, phrase);
}

// Deliberately no "forget phrase": deleting it deletes the coins derived from
// it. Only the panic wipe, which destroys every keychain item at once, removes
// it.

// Distinct 1-based word positions to quiz, random per setup so a screenshot
// of one quiz does not pass the next.
export function pickVerificationPositions(count = 2): number[] {
  // Rejection sampling: 256 is not a multiple of 12, so a plain `% 12` biases
  // the first four positions.
  const unbiasedLimit = 256 - (256 % RECOVERY_WORD_COUNT);
  const positions = new Set<number>();
  while (positions.size < Math.min(count, RECOVERY_WORD_COUNT)) {
    const bytes = crypto.getRandomValues(new Uint8Array(1));
    if (bytes[0] >= unbiasedLimit) continue;
    positions.add((bytes[0] % RECOVERY_WORD_COUNT) + 1);
  }
  return [...positions].sort((a, b) => a - b);
}

export function verifyPositions(
  phrase: string,
  answers: Record<number, string>,
): boolean {
  const words = normalizeRecoveryPhrase(phrase).split(" ");
  return Object.entries(answers).every(([position, answer]) => {
    const index = Number.parseInt(position, 10) - 1;
    if (index < 0 || index >= words.length) return false;
    return words[index] === normalizeRecoveryPhrase(answer);
  });
}
