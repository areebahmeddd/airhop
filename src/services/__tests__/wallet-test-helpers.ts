// What the wallet suites share: a token from a stranger's wallet, and a receive
// made with the internet off.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";

import { receiveToken } from "@services/wallet-service";
import { useSettingsStore } from "@store/settings-store";

const UNIT = "sat";

export async function strangersTokenAt(
  mintUrl: string,
  sats: number,
): Promise<string> {
  const sender = new Wallet(new Mint(mintUrl), { unit: UNIT });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(sats);
  const proofs = await sender.mintProofsBolt11(sats, quote);
  return getEncodedToken({
    mint: mintUrl,
    unit: UNIT,
    proofs,
  } as unknown as Token);
}

export async function receiveOffline(token: string): Promise<void> {
  useSettingsStore.setState({ internetEnabled: false });
  try {
    expect((await receiveToken(token)).outcome).toBe("stored");
  } finally {
    useSettingsStore.setState({ internetEnabled: true });
  }
}
