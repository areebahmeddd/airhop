// Paying a person. Every screen that pays (DM attach menu, contact sheet, Mesh
// peer sheet, Wallet Zap) goes through `payPerson`, which owns the rail ladder,
// so none can disagree about what a payment does or whether it is reclaimable:
//   1. Radio, when a direct link exists. Someone in front of you should not
//      wait on a mint, and it works with no internet at all. Reclaimable.
//   2. Nutzap (NIP-61), when we know their Nostr key, they publish a kind
//      10019, and we hold value at a mint they accept. Locked to their key, so
//      the money is theirs whether or not they ever come online, and the only
//      rail that cannot be taken back.
//   3. A token over `sendDm` (gift-wrap, courier or outbox). Reclaimable.
//   4. A token the user hands over themselves. Reclaimable.
// Rails 3 and 4 reserve proofs rather than spending them, so a send that never
// lands can be pulled back. Every result says which rail carried it and whether
// it can be undone: "locked to them forever" and "queued, take it back" are one
// gesture to the user and very different facts about their money.

import { t, tPlural } from "@i18n";
import { showAlert, useAlertStore } from "@store/alert-store";
import { useChatStore, type ChatMessage } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { useOutboxStore } from "@store/outbox-store";
import { useWalletStore } from "@store/wallet-store";
import { amountParts } from "@utils/format";
import { systemRow } from "@utils/message-text";
import { resolveDisplayName } from "@utils/peer-display-name";
import { isNostrId, NOSTR_ID_PREFIX } from "@utils/username";
import { getMeshService, type MeshService } from "./mesh-service";
import {
  failNutzapDelivery,
  failSend,
  findNutzapTarget,
  lockProofsForNutzap,
  prepareSend,
  publishLockedNutzap,
  quoteSend,
  reclaimSend,
  settleNutzap,
  settleReclaim,
  staleFeeDays,
  WalletError,
  type NutzapTarget,
  type ReclaimOutcome,
} from "./wallet-service";

// How the DM actually left the device: "they have it" versus "queued, they
// might get it tomorrow", which the confirmation must not blur.
export type DeliveryRoute = ReturnType<MeshService["sendDm"]>;

export type PayRail =
  | "mesh"
  | "nutzap"
  // Locked proofs the relay would not take, delivered as a message instead.
  | "nutzap-dm"
  // Locked proofs nothing could carry: the returned token is the only copy.
  | "nutzap-undelivered"
  | "nostr"
  | "courier"
  // Nothing carried it: the user hands over the returned token, still reserved.
  | "queued";

export interface PayResult {
  rail: PayRail;
  amount: number;
  unit: string;
  mintUrl: string;
  txId: string;
  // Only when the user must deliver by hand.
  token?: string;
  // Only the nutzap rails: locked proofs are not ours to reclaim.
  final: boolean;
  // Why a better rail was not used. User-facing.
  fallbackReason?: string;
}

export interface PayPersonParams {
  // Mesh peer ID or `nostr_<pubkey>`. This or nostrPubkey is required.
  peerID?: string;
  // Hex x-only.
  nostrPubkey?: string;
  amount: number;
  memo?: string;
  unit?: string;
  // For the local echo; defaults to "You".
  senderNickname?: string;
  // Pass the name already on screen so the confirmation agrees with it.
  recipientName?: string;
}

// Null when the user cancelled or the wallet refused; errors are alerted here.
export async function payPerson(
  params: PayPersonParams,
): Promise<PayResult | null> {
  const amount = Math.floor(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = params.unit ?? "sat";

  const service = getMeshService();
  if (!service) {
    // No rail at all. Nothing has been deducted.
    showAlert(
      t("wallet.xfer.mesh_offline"),
      t("wallet.xfer.mesh_offline_body"),
    );
    return null;
  }

  const payee = resolvePayee(params, service);
  if (payee === null) return null;
  const name = params.recipientName ?? resolveDisplayName(payee.peerID);

  try {
    // Rail 1 beats a nutzap. They are right here: hand it over now rather than
    // spend a mint round trip on a fancier instrument, and keep the in-person
    // case working with no internet, the case the app exists for.
    const nearby = service.hasDirectLink(payee.peerID);

    if (!nearby && payee.nostrPubkey !== undefined) {
      const client = service.getNostrClient();
      const privKey = service.getNostrPrivKey();
      if (client) {
        // Rail 2. The lookup never throws for "not this rail", so a miss
        // falls through to the token rails with nothing spent.
        const lookup = await findNutzapTarget({
          recipientPubkey: payee.nostrPubkey,
          amount,
          unit,
          client,
        });
        if (lookup.ok) {
          // Asked once the rail is known, since only this rail is final and
          // the question must say so before anything is locked.
          const confirmed = await confirmPayment(amount, unit, name, true);
          if (!confirmed) return null;
          const paid = await payAsNutzap({
            target: lookup.target,
            recipientPubkey: payee.nostrPubkey,
            peerID: payee.peerID,
            amount,
            unit,
            comment: params.memo,
            senderNickname: params.senderNickname,
            client,
            privKey,
          });
          if (paid !== null) return paid;
          // The lock committed nothing; already confirmed, so do not ask twice.
          return await payAsToken({
            peerID: payee.peerID,
            amount,
            unit,
            memo: params.memo,
            senderNickname: params.senderNickname,
            fallbackReason: payee.fallbackReason,
            name,
            confirmed: true,
          });
        } else {
          // Shown in the confirmation as why this went as a token.
          payee.fallbackReason = lookup.reason;
        }
      } else {
        payee.fallbackReason = t("wallet.svc.no_relay");
      }
    }

    // Rails 3 and 4.
    return await payAsToken({
      peerID: payee.peerID,
      amount,
      unit,
      memo: params.memo,
      senderNickname: params.senderNickname,
      fallbackReason: payee.fallbackReason,
      name,
      confirmed: false,
    });
  } catch (err) {
    reportWalletError(err);
    return null;
  }
}

interface ResolvedPayee {
  // What the chat thread and `sendDm` are keyed by.
  peerID: string;
  nostrPubkey?: string;
  fallbackReason?: string;
}

// Fills in whichever half the caller lacks. The peer ID names the thread the
// receipt belongs in and is what `sendDm` routes on; the Nostr key makes rail 2
// possible. Without both, a Wallet-tab payment lands in a parallel thread.
function resolvePayee(
  params: PayPersonParams,
  service: MeshService,
): ResolvedPayee | null {
  if (params.peerID !== undefined && params.peerID.length > 0) {
    const peerID = params.peerID;
    // A `nostr_` id carries its key; else their last ANNOUNCE, then the
    // contact record, which survives them leaving Bluetooth range.
    const nostrPubkey = isNostrId(peerID)
      ? peerID.slice(NOSTR_ID_PREFIX.length)
      : (params.nostrPubkey ??
        service.getPeerNostrPubkey(peerID) ??
        useContactsStore.getState().getContact(peerID)?.nostrPubkeyHex);
    return {
      peerID,
      ...(nostrPubkey !== undefined && nostrPubkey.length > 0
        ? { nostrPubkey }
        : {}),
    };
  }

  const nostrPubkey = params.nostrPubkey;
  if (nostrPubkey === undefined || nostrPubkey.length === 0) return null;

  // A known contact is paid under their peer ID, keeping the radio rail open.
  const known = Object.values(useContactsStore.getState().contacts).find(
    (c) => c.nostrPubkeyHex === nostrPubkey,
  );
  return {
    peerID: known?.peerID ?? `${NOSTR_ID_PREFIX}${nostrPubkey}`,
    nostrPubkey,
  };
}

// Rail 2: lock proofs to their key and publish the kind 9321. Null only when
// nothing was spent. Once proofs are locked the value has left for good, so it
// never returns null: every later branch is about delivery, and falling through
// would pay the same person twice and strand the first payment.
async function payAsNutzap(params: {
  target: NutzapTarget;
  recipientPubkey: string;
  peerID: string;
  amount: number;
  unit: string;
  comment?: string;
  senderNickname?: string;
  client: NonNullable<ReturnType<MeshService["getNostrClient"]>>;
  privKey: Uint8Array;
}): Promise<PayResult | null> {
  // Separate catches: a failed lock spends nothing (the swap is atomic), a
  // failed publish means the value is already committed.
  let locked;
  try {
    locked = await lockProofsForNutzap({
      amount: params.amount,
      mintUrl: params.target.mintUrl,
      unit: params.unit,
      recipientPubkey: params.target.p2pkPubkey,
    });
  } catch (err) {
    // In doubt: the request may have reached the mint. Its coins stay held
    // against the lock until `reconcile` learns which, and a token now could
    // pay twice, so the ladder stops and the error says so.
    if (err instanceof WalletError && err.inDoubt) throw err;
    // Unreachable before the request left, Tor blocking, a refusal, short
    // denominations: nothing left the wallet, so the token rails are next.
    return null;
  }

  const { published, token } = await publishLockedNutzap({
    locked: locked.locked,
    txId: locked.txId,
    mintUrl: params.target.mintUrl,
    unit: params.unit,
    recipientPubkey: params.recipientPubkey,
    senderPrivKey: params.privKey,
    client: params.client,
    comment: params.comment,
    // Their relays (kind 10019), not ours: see NutzapTarget.
    relays: params.target.relays,
  });

  const base = {
    amount: params.amount,
    unit: params.unit,
    mintUrl: params.target.mintUrl,
    txId: locked.txId,
    final: true,
  };
  if (published) {
    noteNutzapInThread(params.peerID, locked.txId, params.amount, params.unit);
    return { rail: "nutzap", ...base };
  }

  // Relay refused. Locked proofs are worthless to anyone but the recipient, so
  // any DM route will do, and the outbox retries if the internet failed.
  const route = deliverTokenToPeer({
    peerID: params.peerID,
    prepared: { txId: locked.txId, token },
    senderNickname: params.senderNickname,
    final: true,
  });
  if (route === "sent" || route === "sent-nostr") {
    settleNutzap(locked.txId);
    // No `fallbackReason`: the rail sentence already says the relay refused.
    return { rail: "nutzap-dm", ...base };
  }

  // Queued or couriered: still theirs, still not reclaimable. The tx records
  // why it waits rather than looking abandoned; `reconcile` closes it on
  // delivery.
  failNutzapDelivery(locked.txId, t("wallet.svc.locked_undelivered"));
  return { rail: "nutzap-undelivered", ...base, token };
}

// A local-only system notice, never transmitted. A nutzap is not a message, so
// there is no bubble or delivery status, but a thread showing nothing reads as
// money that vanished. Only in an existing thread: zapping a stranger's npub
// must not create one; the wallet history already records it.
function noteNutzapInThread(
  peerID: string,
  txId: string,
  amount: number,
  unit: string,
): void {
  const chat = useChatStore.getState();
  const channel = `dm:${peerID}`;
  if (chat.messages[channel] === undefined) return;
  chat.addMessage({
    // Keyed by transaction: two in one millisecond would collide on the clock.
    id: `nutzap-note-${txId}`,
    channel,
    senderID: getMeshService()?.getPeerID() ?? "",
    senderNickname: "",
    // Stored pre-grouped, since interpolating a number drops the separator.
    // A language switch re-translates the sentence but keeps the original
    // separator ("21,500" where "21.500" was due). Digits stay Latin either
    // way, and that is far smaller than a receipt frozen in one language.
    ...systemRow("wallet.pay.thread_receipt", {
      ...amountParts(amount, unit),
    }),
    timestampMs: Date.now(),
    isMine: true,
    isSystem: true,
  });
}

// Rails 3 and 4: an ordinary reserved token, routed by `sendDm`.
async function payAsToken(params: {
  peerID: string;
  amount: number;
  unit: string;
  memo?: string;
  senderNickname?: string;
  fallbackReason?: string;
  name: string;
  // The inexact warning is asked regardless: overpaying is a separate question.
  confirmed: boolean;
}): Promise<PayResult | null> {
  const quote = await quoteSend({ amount: params.amount, unit: params.unit });
  // In whichever question is actually asked about this quote.
  const staleDays = staleFeeDays(quote.pricedFromCacheAgeMs);
  const staleNote =
    staleDays === null
      ? ""
      : `\n\n${tPlural("wallet.send.stale_fee_note", staleDays)}`;
  if (quote.exact && !params.confirmed) {
    const confirmed = await confirmPayment(
      params.amount,
      params.unit,
      params.name,
      false,
      staleNote,
    );
    if (!confirmed) return null;
  }
  if (!quote.exact) {
    // Before reserving: an inexact send overpays irreversibly once redeemed.
    const confirmed = await confirm(
      t("wallet.err.exact_amount"),
      t("wallet.xfer.inexact_body", {
        ...amountParts(params.amount, params.unit),
        spend: amountParts(quote.spend, params.unit).amount,
        extra: amountParts(quote.spend - params.amount, params.unit).amount,
      }) + staleNote,
      t("wallet.xfer.send_amount", {
        amount: amountParts(quote.spend, params.unit).amount,
      }),
    );
    if (!confirmed) return null;
  }

  const prepared = await prepareSend({
    amount: params.amount,
    unit: params.unit,
    memo: params.memo,
    counterparty: params.peerID,
    // Only what the user was shown: the pool can change while a dialog is
    // open, and an exact quote gone inexact would overpay unasked.
    allowInexact: !quote.exact,
  });

  const route = deliverTokenToPeer({
    peerID: params.peerID,
    prepared,
    senderNickname: params.senderNickname,
  });

  return {
    rail: railForRoute(route),
    amount: prepared.amount,
    unit: prepared.unit,
    mintUrl: prepared.mintUrl,
    txId: prepared.txId,
    ...(route === "queued" ? { token: prepared.token } : {}),
    final: false,
    ...(params.fallbackReason !== undefined
      ? { fallbackReason: params.fallbackReason }
      : {}),
  };
}

function railForRoute(route: DeliveryRoute): PayRail {
  switch (route) {
    case "sent":
      return "mesh";
    case "sent-nostr":
      return "nostr";
    case "needs-courier":
      return "courier";
    case "queued":
      return "queued";
  }
}

export function describeRoute(route: DeliveryRoute): string {
  return describeRail(railForRoute(route));
}

function describeRail(rail: PayRail): string {
  switch (rail) {
    case "mesh":
      return t("wallet.xfer.route_mesh");
    case "nutzap":
      return t("wallet.pay.rail_nutzap");
    case "nutzap-dm":
      return t("wallet.pay.rail_nutzap_dm");
    case "nutzap-undelivered":
      return t("wallet.pay.rail_nutzap_undelivered");
    case "nostr":
      return t("wallet.xfer.route_nostr");
    case "courier":
      return t("wallet.xfer.route_courier");
    case "queued":
      return t("wallet.xfer.route_queued");
  }
}

function describeFinality(final: boolean): string {
  return final ? t("wallet.pay.final") : t("wallet.pay.reclaimable");
}

// Rail, why that rail, then whether it can be undone: where the money went and
// whether the user can still stop it, in one order for every screen. The queued
// sentences stay honest: "on its way" and "waiting for a route" differ.
export function describePayResult(result: PayResult): string {
  const why =
    result.fallbackReason !== undefined && result.fallbackReason.length > 0
      ? ` ${t("wallet.pay.why", { reason: result.fallbackReason })}`
      : "";
  return `${describeRail(result.rail)}${why} ${describeFinality(result.final)}`;
}

// Structural so a relay-refused locked nutzap fits as well as a `PreparedSend`.
export interface DeliverableToken {
  txId: string;
  token: string;
}

// Exported for the Wallet tab's peer picker, which delivers a token built
// earlier; preparing another would reserve a second set of proofs.
export function deliverTokenToPeer(params: {
  peerID: string;
  prepared: DeliverableToken;
  senderNickname?: string;
  // Locked nutzap proofs: changes only how a failed delivery is recorded.
  final?: boolean;
}): DeliveryRoute {
  const service = getMeshService();
  if (!service) return "queued";

  const channel = `dm:${params.peerID}`;
  const chat = useChatStore.getState();
  chat.addChannel(channel);

  // The txId is the message id, so a delivery receipt settles the transaction.
  const message: ChatMessage = {
    id: params.prepared.txId,
    channel,
    senderID: service.getPeerID(),
    senderNickname: params.senderNickname ?? t("chat.you"),
    text: params.prepared.token,
    timestampMs: Date.now(),
    isMine: true,
    status: "sending",
  };
  chat.addMessage(message);
  const route = service.sendDm(
    params.peerID,
    params.prepared.token,
    params.prepared.txId,
  );

  // A routeless send gets no receipt, so set the status from the route now.
  chat.setMessageStatus(
    channel,
    params.prepared.txId,
    route === "needs-courier"
      ? "carried"
      : route === "queued"
        ? "queued"
        : "sent",
  );

  // So Pending explains why it is waiting. A locked nutzap is recorded by the
  // caller, which knows it must not be offered back.
  if ((route === "queued" || route === "needs-courier") && !params.final) {
    failSend(params.prepared.txId, describeRoute(route));
  }
  return route;
}

// Reclaims a pending send and cancels every copy. `reclaimSend` alone only
// moves proofs; the outbox entry would still deliver a token the sender took
// back once a route appears. A locked nutzap has no reservation, so this stops
// before the thread or outbox: those proofs are the recipient's, and the queued
// copy is their only way to them.
export function reclaimTokenSend(txId: string): boolean {
  // Read before reclaiming. A hand-built token has none.
  const peerID = useWalletStore
    .getState()
    .history.find((tx) => tx.id === txId)?.counterparty;
  if (!reclaimSend(txId)) return false;
  useOutboxStore.getState().resolve(txId);
  if (peerID !== undefined && peerID.length > 0) {
    useChatStore.getState().setMessageStatus(`dm:${peerID}`, txId, "reclaimed");
  }
  return true;
}

// The mint's half of a reclaim, after `reclaimTokenSend`. If the recipient had
// already redeemed the token, the thread says it arrived after all.
export async function settleReclaimedSend(
  txId: string,
): Promise<ReclaimOutcome> {
  const outcome = await settleReclaim(txId);
  if (outcome === "claimed") {
    const peerID = useWalletStore
      .getState()
      .history.find((tx) => tx.id === txId)?.counterparty;
    if (peerID !== undefined && peerID.length > 0) {
      useChatStore.getState().markReclaimedPaid(`dm:${peerID}`, txId);
    }
  }
  return outcome;
}

export function reportWalletError(err: unknown): void {
  // A code's title ("Mint refused") would contradict "nobody knows yet".
  if (err instanceof WalletError && err.inDoubt) {
    showAlert(err.message, err.detail ?? "");
    return;
  }
  if (err instanceof WalletError) {
    const titles: Record<string, string> = {
      locked: t("wallet.err.locked"),
      offline: t("wallet.err.mint_unreachable"),
      "tor-blocked": t("wallet.err.tor_blocked"),
      insufficient: t("wallet.err.insufficient"),
      inexact: t("wallet.err.exact_amount"),
      "no-mint": t("wallet.err.no_mint"),
      unsupported: t("wallet.err.mint_unsupported"),
      "mint-error": t("wallet.err.mint_refused"),
      "invalid-token": t("wallet.err.unreadable"),
      "forged-token": t("wallet.err.rejected"),
      "already-spent": t("wallet.err.already_spent"),
      "change-pending": t("wallet.err.change_pending"),
    };
    showAlert(
      titles[err.code] ?? t("wallet.xfer.could_not_send"),
      err.detail ? `${err.message}\n\n${err.detail}` : err.message,
    );
    return;
  }
  showAlert(t("wallet.xfer.could_not_send"), String(err));
}

// Every payment asks this before money moves: amount, recipient, finality.
// `note` is appended as given (a stale fee schedule, say).
function confirmPayment(
  amount: number,
  unit: string,
  name: string,
  final: boolean,
  note = "",
): Promise<boolean> {
  return confirm(
    t("wallet.pay.confirm_title", {
      ...amountParts(amount, unit),
      name,
    }),
    (final
      ? t("wallet.pay.confirm_final")
      : t("wallet.pay.confirm_reclaimable")) + note,
    t("wallet.xfer.send_amount", { amount: amountParts(amount, unit).amount }),
  );
}

// Promise over the alert store. A backdrop tap fires no onPress, so a
// button-only promise would never settle and the send would hang. Watching
// `visible` resolves any dismissal that was not a confirm as false.
function confirm(
  title: string,
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(value);
    };
    // custom-alert hides before calling onPress, so this fires on a confirm
    // too. Deferring a tick lets that onPress settle first.
    const unsubscribe = useAlertStore.subscribe((state) => {
      if (state.visible) return;
      setTimeout(() => finish(false), 0);
    });
    showAlert(title, message, [
      {
        text: t("common.cancel"),
        style: "cancel",
        onPress: () => finish(false),
      },
      {
        text: confirmLabel,
        style: "destructive",
        onPress: () => finish(true),
      },
    ]);
  });
}
