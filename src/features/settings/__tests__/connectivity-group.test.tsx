// The hub's "Mesh bridge needs location" row. Its Grant has to do something in
// every permission state: a refusal the OS will not ask about again makes the
// request a silent no-op, so there it explains Settings instead, through the
// same turnOnLocation the Location off banners use.

import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { render, screen, userEvent } from "@testing-library/react-native";
import type React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ConnectivityGroup from "../connectivity-group";

// The first render loads the icon font and the settings primitives, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

const mockRefreshGeoChannels = jest.fn();
jest.mock("@services/mesh-service", () => ({
  getMeshService: () => ({
    refreshGeoChannels: () => mockRefreshGeoChannels(),
    retryRadios: () => undefined,
  }),
}));

let mockPermission = { granted: false, canAskAgain: true };
const mockRequest = jest.fn<Promise<boolean>, []>();
jest.mock("@services/location-service", () => ({
  locationPermissionState: () => Promise.resolve(mockPermission),
  requestLocationPermission: () => mockRequest(),
}));

const mockShowBlockedAlert = jest.fn();
jest.mock("@platform/permissions", () => ({
  showBlockedAlert: () => mockShowBlockedAlert(),
}));

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
  useSettingsStore.setState({ bridgeEnabled: true, internetEnabled: true });
  useMeshStateStore.setState({ locationGranted: false });
  mockPermission = { granted: false, canAskAgain: true };
  mockRequest.mockReset();
  mockRefreshGeoChannels.mockReset();
  mockShowBlockedAlert.mockReset();
});

async function pressGrant(): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ConnectivityGroup onOpenTor={() => {}} />
    </SafeAreaProvider>,
  );
  await userEvent
    .setup()
    .press(
      screen.getByRole("button", { name: t("settings.conn.grant_location") }),
    );
}

describe("granting location for the bridge", () => {
  it("asks, and re-resolves the bridge cell on a yes", async () => {
    mockRequest.mockResolvedValue(true);
    await pressGrant();

    expect(mockRequest).toHaveBeenCalled();
    expect(mockShowBlockedAlert).not.toHaveBeenCalled();
    expect(mockRefreshGeoChannels).toHaveBeenCalled();
    expect(useMeshStateStore.getState().locationGranted).toBe(true);
  });

  it("explains Settings when the OS will not ask again", async () => {
    mockPermission = { granted: false, canAskAgain: false };
    await pressGrant();

    expect(mockShowBlockedAlert).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
