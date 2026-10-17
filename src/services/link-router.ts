// What a link does once it has been parsed: Airhop's own, and the `cashu:`
// payment links Airhop answers as a wallet.
//
// There are two ways one arrives: the OS hands it over (app.tsx), or the user
// pastes it into the Join sheet. Only the second is consent. Any installed app,
// or a page that redirects, can fire an OS link, so that one only fills in the
// Join sheet, and both take effect the same way: on Join, here. Everything is a
// pure consequence of the link plus the stores; the caller only decides where
// to navigate.
//
// Parsing stays in utils/deep-link (pure, no crypto). This module owns the side
// effects, which is why it lives with the services.

import { decodeQRContent } from "@core/crypto/contact-exchange";
import { isValidChannelKey } from "@core/mesh/rooms/channel-crypto";
import { bareToken } from "@core/payments/cashu";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { parseAirhopLink, type DeepLink } from "@utils/deep-link";
import { Linking, Share } from "react-native";
import { getMeshService } from "./mesh-service";

// What an OS-delivered link puts in the Join sheet, or null when it is not an
// Airhop link. Changes nothing: the person still reads what it does and taps
// Join.
export function joinSheetPrefill(url: string | null): string | null {
  if (url === null) return null;
  const text = url.trim();
  return parseAirhopLink(text) === null ? null : text;
}

// The token in an OS-delivered `cashu:` link. Same consent rule as an Airhop
// link: it only fills in Receive.
export function cashuLinkToken(url: string | null): string | null {
  if (url === null) return null;
  const text = url.trim();
  if (!/^cashu:/i.test(text)) return null;
  return bareToken(text);
}

// Long enough for the OS to bounce our own link back.
const HANDOFF_ECHO_MS = 5000;

let lastHandoff: { uri: string; atMs: number } | null = null;

// Open a payment link in another wallet, or offer Share where none answers.
// Try, do not ask: `canOpenURL` says "no" for undeclared schemes, while
// `openURL` just rejects. Remembered because Airhop claims `cashu:` itself, so
// with no other wallet the OS hands the link straight back.
export async function handOffToWallet(uri: string): Promise<void> {
  lastHandoff = { uri, atMs: Date.now() };
  try {
    await Linking.openURL(uri);
  } catch {
    lastHandoff = null;
    await shareInstead(uri);
  }
}

// Our own hand-off, returned by an OS that found no other wallet. Share is what
// was wanted, not a receive of coins that are ours already.
export function isOwnHandoffEcho(url: string): boolean {
  const echo =
    lastHandoff !== null &&
    lastHandoff.uri === url.trim() &&
    Date.now() - lastHandoff.atMs < HANDOFF_ECHO_MS;
  if (echo) lastHandoff = null;
  return echo;
}

export async function shareInstead(uri: string): Promise<void> {
  try {
    await Share.share({ message: uri });
  } catch {
    // Silent: the instrument is on screen with Copy beside it.
  }
}

// What a link did: the conversation to open, or why it opened none. "conflict"
// is a contact card naming a different key from the one already held for that
// peer, which needs other words than a card that was tampered with or an
// invite whose key is malformed ("invalid").
export type LinkOutcome =
  { channel: string } | { refused: "invalid" | "conflict" };

// Apply a link. The caller navigates; nothing here touches navigation state.
export function applyAirhopLink(link: DeepLink): LinkOutcome {
  if (link.kind === "channel") {
    // A private channel invite carries its E2E key; a public one does not.
    // joinPrivateChannel answers with the room it actually landed in, which
    // differs from the name asked for when that name is already taken by a
    // different key.
    if (link.key !== undefined) {
      // Refused, never joined as the public room of that name: the user would
      // believe it private and talk in the clear.
      if (!isValidChannelKey(link.key)) return { refused: "invalid" };
      return {
        channel: useChatStore
          .getState()
          .joinPrivateChannel(link.channel, link.key, link.overNostr),
      };
    }
    useChatStore.getState().addChannel(link.channel);
    return { channel: link.channel };
  }

  if (link.kind === "peer") {
    const channel = `dm:${link.peerID}`;
    useChatStore.getState().addChannel(channel);
    return { channel };
  }

  // A contact card: verify and import the keys, then open the DM.
  const card = decodeQRContent(link.card);
  if (card === null) return { refused: "invalid" };
  // Reject a card whose peer ID isn't the fingerprint of its Noise key;
  // accepting it would encrypt every DM to whoever forged the card. Seeds the
  // routing registry and inbound Nostr map as a side effect.
  //
  // Deliberately NOT in person. Both routes into this function are links (the
  // OS handing one over, or the user pasting one), and neither says anything
  // about who produced it. So the card may not re-pin keys already bound to
  // that peer (see addVerifiedContact), and the contact it writes is not
  // verified.
  const result = getMeshService()?.addVerifiedContact(card);
  if (result !== "added") {
    return { refused: result === "conflict" ? "conflict" : "invalid" };
  }
  useContactsStore.getState().addContact({
    peerID: card.peerID,
    noisePubKeyHex: bytesToHex(card.noisePubKey),
    signingPubKeyHex: bytesToHex(card.signingPubKey),
    nickname: card.nickname,
    addedAtMs: Date.now(),
    // "link", not "qr". The card is self-consistent, but a link proves only
    // that someone put it somewhere the user tapped: a web page, an SMS, a
    // message in another app. This is the one path that can witness nothing
    // about who produced it.
    //
    // Safe to state flatly for a contact already verified: addContact merges
    // and never lowers a source.
    source: "link",
    // The card carries the peer's Nostr pubkey (internet reachability). An
    // `airhop:v1/` link always has one; the guard is for the type, not the
    // format.
    ...(card.nostrPubKey !== undefined
      ? { nostrPubkeyHex: bytesToHex(card.nostrPubKey) }
      : {}),
  });
  const channel = `dm:${card.peerID}`;
  useChatStore.getState().addChannel(channel);
  return { channel };
}
