// The Profile hub's sheets. Every sheet is a Modal of its own, and iOS drops
// one presented while another is still sliding out, so a button that swaps one
// sheet for another has to wait for the first to be gone.

import { t } from "@i18n";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ProfileScreen from "../profile-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

jest.mock("@services/mesh-service", () => ({
  getMeshService: () => null,
  destroyMeshService: () => {},
}));

// Reached through tor-routing, which needs the BLE module, and not what this
// suite is about.
jest.mock("../connectivity-group", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@services/panic-wipe", () => ({
  panicWipe: () => Promise.resolve({ keysDestroyed: true }),
}));
jest.mock("@services/presence-service", () => ({ applyPresence: () => {} }));
jest.mock("@services/apk-share", () => ({
  shareApk: () => Promise.resolve({ ok: true }),
}));

// The sections are early returns this suite never opens, and several reach
// native modules at import.
jest.mock("../sections/about-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/diagnostics-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/general-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/help-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/licenses-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/network-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/permissions-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/privacy-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/security-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/storage-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/support-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/terms-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/tor-screen", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../sections/version-screen", () => ({
  __esModule: true,
  default: () => null,
}));

// Reanimated has no native half under jest.
jest.mock("@ui/components/copy-glyph", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("react-native-qrcode-svg", () => ({
  __esModule: true,
  default: () => null,
}));

// Reanimated has no native half under jest, so the sheet is its contents while
// open. A handoff waits until the test says every sheet has slid out.
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

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  mockWaiting = [];
});

it("opens the QR sheet from the peer ID sheet only once that one has gone", async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ProfileScreen peerID="a1b2c3d4e5f60718" username="swift-falcon-a1b2" />
    </SafeAreaProvider>,
  );
  const user = userEvent.setup();
  await user.press(
    screen.getByRole("button", { name: t("settings.share_peer_id") }),
  );
  expect(screen.getByText(t("settings.peer_id_sheet.title"))).toBeTruthy();

  // The hub's own Show QR pill comes first; the sheet's is the last one.
  const showQR = screen.getAllByRole("button", { name: t("settings.qr.show") });
  await user.press(showQR[showQR.length - 1]);
  expect(screen.queryByText(t("settings.peer_id_sheet.title"))).toBeNull();
  expect(screen.queryByText(t("settings.qr.title"))).toBeNull();

  await act(async () => {
    for (const open of mockWaiting.splice(0)) open();
  });
  expect(screen.getByText(t("settings.qr.title"))).toBeTruthy();
});
