// Saving whoever a DM goes to as a contact, shared by every path that opens or
// sends one: replying in a DM, messaging someone from a channel, and Message in
// the peer list.
//
// Never a relay node in range. A saved relay would sit in the contact list as a
// person and be handed a Noise session on every pass; it is equipment, not
// someone to keep (PROTOCOLS section 10.1).

import { useContactsStore } from "@store/contacts-store";
import { isPerson, usePeerStore } from "@store/peer-store";

export function keepAsContact(peerID: string, nickname: string): void {
  const peer = usePeerStore.getState().getPeer(peerID);
  if (peer !== undefined && !isPerson(peer)) return;
  useContactsStore
    .getState()
    .saveIfAbsent(peerID, nickname, peer?.noisePubKeyHex ?? "");
}
