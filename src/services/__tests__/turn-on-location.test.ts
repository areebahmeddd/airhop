// The "Turn on" behind every location prompt: it asks while the OS will
// still ask, explains Settings once it will not, and acts on a grant rather
// than only recording it.

import { useMeshStateStore } from "@store/mesh-state-store";
import { turnOnLocation } from "../turn-on-location";

const mockState = { granted: false, canAskAgain: true };
const mockRequest = jest.fn<Promise<boolean>, []>();
const mockShowBlockedAlert = jest.fn();
const mockMesh = {
  refreshGeoChannels: jest.fn(),
  retryRadios: jest.fn(),
};

jest.mock("../location-service", () => ({
  locationPermissionState: () => Promise.resolve({ ...mockState }),
  requestLocationPermission: () => mockRequest(),
}));
jest.mock("../mesh-service", () => ({ getMeshService: () => mockMesh }));
jest.mock("@platform/permissions", () => ({
  showBlockedAlert: (copy: unknown) => mockShowBlockedAlert(copy),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockState.granted = false;
  mockState.canAskAgain = true;
  useMeshStateStore.setState({ locationGranted: false });
});

describe("turnOnLocation", () => {
  it("asks, and on a grant records it and re-resolves the channels", async () => {
    mockRequest.mockResolvedValue(true);
    await expect(turnOnLocation()).resolves.toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(useMeshStateStore.getState().locationGranted).toBe(true);
    expect(mockMesh.refreshGeoChannels).toHaveBeenCalledTimes(1);
    expect(mockMesh.retryRadios).toHaveBeenCalledTimes(1);
    expect(mockShowBlockedAlert).not.toHaveBeenCalled();
  });

  // Saying no to the dialog just shown is an answer; a second box on top of it
  // would be nagging. The banner stays up for the next tap.
  it("leaves a declined prompt alone", async () => {
    mockRequest.mockResolvedValue(false);
    await expect(turnOnLocation()).resolves.toBe(false);
    expect(useMeshStateStore.getState().locationGranted).toBe(false);
    expect(mockMesh.refreshGeoChannels).not.toHaveBeenCalled();
    expect(mockShowBlockedAlert).not.toHaveBeenCalled();
  });

  // A request the OS will not show is a silent no-op, so Settings is the only
  // way left, and the alert carries the deep link there.
  it("explains Settings instead of asking once the OS will not ask", async () => {
    mockState.canAskAgain = false;
    await expect(turnOnLocation()).resolves.toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockShowBlockedAlert).toHaveBeenCalledWith({
      label: "Location access",
      purpose: "reach location channels beyond Bluetooth range",
    });
    expect(mockMesh.refreshGeoChannels).not.toHaveBeenCalled();
  });

  // The store can lag a grant made elsewhere (the resume has not run yet), and
  // the tap should catch it up rather than prompt for what is already given.
  it("catches the store up to a grant it missed without prompting", async () => {
    mockState.granted = true;
    mockState.canAskAgain = false;
    await expect(turnOnLocation()).resolves.toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(useMeshStateStore.getState().locationGranted).toBe(true);
    expect(mockMesh.refreshGeoChannels).toHaveBeenCalledTimes(1);
  });
});
