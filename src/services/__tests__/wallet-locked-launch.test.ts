/**
 * @jest-environment node
 */
// A wallet opened while the keychain is locked. iOS relaunches the app in the
// background before first unlock, the wallet's file key cannot be read, and
// the same process later carries on once the person unlocks. The wallet must
// open then, not stay locked until a force-quit.

import { KEYCHAIN_ITEMS } from "@core/crypto/keychain";
import { isWalletStorageReady } from "@store/wallet-store";
import { initWalletService } from "../wallet-service";

// Set up inside the factory: the wallet store starts hydrating the moment it
// is imported, before any beforeAll runs.
const mockSecrets = new Map<string, string>();
const mockKeychain = { locked: true };

jest.mock("@core/crypto/keychain", () => {
  const refuse = () => Promise.reject(new Error("errSecInteractionNotAllowed"));
  return {
    ...jest.requireActual("@core/crypto/keychain"),
    readSecret: jest.fn((item: string) =>
      mockKeychain.locked
        ? refuse()
        : Promise.resolve(mockSecrets.get(item) ?? null),
    ),
    writeSecret: jest.fn((item: string, value: string) => {
      if (mockKeychain.locked) return refuse();
      mockSecrets.set(item, value);
      return Promise.resolve();
    }),
  };
});

jest.mock("react-native-mmkv", () => {
  class MockMMKV {
    private store = new Map<string, string>();
    getString(key: string): string | undefined {
      return this.store.get(key);
    }
    set(key: string, value: string): void {
      this.store.set(key, value);
    }
    remove(key: string): void {
      this.store.delete(key);
    }
    encrypt(): void {}
    clearAll(): void {
      this.store.clear();
    }
  }
  const instances = new Map<string, MockMMKV>();
  return {
    createMMKV: ({ id = "default" }: { id?: string } = {}) => {
      if (!instances.has(id)) instances.set(id, new MockMMKV());
      return instances.get(id)!;
    },
    deleteMMKV: jest.fn(() => true),
  };
});

test("a wallet that could not open while locked opens once the phone is unlocked", async () => {
  mockSecrets.set(KEYCHAIN_ITEMS.walletEncryptionKey, "k".repeat(32));

  expect(await initWalletService()).toBe(false);
  expect(isWalletStorageReady()).toBe(false);

  mockKeychain.locked = false;
  expect(await initWalletService()).toBe(true);
  expect(isWalletStorageReady()).toBe(true);
});
