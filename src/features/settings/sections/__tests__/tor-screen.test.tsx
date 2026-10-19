// The Tor screen's status row, which has to say what the client is actually
// doing, and its Connection section, which stays with Tor off so the first
// connection can already go through a bridge. The internet switch stops Arti
// on purpose, and reading that as a start in progress would promise a
// connection nothing is making.

import { t, upperCase } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
} from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import TorScreen from "../tor-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

// The screen reaches it only through tor-routing, and it needs the BLE module.
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

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  useSettingsStore.setState({
    internetEnabled: true,
    torEnabled: true,
    torBridgeMode: "off",
    torBridgeLines: "",
    torStartPending: false,
  });
  useMeshStateStore.setState({ torActive: false, torBootstrap: "idle" });
});

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <TorScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
}

// Cased the way UpperText draws it.
function connectionTitle() {
  return screen.queryByText(upperCase(t("settings.tor.connection"), "en"));
}

// The editor shares its label with the Custom bridges option above it.
function customEditor() {
  return screen.queryByPlaceholderText(t("settings.tor.custom_placeholder"));
}

// Through the switch and its confirm sheet, the way a user turns Tor off.
async function turnTorOff(): Promise<void> {
  await fireEvent(screen.getByRole("switch"), "valueChange", false);
  await userEvent
    .setup()
    .press(screen.getByRole("button", { name: t("settings.conn.turn_off") }));
}

describe("the status row", () => {
  it("says the internet is off rather than that Tor is starting", async () => {
    useSettingsStore.setState({ internetEnabled: false });
    await renderScreen();

    expect(screen.getByText(t("settings.conn.internet_off"))).toBeOnTheScreen();
    // A substring match, so the line cannot hide inside a longer one.
    expect(
      screen.queryByText(t("mesh.banner.tor_starting"), { exact: false }),
    ).not.toBeOnTheScreen();
  });

  it("says Tor is starting while a bootstrap runs", async () => {
    useMeshStateStore.setState({ torBootstrap: "starting" });
    await renderScreen();

    expect(screen.getByText(t("mesh.banner.tor_starting"))).toBeOnTheScreen();
  });

  it("stays, saying off, while Tor is off", async () => {
    useSettingsStore.setState({ torEnabled: false });
    await renderScreen();

    expect(screen.getByText(t("settings.tor.status"))).toBeOnTheScreen();
    expect(screen.getByText(t("common.off"))).toBeOnTheScreen();
  });
});

describe("the connection section", () => {
  it("stays with Tor off, so a bridge can be picked before connecting", async () => {
    useSettingsStore.setState({ torEnabled: false });
    await renderScreen();

    expect(connectionTitle()).toBeOnTheScreen();
    expect(
      screen.getByText(t("settings.tor.connection_off_note")),
    ).toBeOnTheScreen();

    await userEvent
      .setup()
      .press(
        screen.getByRole("button", { name: t("settings.tor.mode_snowflake") }),
      );

    expect(useSettingsStore.getState().torBridgeMode).toBe("snowflake");
    // Saved for the next turn on, not started now.
    expect(useSettingsStore.getState().torEnabled).toBe(false);
  });

  it("offers the custom editor with Tor off once Custom is picked", async () => {
    useSettingsStore.setState({ torEnabled: false, torBridgeMode: "custom" });
    await renderScreen();

    expect(customEditor()).toBeOnTheScreen();
  });

  it("is shown while Tor is connected, without the off note", async () => {
    useMeshStateStore.setState({ torActive: true });
    await renderScreen();

    expect(connectionTitle()).toBeOnTheScreen();
    expect(
      screen.getByText(t("settings.tor.mode_snowflake")),
    ).toBeOnTheScreen();
    expect(
      screen.queryByText(t("settings.tor.connection_off_note")),
    ).not.toBeOnTheScreen();
  });

  // Each of these is a moment to change transport, so none may hide it.
  it.each([
    ["connecting", { torBootstrap: "starting" as const }, false],
    ["blocked", { torBootstrap: "blocked" as const }, false],
    ["held after a crashed start", { torBootstrap: "blocked" as const }, true],
  ])("is shown and usable while Tor is %s", async (_, mesh, pending) => {
    useSettingsStore.setState({ torStartPending: pending });
    useMeshStateStore.setState(mesh);
    await renderScreen();

    if (pending) {
      expect(screen.getByText(t("settings.tor.recovered"))).toBeOnTheScreen();
    }
    expect(connectionTitle()).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: t("settings.tor.mode_obfs4") }),
    ).toBeEnabled();
  });

  it("keeps the chosen transport across off and on", async () => {
    useSettingsStore.setState({ torBridgeMode: "snowflake" });
    await renderScreen();

    await turnTorOff();
    expect(useSettingsStore.getState().torEnabled).toBe(false);
    expect(
      screen.getByRole("button", { name: t("settings.tor.mode_snowflake") }),
    ).toBeSelected();

    // Turned back on the way the routing service does it, since the native
    // client it starts does not exist under jest.
    await act(async () => {
      useSettingsStore.getState().setTorEnabled(true);
    });

    expect(
      screen.getByRole("button", { name: t("settings.tor.mode_snowflake") }),
    ).toBeSelected();
    expect(
      screen.getByRole("button", { name: t("settings.tor.mode_off") }),
    ).not.toBeSelected();
  });
});
