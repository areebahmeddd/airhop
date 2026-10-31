// Onboarding's write of a new identity, and what it must not inherit.
import { loadIdentity } from "@core/crypto/identity";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import * as SecureStore from "expo-secure-store";
import { writeNewIdentity } from "../launch-identity";

const secureStore = SecureStore as typeof SecureStore & { __reset: () => void };

beforeEach(() => {
  secureStore.__reset();
});

// The prekey store adopts any blob it finds, so an old identity's prekeys left
// in the keychain would be published under the new key, linking the two.
test("a new identity starts without the previous identity's prekeys", async () => {
  await writeSecret(KEYCHAIN_ITEMS.localPrekeys, "old-identity-prekeys");

  const peerID = await writeNewIdentity();

  expect(await readSecret(KEYCHAIN_ITEMS.localPrekeys)).toBeNull();
  expect((await loadIdentity())?.peerID).toBe(peerID);
});

// Writing the identity anyway would leave the old prekeys beside it; onboarding
// shows its retry instead.
test("a refused prekey delete writes no identity", async () => {
  await writeSecret(KEYCHAIN_ITEMS.localPrekeys, "old-identity-prekeys");
  jest
    .mocked(SecureStore.deleteItemAsync)
    .mockRejectedValueOnce(new Error("keystore locked"));

  await expect(writeNewIdentity()).rejects.toThrow("keystore locked");
  expect(await loadIdentity()).toBeNull();
});
