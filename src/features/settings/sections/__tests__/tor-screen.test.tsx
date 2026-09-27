// The Tor screen's status row, which has to say what the client is actually
// doing. The internet switch stops Arti on purpose, and reading that as a start
// in progress would promise a connection nothing is making.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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

let screen: ReactTestRenderer | null = null;

beforeEach(() => {
  useSettingsStore.setState({
    internetEnabled: true,
    torEnabled: true,
    torBridgeMode: "off",
    torStartPending: false,
  });
  useMeshStateStore.setState({ torActive: false, torBootstrap: "idle" });
});

afterEach(() => {
  act(() => screen?.unmount());
  screen = null;
});

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    screen = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <TorScreen onBack={() => {}} />
      </SafeAreaProvider>,
    );
  });
  return screen as unknown as ReactTestRenderer;
}

function shows(r: ReactTestRenderer, text: string): boolean {
  return JSON.stringify(r.toJSON()).includes(JSON.stringify(text).slice(1, -1));
}

describe("the status row", () => {
  it("says the internet is off rather than that Tor is starting", async () => {
    useSettingsStore.setState({ internetEnabled: false });
    const r = await render();

    expect(shows(r, t("settings.conn.internet_off"))).toBe(true);
    expect(shows(r, t("mesh.banner.tor_starting"))).toBe(false);
  });

  it("says Tor is starting while a bootstrap runs", async () => {
    useMeshStateStore.setState({ torBootstrap: "starting" });
    const r = await render();

    expect(shows(r, t("mesh.banner.tor_starting"))).toBe(true);
  });
});
