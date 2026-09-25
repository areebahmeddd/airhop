// The Version screen talks to GitHub, which the internet switch promises it
// will not do while "Bluetooth only" is on. These pin that promise for both the
// check and the download, on the screen itself rather than on a helper, since
// the screen is where a request would actually be made.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import PrimaryButton from "@ui/components/primary-button";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import VersionScreen, { updateNetworkBlock } from "../version-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

const mockCreateDownloadTask = jest.fn<unknown, unknown[]>();

jest.mock("expo-file-system", () => ({
  File: class {
    static createDownloadTask: (...args: unknown[]) => unknown = (...args) =>
      mockCreateDownloadTask(...args);
    exists = false;
    delete(): void {}
  },
  Paths: { cache: "cache" },
}));

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(),
}));

const fetchMock = jest.fn();

const NEWER_RELEASE = {
  ok: true,
  json: () =>
    Promise.resolve({
      tag_name: "v99.0.0",
      html_url: "https://github.com/areebahmeddd/airhop/releases/tag/v99.0.0",
      assets: [
        {
          name: "airhop.apk",
          browser_download_url: "https://github.com/releases/airhop.apk",
        },
      ],
    }),
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

let screen: ReactTestRenderer | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  mockCreateDownloadTask.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  useSettingsStore.setState({ internetEnabled: true, torEnabled: false });
  useMeshStateStore.setState({ torActive: false });
  jest.replaceProperty(Platform, "OS", "android");
});

afterEach(() => {
  act(() => screen?.unmount());
  screen = null;
  jest.restoreAllMocks();
});

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    screen = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <VersionScreen onBack={() => {}} />
      </SafeAreaProvider>,
    );
  });
  return screen as unknown as ReactTestRenderer;
}

async function tapButton(r: ReactTestRenderer): Promise<void> {
  await act(async () => {
    r.root.findByType(PrimaryButton).props.onPress();
    await Promise.resolve();
  });
}

function shows(r: ReactTestRenderer, text: string): boolean {
  return JSON.stringify(r.toJSON()).includes(JSON.stringify(text).slice(1, -1));
}

const internetOffLine = (): string =>
  t("settings.version.internet_off", {
    setting: t("settings.network.internet"),
  });

describe("with the internet off", () => {
  it("does not ask GitHub, and says why", async () => {
    useSettingsStore.setState({ internetEnabled: false });
    const r = await render();

    await tapButton(r);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(shows(r, internetOffLine())).toBe(true);
  });

  it("does not download an update found before the internet went off", async () => {
    fetchMock.mockResolvedValue(NEWER_RELEASE);
    const r = await render();
    await tapButton(r);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ internetEnabled: false });
    await tapButton(r);

    expect(mockCreateDownloadTask).not.toHaveBeenCalled();
    expect(shows(r, internetOffLine())).toBe(true);
  });
});

describe("the gate", () => {
  it("refuses with the internet off on both platforms", () => {
    useSettingsStore.setState({ internetEnabled: false });
    expect(updateNetworkBlock()).toBe("internet-off");
    jest.replaceProperty(Platform, "OS", "ios");
    expect(updateNetworkBlock()).toBe("internet-off");
  });

  // Only iOS: Android's download and check ride Tor.
  it("refuses a Tor claim on iOS only", () => {
    useSettingsStore.setState({ torEnabled: true });
    expect(updateNetworkBlock()).toBeNull();
    jest.replaceProperty(Platform, "OS", "ios");
    expect(updateNetworkBlock()).toBe("tor");
  });

  it("allows the request otherwise", () => {
    expect(updateNetworkBlock()).toBeNull();
  });
});
