// The Network screen. A disabled switch has to say why, every switch has to
// tell a screen reader which setting it is and whether it is on, and a status
// row has to say what the transport is doing now, not what it was doing before
// the mesh stopped.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NetworkScreen from "../network-screen";

// The first render loads the icon font and the settings primitives, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  useSettingsStore.setState({
    internetEnabled: true,
    wifiAwareEnabled: true,
    lanTransportEnabled: false,
  });
  useMeshStateStore.setState({
    wifiFastPath: "active",
    lanState: "off",
    wifiPairingSupported: false,
  });
});

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <NetworkScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
}

describe("a transport this device cannot run", () => {
  it("says so under the disabled Wi-Fi Aware switch", async () => {
    useMeshStateStore.setState({ wifiFastPath: "unsupported" });
    await renderScreen();

    expect(
      screen.getByText(t("settings.diag.wifi_unsupported")),
    ).toBeOnTheScreen();
    const wifiAware = screen.getByRole("switch", {
      name: t("settings.network.wifi_aware"),
    });
    expect(wifiAware).toBeDisabled();
    expect(wifiAware).not.toBeChecked();
  });

  it("says so under the disabled LAN switch, even while it is off", async () => {
    useMeshStateStore.setState({ lanState: "unsupported" });
    await renderScreen();

    expect(
      screen.getByText(t("settings.network.lan_unsupported")),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("switch", { name: t("settings.network.lan") }),
    ).toBeDisabled();
  });

  // The latch is set by a start that failed, so the user had turned it on.
  it("shows the LAN switch off once the start has failed for good", async () => {
    useSettingsStore.setState({ lanTransportEnabled: true });
    useMeshStateStore.setState({ lanState: "unsupported" });
    await renderScreen();

    const lan = screen.getByRole("switch", { name: t("settings.network.lan") });
    expect(lan).toBeDisabled();
    expect(lan).not.toBeChecked();
    expect(
      screen.getByText(t("settings.network.lan_unsupported")),
    ).toBeOnTheScreen();
  });
});

// The row is not focusable, so a screen reader reaches each switch on its own
// and it has to carry the row's name.
describe("every switch on the screen", () => {
  it("is named after its row", async () => {
    await renderScreen();

    const names = screen
      .getAllByRole("switch")
      .map(
        (s) => (s.props as { accessibilityLabel?: string }).accessibilityLabel,
      );
    expect(names).toEqual([
      t("settings.network.internet"),
      t("settings.network.discovery"),
      t("settings.network.bitchat"),
      t("settings.network.wifi_aware"),
      t("settings.network.lan"),
    ]);
  });

  it("reports its state, a locked one as on and disabled", async () => {
    await renderScreen();

    const internet = screen.getByRole("switch", {
      name: t("settings.network.internet"),
    });
    expect(internet).toBeChecked();
    expect(internet).toBeEnabled();
    const bitchat = screen.getByRole("switch", {
      name: t("settings.network.bitchat"),
    });
    expect(bitchat).toBeChecked();
    expect(bitchat).toBeDisabled();
  });
});

describe("Wi-Fi Aware's status while the mesh is stopped", () => {
  it("reads off, not as waiting for a radio", async () => {
    useMeshStateStore.setState({ wifiFastPath: "off" });
    await renderScreen();

    expect(screen.getByText(t("common.off"))).toBeOnTheScreen();
    expect(
      screen.queryByText(t("settings.diag.wifi_unknown")),
    ).not.toBeOnTheScreen();
  });
});
