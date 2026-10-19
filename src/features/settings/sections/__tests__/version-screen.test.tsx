// The Version screen talks to GitHub, which the internet switch promises it
// will not do while "Bluetooth only" is on. These pin that promise for both the
// check and the download, on the screen itself rather than on a helper, since
// the screen is where a request would actually be made.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { render, screen, userEvent } from "@testing-library/react-native";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
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

beforeEach(() => {
  fetchMock.mockReset();
  mockCreateDownloadTask.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  useSettingsStore.setState({ internetEnabled: true, torEnabled: false });
  useMeshStateStore.setState({ torActive: false });
  jest.replaceProperty(Platform, "OS", "android");
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <VersionScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
}

// Case-sensitive substring match: a rich-text sentence splits around its
// nodes, so a catalog fragment is only ever part of a Text's content.
function containing(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const internetOffLine = (): string =>
  t("settings.version.internet_off", {
    setting: t("settings.network.internet"),
  });

describe("with the internet off", () => {
  it("does not ask GitHub, and says why", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ internetEnabled: false });
    await renderScreen();

    await user.press(
      screen.getByRole("button", { name: t("settings.version.check") }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(internetOffLine())).toBeOnTheScreen();
  });

  it("does not download an update found before the internet went off", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(NEWER_RELEASE);
    await renderScreen();
    await user.press(
      screen.getByRole("button", { name: t("settings.version.check") }),
    );
    const updateButton = await screen.findByRole("button", {
      name: t("settings.version.update_to_a11y", { version: "99.0.0" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ internetEnabled: false });
    await user.press(updateButton);

    expect(mockCreateDownloadTask).not.toHaveBeenCalled();
    expect(screen.getByText(internetOffLine())).toBeOnTheScreen();
  });
});

// One sentence from the catalog, so a translator can move the heart and the
// name wherever their language puts them.
describe("the credit line", () => {
  it("renders the catalog sentence around the heart and the author", async () => {
    await renderScreen();

    for (const part of t("settings.version.credit").split(/\{\w+\}/)) {
      if (part.trim() !== "") {
        expect(screen.getByText(containing(part))).toBeOnTheScreen();
      }
    }
    expect(
      screen.getAllByLabelText(t("settings.version.heart_a11y")).length,
    ).toBeGreaterThan(0);
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
