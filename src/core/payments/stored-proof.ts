// A proof as the wallet keeps it: Cashu's fields as plain JSON, plus what the
// wallet knows about where it came from.

export interface SerializedDleq {
  e: string;
  s: string;
  r?: string;
}

// `amount` is a plain number in the account's unit (`Amount` is not JSON).
export interface StoredProof {
  id: string; // Keyset ID
  amount: number;
  secret: string;
  C: string; // Unblinded signature from the mint
  dleq?: SerializedDleq; // NUT-12 discrete-log-equality witness, when present
  witness?: string; // NUT-11 P2PK / NUT-14 HTLC witness, when present
  // True only for outputs the mint signed for us (a swap, mint or melt): the
  // sender holds no copy. A state check is not enough; NUT-07 calls a coin it
  // has never seen unspent.
  verified?: boolean;
  // Secret derived from the recovery phrase, so restorable. Received proofs
  // carry the sender's secrets until swapped.
  derived?: boolean;
  receivedAtMs?: number;
  // Unverified only: the transaction that brought the coin in (an offline
  // receive, or a reclaimed send). A refresh swaps each receipt on its own,
  // so a mint refusing one token's coins cannot block the others.
  receiptTxId?: string;
}
