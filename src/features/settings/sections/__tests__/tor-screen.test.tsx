// The Tor screen's status row, which has to say what the client is actually
// doing. The internet switch stops Arti on purpose, and reading that as a start
// in progress would promise a connection nothing is making.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import TorScreen from "../tor-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

// The screen reaches it only through tor-routing, and it needs the BLE module.
jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));

// Reanimated has no native half under jest, and the confirm sheet is closed.
jest.mock("@ui/components/bottom-sheet", () => ({
  __esModule: true,
  default: () => null,
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
});
