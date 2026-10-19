// Receiving a token from a mint this wallet has never used.
//
// The wallet never enrols a mint on a token's say-so, so a stranger cannot make
// it hold an unvetted mint's paper. It asks instead, and only for the one
// refusal adding a mint can fix: any other error, or a mint already held, must
// reach the caller untouched.

jest.mock("../wallet-service", () => ({
  __esModule: true,
  WalletError: class WalletError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  receiveToken: jest.fn(),
  addMint: jest.fn(),
  hostOf: (url: string) => new URL(url).hostname,
}));

jest.mock("../mesh-service", () => ({
  __esModule: true,
  getMeshService: jest.fn(),
}));

import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { useAlertStore } from "@store/alert-store";
import { useWalletStore } from "@store/wallet-store";
import { receiveTrustingMint } from "../payment-router";
import { addMint, receiveToken, WalletError } from "../wallet-service";

const MINT = "https://mint.example.com";

const mockedReceive = receiveToken as jest.MockedFunction<typeof receiveToken>;
const mockedAddMint = addMint as jest.MockedFunction<typeof addMint>;

const TOKEN = getEncodedToken({
  mint: MINT,
  unit: "sat",
  proofs: [
    {
      id: "01" + "ab".repeat(32),
      amount: 8,
      secret: "secret-0",
      C: "02" + "cd".repeat(32),
    },
  ],
} as unknown as Token);

const RECEIVED = {
  amount: 8,
  unit: "sat",
  mintUrl: MINT,
  outcome: "swapped",
  dleq: "valid",
} as unknown as Awaited<ReturnType<typeof receiveToken>>;

function noMint(): Error {
  return new (WalletError as unknown as new (c: string, m: string) => Error)(
    "no-mint",
    "That payment names a mint you do not use.",
  );
}

let answer: "confirm" | "cancel" = "confirm";
let asked = 0;
let stopAnswering: (() => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useWalletStore.setState({ mints: {} });
  answer = "confirm";
  asked = 0;
  stopAnswering = useAlertStore.subscribe((state, previous) => {
    if (!state.visible || previous.visible) return;
    const button = state.buttons.find((b) =>
      answer === "confirm" ? b.style === "destructive" : b.style === "cancel",
    );
    if (button === undefined) return;
    asked += 1;
    // The modal hides itself and then runs the button, in that order.
    queueMicrotask(() => {
      useAlertStore.getState().hide();
      button.onPress?.();
    });
  });
});

afterEach(() => {
  stopAnswering?.();
  stopAnswering = null;
  useAlertStore.getState().hide();
});

describe("receiveTrustingMint", () => {
  it("receives without asking when the wallet takes the token", async () => {
    mockedReceive.mockResolvedValueOnce(RECEIVED);
    await expect(receiveTrustingMint(TOKEN)).resolves.toBe(RECEIVED);
    expect(asked).toBe(0);
    expect(mockedAddMint).not.toHaveBeenCalled();
  });

  it("adds the token's mint once agreed, then receives again", async () => {
    mockedReceive.mockRejectedValueOnce(noMint());
    mockedReceive.mockResolvedValueOnce(RECEIVED);
    mockedAddMint.mockResolvedValueOnce({} as never);

    await expect(
      receiveTrustingMint(TOKEN, { counterparty: "peer" }),
    ).resolves.toBe(RECEIVED);
    expect(asked).toBe(1);
    expect(mockedAddMint).toHaveBeenCalledWith(MINT);
    expect(mockedReceive).toHaveBeenLastCalledWith(TOKEN, {
      counterparty: "peer",
    });
  });

  it("adds nothing and takes nothing when declined", async () => {
    answer = "cancel";
    mockedReceive.mockRejectedValueOnce(noMint());
    await expect(receiveTrustingMint(TOKEN)).resolves.toBeNull();
    expect(mockedAddMint).not.toHaveBeenCalled();
    expect(mockedReceive).toHaveBeenCalledTimes(1);
  });

  it("passes every other refusal through without asking", async () => {
    const offline = new (
      WalletError as unknown as new (c: string, m: string) => Error
    )("offline", "unreachable");
    mockedReceive.mockRejectedValueOnce(offline);
    await expect(receiveTrustingMint(TOKEN)).rejects.toBe(offline);
    expect(asked).toBe(0);
  });

  it("does not offer a mint the wallet already holds", async () => {
    useWalletStore.setState({ mints: { [MINT]: {} as never } });
    const refused = noMint();
    mockedReceive.mockRejectedValueOnce(refused);
    await expect(receiveTrustingMint(TOKEN)).rejects.toBe(refused);
    expect(asked).toBe(0);
  });

  it("reports a mint that cannot be added, having asked once", async () => {
    mockedReceive.mockRejectedValueOnce(noMint());
    const unreachable = new Error("unreachable");
    mockedAddMint.mockRejectedValueOnce(unreachable);
    await expect(receiveTrustingMint(TOKEN)).rejects.toBe(unreachable);
    expect(asked).toBe(1);
    expect(mockedReceive).toHaveBeenCalledTimes(1);
  });
});
