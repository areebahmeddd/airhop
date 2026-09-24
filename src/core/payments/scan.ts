// What a scanned QR code is allowed to mean: the kind the sheet asked for,
// normalised to the bare form the wallet expects. Kept apart from the scanner
// component because the acceptance rule, not the camera, is what can fail in a
// way a user notices: a scan that silently does nothing, or the wrong kind of
// string reaching a money path.

import { bareToken } from "./cashu";

// "any" is the wallet's own Scan button, which routes by what it sees.
export type ScanTarget = "token" | "invoice" | "any";

export type ScanKind = "token" | "invoice" | "npub";

// The normalised value, or null to keep the camera open and keep looking.
export function readScan(
  raw: string | undefined,
  target: ScanTarget,
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // `bareToken` also strips a `cashu:` scheme, so a QR from a wallet that
  // adds one still reads.
  if (target === "token") return bareToken(raw);
  if (target === "invoice") return bareInvoice(raw);
  return classifyScan(raw)?.value ?? null;
}

// For the Scan button. Null for anything the wallet cannot act on. Order is
// safe because the shapes are disjoint (`cashu`, `ln`, `npub1` prefixes).
export function classifyScan(
  raw: string,
): { kind: ScanKind; value: string } | null {
  const token = bareToken(raw);
  if (token !== null) return { kind: "token", value: token };
  const invoice = bareInvoice(raw);
  if (invoice !== null) return { kind: "invoice", value: invoice };
  const npub = bareNpub(raw);
  if (npub !== null) return { kind: "npub", value: npub };
  return null;
}

// With or without the NIP-21 `nostr:` scheme. Shape only; the zap sheet
// decodes it.
function bareNpub(raw: string): string | null {
  const trimmed = raw.trim().replace(/^nostr:/i, "");
  return /^npub1[02-9ac-hj-np-z]{58}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
}

// bolt11 is bech32, so wallets encode it in either case, often behind a
// `lightning:` scheme; normalised to the lowercase bare form the mint expects.
// Only the network prefix is checked (`lnbc` mainnet, `lntb`/`lntbs` testnet,
// `lnbcrt` regtest), all four accepted: the mint validates the invoice properly,
// and a stricter local check would only reject invoices that are fine.
export function bareInvoice(raw: string): string | null {
  const trimmed = raw.trim().replace(/^lightning:/i, "");
  return /^ln(bc|tb|bcrt|tbs)[0-9]/i.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
}
