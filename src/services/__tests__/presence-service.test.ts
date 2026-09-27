/**
 * @jest-environment node
 */
// Presence is the one setting that starts and stops radios, and it is reachable
// from three places: the Status picker, the Mesh banner's Resume button, and
// "Stop mesh" on the Android notification. What matters is that the mesh ends up
// in the state the label claims, by whatever route the user took to get there.
//
// The route easiest to miss is Invisible, then Away, then Online.
// Discoverability is intent the radio controller holds across a stop, on
// purpose (an outage must not make an Invisible user discoverable when the
// radio comes back), so Online has to re-state it whatever it came from.
// Cleared only on the edge from Invisible, coming back through Away would
// restart scanning and relaying but never advertising: nobody could see the
// phone, the profile dot would say Online, and no banner would disagree.

const mockStart = jest.fn<void, [string]>();
const mockStop = jest.fn<void, []>();
const mockSetDiscoverable = jest.fn<void, [boolean]>();

jest.mock("../mesh-service", () => ({
  __esModule: true,
  getMeshService: () => ({
    start: (nickname: string) => mockStart(nickname),
    stop: () => mockStop(),
    setDiscoverable: (on: boolean) => mockSetDiscoverable(on),
  }),
}));

import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { applyPresence, applyStartupPresence } from "../presence-service";

beforeEach(() => {
  mockStart.mockReset();
  mockStop.mockReset();
  mockSetDiscoverable.mockReset();
  useMeshStateStore.getState().setPresenceStatus("online");
  useSettingsStore.getState().reset();
});

describe("presence transitions", () => {
  test("Invisible stops advertising without stopping the mesh", () => {
    applyPresence("invisible", "someone");
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockSetDiscoverable).toHaveBeenCalledWith(false);
    expect(useMeshStateStore.getState().presenceStatus).toBe("invisible");
  });

  test("Away stops the whole mesh", () => {
    applyPresence("away", "someone");
    expect(mockStop).toHaveBeenCalled();
    expect(useMeshStateStore.getState().presenceStatus).toBe("away");
  });

  test("Online after Away restarts the mesh and is discoverable", () => {
    applyPresence("away", "someone");
    applyPresence("online", "someone");
    expect(mockStart).toHaveBeenCalledWith("someone");
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(true);
  });

  test("Invisible, then Away, then Online leaves the phone discoverable", () => {
    applyPresence("invisible", "someone");
    applyPresence("away", "someone");
    applyPresence("online", "someone");

    // Restarting alone is not enough: the mesh would scan and relay while the
    // controller still held the Invisible choice, advertising to nobody while
    // reporting itself Online.
    expect(mockStart).toHaveBeenCalledWith("someone");
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(true);
    expect(useMeshStateStore.getState().presenceStatus).toBe("online");
  });

  test("Invisible survives Away and back", () => {
    applyPresence("invisible", "someone");
    applyPresence("away", "someone");
    applyPresence("invisible", "someone");
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(false);
    expect(useMeshStateStore.getState().presenceStatus).toBe("invisible");
  });
});

// What the next launch starts in. Invisible is about who can see the phone, so
// it has to survive a reopen, the language restart and a boot start. Away only
// pauses this session: opening Airhop again means wanting the mesh.
describe("presence across a relaunch", () => {
  test("a start after Invisible comes back Invisible, not advertising", () => {
    applyPresence("invisible", "someone");
    mockSetDiscoverable.mockReset();
    useMeshStateStore.getState().setPresenceStatus("online");

    applyStartupPresence();
    expect(mockSetDiscoverable).toHaveBeenCalledWith(false);
    expect(useMeshStateStore.getState().presenceStatus).toBe("invisible");
  });

  test("Online clears the kept Invisible", () => {
    applyPresence("invisible", "someone");
    applyPresence("online", "someone");

    applyStartupPresence();
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(true);
    expect(useMeshStateStore.getState().presenceStatus).toBe("online");
  });

  test("Away is not kept, and leaves the last visibility in place", () => {
    applyPresence("away", "someone");
    applyStartupPresence();
    expect(useMeshStateStore.getState().presenceStatus).toBe("online");

    applyPresence("invisible", "someone");
    applyPresence("away", "someone");
    applyStartupPresence();
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(false);
    expect(useMeshStateStore.getState().presenceStatus).toBe("invisible");
  });

  test("a panic wipe's settings reset comes back Online", () => {
    applyPresence("invisible", "someone");
    useSettingsStore.getState().reset();

    applyStartupPresence();
    expect(mockSetDiscoverable).toHaveBeenLastCalledWith(true);
    expect(useMeshStateStore.getState().presenceStatus).toBe("online");
  });
});
