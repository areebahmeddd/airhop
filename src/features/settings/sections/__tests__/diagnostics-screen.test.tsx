// Share diagnostics opens the OS share sheet from inside one of ours. iOS drops
// a presentation made while a sheet is still sliding out, and the share's
// promise then never settles, so the OS sheet has to wait for ours to be gone.

import { t } from "@i18n";
import { render, screen, userEvent } from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import DiagnosticsScreen from "../diagnostics-screen";

// The first render loads the icon font and the settings primitives, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));

const mockShare = jest.fn(() => Promise.resolve(true));
jest.mock("@services/diagnostics-export", () => ({
  shareDiagnostics: () => mockShare(),
  getDiagnosticsReport: () => Promise.resolve(""),
}));

// Reanimated has no native half under jest, so the sheet is its contents while
// open. A handoff waits until the test says the sheet has slid out.
let mockWaiting: (() => void)[] = [];
jest.mock("@ui/components/bottom-sheet", () => ({
  __esModule: true,
  default: ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
  }) => (visible ? children : null),
  afterSheetsClose: (open: () => void) => {
    mockWaiting.push(open);
    return () => {};
  },
}));

// The toast animates through Reanimated too, so it is just its message.
jest.mock("@ui/components/toast", () => ({
  __esModule: true,
  default: ({ message }: { message: string | null }) => {
    const { Text } = jest.requireActual("react-native");
    return message === null ? null : <Text>{message}</Text>;
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  mockShare.mockClear();
  mockWaiting = [];
});

it("opens the OS share sheet only once its own sheet has slid out", async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <DiagnosticsScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
  const user = userEvent.setup();
  await user.press(
    screen.getByRole("button", { name: t("settings.diag.share") }),
  );
  await user.press(screen.getByRole("button", { name: t("common.share") }));
  expect(mockShare).not.toHaveBeenCalled();

  for (const open of mockWaiting.splice(0)) open();
  expect(mockShare).toHaveBeenCalledTimes(1);
});
