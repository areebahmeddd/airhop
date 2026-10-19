// The contact sheet's ring grant has to say when the Privacy & security
// master switch overrides it: with Ring alerts off every ring is refused, and a
// row still reading "let them ring your phone" would promise one.

import { t } from "@i18n";
import { useContactsStore } from "@store/contacts-store";
import { useSettingsStore } from "@store/settings-store";
import { act, render, screen } from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ContactInfoSheet from "../contact-info-sheet";

// The first render loads the icon font and the sheet's whole tree.
jest.setTimeout(30_000);

jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));

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

// Animated with Reanimated, which has no native half under jest either.
jest.mock("@ui/components/copy-glyph", () => ({
  __esModule: true,
  default: () => null,
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const PEER = "a1b2c3d4e5f60718";

beforeEach(() => {
  useContactsStore.setState({
    contacts: {
      [PEER]: {
        peerID: PEER,
        noisePubKeyHex: "11".repeat(32),
        signingPubKeyHex: "22".repeat(32),
        nickname: "alice",
        addedAtMs: 1_700_000_000_000,
        source: "qr",
        allowRing: true,
      },
    },
  });
});

async function renderSheet(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ContactInfoSheet channel={`dm:${PEER}`} onClose={() => {}} />
    </SafeAreaProvider>,
  );
  // The sheet reads the clock a tick after opening.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

it("describes the grant while Ring alerts are on", async () => {
  useSettingsStore.setState({ ringAlertsEnabled: true });
  await renderSheet();
  expect(screen.getByText(t("chat.contact.allow_ring_desc"))).toBeTruthy();
});

it("says the master switch refuses every ring while it is off", async () => {
  useSettingsStore.setState({ ringAlertsEnabled: false });
  await renderSheet();
  expect(screen.queryByText(t("chat.contact.allow_ring_desc"))).toBeNull();
  expect(
    screen.getByText(
      t("chat.contact.allow_ring_master_off", {
        setting: t("settings.security.ring_alerts"),
      }),
    ),
  ).toBeTruthy();
});
