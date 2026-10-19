// The Photos row stands for two grants: reading the library, which sending from
// it needs, and adding to it, which saving needs. It reads allowed only when
// both are.
//
// A screen reader reaches each switch on its own, so the switch carries its
// row's name, and its hint says where a flip goes.

import { t } from "@i18n";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import PermissionsScreen from "../permissions-screen";

// The first render loads the icon font and the whole settings tree, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

interface Grant {
  granted: boolean;
  canAskAgain: boolean;
}

const GRANTED: Grant = { granted: true, canAskAgain: true };
const ASKABLE: Grant = { granted: false, canAskAgain: true };
const BLOCKED: Grant = { granted: false, canAskAgain: false };

const mockGrants = { library: GRANTED, save: GRANTED };
const mockRequestLibrary = jest.fn(() => Promise.resolve(GRANTED));
const mockRequestSave = jest.fn(() => Promise.resolve(GRANTED));

jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));
jest.mock("@platform/ble-permissions", () => ({
  hasBlePermissions: () => Promise.resolve(true),
  ensureBlePermissions: jest.fn(),
}));
jest.mock("@services/location-service", () => ({
  locationPermissionState: () =>
    Promise.resolve({ granted: true, canAskAgain: true }),
  requestLocationPermission: jest.fn(),
}));
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: () =>
    Promise.resolve({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock("expo-camera", () => ({
  Camera: {
    getCameraPermissionsAsync: () =>
      Promise.resolve({ granted: true, canAskAgain: true }),
    getMicrophonePermissionsAsync: () =>
      Promise.resolve({ granted: true, canAskAgain: true }),
    requestCameraPermissionsAsync: jest.fn(),
    requestMicrophonePermissionsAsync: jest.fn(),
  },
}));
jest.mock("expo-image-picker", () => ({
  getMediaLibraryPermissionsAsync: () => Promise.resolve(mockGrants.library),
  requestMediaLibraryPermissionsAsync: () => {
    mockGrants.library = GRANTED;
    return mockRequestLibrary();
  },
}));
jest.mock("expo-media-library", () => ({
  getPermissionsAsync: () => Promise.resolve(mockGrants.save),
  requestPermissionsAsync: () => {
    mockGrants.save = GRANTED;
    return mockRequestSave();
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  mockGrants.library = GRANTED;
  mockGrants.save = GRANTED;
  mockRequestLibrary.mockClear();
  mockRequestSave.mockClear();
});

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PermissionsScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
  // The first read is deferred a tick and resolves through the mocked OS.
  await screen.findAllByRole("switch");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Every other permission is granted, so the only switch left off is Photos.
function offSwitches() {
  return screen
    .getAllByRole("switch")
    .filter((s) => (s.props as { value?: boolean }).value !== true);
}

describe("the Photos row", () => {
  it("is on when both reading and saving are allowed", async () => {
    await renderScreen();
    expect(offSwitches()).toHaveLength(0);
  });

  it("is off while sending from the library is refused, even with saving allowed", async () => {
    mockGrants.library = BLOCKED;
    await renderScreen();
    expect(offSwitches()).toHaveLength(1);
  });

  it("asks for the library read when that is the grant still open", async () => {
    mockGrants.library = ASKABLE;
    await renderScreen();
    const [photos] = offSwitches();

    await fireEvent(photos, "valueChange", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRequestLibrary).toHaveBeenCalledTimes(1);
    expect(mockRequestSave).not.toHaveBeenCalled();
  });
});

describe("the Photos switch, to a screen reader", () => {
  it("is named after its row and offers the prompt while one can be shown", async () => {
    mockGrants.library = ASKABLE;
    await renderScreen();

    const photos = screen.getByRole("switch", {
      name: t("settings.permissions.photos"),
    });
    expect(photos).not.toBeChecked();
    expect(photos).toBeEnabled();
    expect(photos).toHaveProp(
      "accessibilityHint",
      t("settings.permissions.allow"),
    );
  });

  it("points at system settings once the OS will not ask again", async () => {
    mockGrants.library = BLOCKED;
    await renderScreen();

    expect(
      screen.getByRole("switch", { name: t("settings.permissions.photos") }),
    ).toHaveProp("accessibilityHint", t("settings.permissions.open_settings"));
  });
});
