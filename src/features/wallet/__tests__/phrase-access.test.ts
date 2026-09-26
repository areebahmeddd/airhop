/**
 * @jest-environment node
 */
import { confirmOwnerForPhrase } from "../phrase-access";

const mockConfirm = jest.fn();
jest.mock("@platform/device-auth", () => ({
  confirmDeviceOwner: (params: unknown) => mockConfirm(params),
}));
jest.mock("@i18n", () => ({ t: (key: string) => key }));

beforeEach(() => mockConfirm.mockReset());

describe("confirmOwnerForPhrase", () => {
  test("shows the phrase once the owner is confirmed", async () => {
    mockConfirm.mockResolvedValue("passed");
    await expect(confirmOwnerForPhrase()).resolves.toBe(true);
    expect(mockConfirm).toHaveBeenCalledWith({
      prompt: "wallet.backup.auth_prompt",
      cancelLabel: "common.cancel",
    });
  });

  test("a dismissed or locked-out prompt shows nothing", async () => {
    mockConfirm.mockResolvedValue("refused");
    await expect(confirmOwnerForPhrase()).resolves.toBe(false);
  });

  test("a phone with no screen lock has no owner to ask", async () => {
    mockConfirm.mockResolvedValue("no-lock");
    await expect(confirmOwnerForPhrase()).resolves.toBe(true);
  });

  test("a second tap while the prompt is up asks nothing more", async () => {
    let answer: (value: string) => void = () => undefined;
    mockConfirm.mockReturnValue(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );
    const first = confirmOwnerForPhrase();
    await expect(confirmOwnerForPhrase()).resolves.toBe(false);
    answer("passed");
    await expect(first).resolves.toBe(true);
    expect(mockConfirm).toHaveBeenCalledTimes(1);

    mockConfirm.mockResolvedValue("passed");
    await expect(confirmOwnerForPhrase()).resolves.toBe(true);
  });
});
