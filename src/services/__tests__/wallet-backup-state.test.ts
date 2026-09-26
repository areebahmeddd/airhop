/**
 * @jest-environment node
 */
// The recovery phrase at startup. Only a phrase the keychain confirms is absent
// may be replaced by a new one: a read that fails (a locked phone, a transient
// Keystore error) or a stored value that no longer validates still stands for
// words the user may have written down. Overwriting it, or clearing the
// "backed up" marks, would destroy that backup without a word.

import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import {
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import {
  enableWalletBackup,
  getRecoveryPhrase,
  initWalletService,
  resetWalletService,
} from "../wallet-service";

const secrets = new Map<string, string>();

jest.mock("@core/crypto/keychain", () => ({
  ...jest.requireActual("@core/crypto/keychain"),
  readSecret: jest.fn(),
  writeSecret: jest.fn(),
}));

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

const PHRASE_ITEM = KEYCHAIN_ITEMS.walletRecoveryPhrase;
const KNOWN =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

let phraseReadFails = false;

beforeAll(() => {
  jest.mocked(readSecret).mockImplementation((item: string) => {
    if (item === PHRASE_ITEM && phraseReadFails) {
      return Promise.reject(new Error("errSecInteractionNotAllowed"));
    }
    return Promise.resolve(secrets.get(item) ?? null);
  });
  jest.mocked(writeSecret).mockImplementation((item: string, value: string) => {
    secrets.set(item, value);
    return Promise.resolve();
  });
});

beforeEach(async () => {
  phraseReadFails = false;
  secrets.clear();
  resetWalletService();
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  useWalletStore.getState().clearAll();
  jest.mocked(writeSecret).mockClear();
});

function phraseWrites(): number {
  return jest
    .mocked(writeSecret)
    .mock.calls.filter(([item]) => item === PHRASE_ITEM).length;
}

function markBackedUp(): void {
  useWalletStore.getState().setBackupEnabled(true);
  useWalletStore.getState().setBackupVerified(true);
}

describe("a recovery phrase the keychain will not hand over", () => {
  it("keeps the backup marks and writes no new phrase at startup", async () => {
    secrets.set(PHRASE_ITEM, KNOWN);
    markBackedUp();
    phraseReadFails = true;

    expect(await initWalletService()).toBe(true);

    expect(phraseWrites()).toBe(0);
    expect(secrets.get(PHRASE_ITEM)).toBe(KNOWN);
    expect(useWalletStore.getState().backupEnabled).toBe(true);
    expect(useWalletStore.getState().backupVerified).toBe(true);
  });

  it("refuses to set up a backup over it", async () => {
    secrets.set(PHRASE_ITEM, KNOWN);
    phraseReadFails = true;
    await initWalletService();

    await expect(enableWalletBackup()).rejects.toMatchObject({
      code: "locked",
    });
    await expect(getRecoveryPhrase()).rejects.toMatchObject({
      code: "locked",
    });
    expect(phraseWrites()).toBe(0);
    expect(secrets.get(PHRASE_ITEM)).toBe(KNOWN);
  });

  it("is used again once the keychain answers", async () => {
    secrets.set(PHRASE_ITEM, KNOWN);
    phraseReadFails = true;
    await initWalletService();
    phraseReadFails = false;

    expect(await getRecoveryPhrase()).toBe(KNOWN);
    expect(await enableWalletBackup()).toEqual({
      phrase: KNOWN,
      existed: true,
    });
    expect(phraseWrites()).toBe(0);
  });
});

describe("a stored phrase that no longer validates", () => {
  it("is never overwritten, and its marks stay", async () => {
    secrets.set(PHRASE_ITEM, "corrupted words");
    markBackedUp();

    await initWalletService();
    await expect(enableWalletBackup()).rejects.toMatchObject({
      code: "locked",
    });

    expect(phraseWrites()).toBe(0);
    expect(secrets.get(PHRASE_ITEM)).toBe("corrupted words");
    expect(useWalletStore.getState().backupEnabled).toBe(true);
    expect(useWalletStore.getState().backupVerified).toBe(true);
  });
});

describe("no phrase at all", () => {
  it("makes one at startup and stops claiming the old one is covered", async () => {
    markBackedUp();

    await initWalletService();

    expect(phraseWrites()).toBe(1);
    expect(await getRecoveryPhrase()).toBe(secrets.get(PHRASE_ITEM));
    expect(useWalletStore.getState().backupEnabled).toBe(false);
    expect(useWalletStore.getState().backupVerified).toBe(false);
  });
});
