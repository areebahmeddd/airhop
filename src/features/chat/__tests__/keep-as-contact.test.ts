// Messaging someone keeps them as a contact, except a relay node in range,
// which is equipment (PROTOCOLS section 10.1).

import { useContactsStore } from "@store/contacts-store";
import { usePeerStore } from "@store/peer-store";
import { keepAsContact } from "../keep-as-contact";

const PEER = "a1b2c3d4e5f60718";
const NOISE_KEY = "11".repeat(32);

beforeEach(() => {
  useContactsStore.setState({ contacts: {} });
  usePeerStore.getState().clearAll();
});

function inRange(isRelay: boolean): void {
  usePeerStore.getState().upsertPeer({
    peerID: PEER,
    nickname: "someone",
    lastSeenMs: Date.now(),
    noisePubKeyHex: NOISE_KEY,
    isRelay,
  });
}

it("never keeps a relay node in range", () => {
  inRange(true);
  keepAsContact(PEER, "AirhopRelay-A1B2");
  expect(useContactsStore.getState().contacts[PEER]).toBeUndefined();
});

it("keeps a person in range, with the Noise key their announce carried", () => {
  inRange(false);
  keepAsContact(PEER, "alice");
  expect(useContactsStore.getState().contacts[PEER]?.noisePubKeyHex).toBe(
    NOISE_KEY,
  );
});

it("keeps someone out of range, with no key yet", () => {
  keepAsContact(PEER, "bob");
  const contact = useContactsStore.getState().contacts[PEER];
  expect(contact?.nickname).toBe("bob");
  expect(contact?.noisePubKeyHex).toBe("");
});
