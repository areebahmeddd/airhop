// Reset settings and the media retention picker: what each actually changes.
// Reset's confirm says app lock, the retention window and status stay as set,
// so those must survive it. The retention sheet says media goes after the
// chosen time, so a shorter window has to apply to what is already on disk.

import { t, tPlural } from "@i18n";
import { useAlertStore } from "@store/alert-store";
import { useSettingsStore } from "@store/settings-store";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import GeneralScreen from "../general-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));
jest.mock("@services/tor-routing", () => ({
  setTorRouting: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock("@services/boot-sync", () => ({ syncAutoStartOnBoot: jest.fn() }));

const mockSweepNow = jest.fn();
jest.mock("@services/media-retention", () => ({
  sweepMediaNow: () => mockSweepNow(),
}));

// Reanimated has no native half under jest, so the sheet is its contents while
// open and nothing while closed.
jest.mock("@ui/components/bottom-sheet", () => ({
  __esModule: true,
  default: ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
  }) => (visible ? children : null),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  mockSweepNow.mockClear();
  useSettingsStore.getState().reset();
});

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <GeneralScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
}

// Through the row and its confirm, the way a user resets.
async function resetSettings(): Promise<void> {
  await userEvent.setup().press(screen.getByText(t("settings.general.reset")));
  const confirm = useAlertStore
    .getState()
    .buttons.find((b) => b.text === t("settings.general.reset_confirm"));
  // A modal this test does not mount; its button runs the same handler.
  await act(async () => confirm?.onPress?.());
}

describe("Reset settings", () => {
  it("resets the preferences it lists", async () => {
    useSettingsStore.setState({
      theme: "dark",
      undoSendSeconds: 10,
      gatewayEnabled: true,
    });
    await renderScreen();
    await resetSettings();

    const s = useSettingsStore.getState();
    expect(s.theme).toBe("system");
    expect(s.undoSendSeconds).toBe(2);
    expect(s.gatewayEnabled).toBe(false);
  });

  it("leaves the app lock, the retention window and Invisible as they were", async () => {
    useSettingsStore.setState({
      appLockEnabled: true,
      appLockDelaySeconds: 300,
      mediaRetentionDays: 30,
      stayInvisible: true,
    });
    await renderScreen();
    await resetSettings();

    const s = useSettingsStore.getState();
    expect(s.appLockEnabled).toBe(true);
    expect(s.appLockDelaySeconds).toBe(300);
    expect(s.mediaRetentionDays).toBe(30);
    expect(s.stayInvisible).toBe(true);
  });

  it("never shows a subscriber a kept setting switched off", async () => {
    // The app lock stands itself down on an on-to-off edge, so a reset that
    // defaults everything and puts the kept values back afterwards releases
    // it on the way past.
    useSettingsStore.setState({ appLockEnabled: true, stayInvisible: true });
    const seen: boolean[] = [];
    const unsubscribe = useSettingsStore.subscribe((s) => {
      seen.push(s.appLockEnabled, s.stayInvisible);
    });
    await renderScreen();
    await resetSettings();
    unsubscribe();

    expect(seen).not.toContain(false);
  });
});

describe("Keep media for", () => {
  async function pickRetention(days: 7 | 14 | 30): Promise<void> {
    const user = userEvent.setup();
    await user.press(screen.getByText(t("settings.general.media_retention")));
    await user.press(
      screen.getByRole("button", {
        name: tPlural("settings.general.retention_days", days),
      }),
    );
  }

  it("sweeps at once when the window gets shorter", async () => {
    useSettingsStore.setState({ mediaRetentionDays: 30 });
    await renderScreen();
    await pickRetention(7);

    expect(useSettingsStore.getState().mediaRetentionDays).toBe(7);
    expect(mockSweepNow).toHaveBeenCalledTimes(1);
  });

  it("does not sweep when the window gets longer", async () => {
    useSettingsStore.setState({ mediaRetentionDays: 7 });
    await renderScreen();
    await pickRetention(30);

    expect(useSettingsStore.getState().mediaRetentionDays).toBe(30);
    expect(mockSweepNow).not.toHaveBeenCalled();
  });
});

// The tick is a glyph a screen reader skips, so the choice has to be in the
// option's state, as the retention sheet already has it.
describe("the option sheets", () => {
  it("announce the current undo window as selected", async () => {
    useSettingsStore.setState({ undoSendSeconds: 10 });
    await renderScreen();
    await userEvent.setup().press(screen.getByText(t("settings.general.undo")));

    const name = (
      key: "settings.general.undo_2" | "settings.general.undo_10",
    ) => t("settings.general.undo_a11y", { value: t(key) });
    expect(
      screen.getByRole("button", { name: name("settings.general.undo_10") }),
    ).toBeSelected();
    expect(
      screen.getByRole("button", { name: name("settings.general.undo_2") }),
    ).not.toBeSelected();
  });

  it("announce the current upload quality as selected", async () => {
    useSettingsStore.setState({ uploadQuality: "medium" });
    await renderScreen();
    await userEvent
      .setup()
      .press(screen.getByText(t("settings.general.quality")));

    expect(
      screen.getByRole("button", {
        name: t("settings.general.quality_a11y", {
          value: t("settings.general.quality_medium"),
        }),
      }),
    ).toBeSelected();
  });
});
