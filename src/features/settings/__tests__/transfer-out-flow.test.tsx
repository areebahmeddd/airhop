// The old phone's transfer screen around the sender: what happens to a
// transfer when the screen goes away under it, including an erase that lands
// after, and whether a camera grant made in Settings is noticed without leaving
// the tab.

import { t } from "@i18n";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import type React from "react";
import { AppState, type AppStateStatus } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import TransferOutFlow from "../transfer-out-flow";

// The first render loads the icon font and the settings primitives, which can
// take several seconds on a cold CI runner.
jest.setTimeout(30_000);

interface CameraPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: "granted" | "denied" | "undetermined";
}

const DENIED: CameraPermission = {
  granted: false,
  canAskAgain: false,
  status: "denied",
};
const GRANTED: CameraPermission = {
  granted: true,
  canAskAgain: true,
  status: "granted",
};

let mockStoredPermission: CameraPermission = DENIED;
let mockHookPermission: CameraPermission = DENIED;
let mockSetHookPermission: ((p: CameraPermission) => void) | null = null;
const mockGetPermission = jest.fn(() => {
  mockSetHookPermission?.(mockStoredPermission);
  return Promise.resolve(mockStoredPermission);
});
const mockRequestPermission = jest.fn(() =>
  Promise.resolve(mockStoredPermission),
);
let mockOnScanned: ((r: { data: string }) => void) | null = null;

jest.mock("expo-camera", () => {
  const { useState } = jest.requireActual<typeof import("react")>("react");
  return {
    useCameraPermissions: () => {
      const [permission, setPermission] = useState(mockHookPermission);
      mockSetHookPermission = setPermission;
      return [permission, mockRequestPermission, mockGetPermission];
    },
    CameraView: ({
      onBarcodeScanned,
    }: {
      onBarcodeScanned: (r: { data: string }) => void;
    }) => {
      mockOnScanned = onBarcodeScanned;
      return null;
    },
  };
});

jest.mock("@platform/device-auth", () => ({
  confirmDeviceOwner: () => Promise.resolve("passed"),
}));

jest.mock("@core/move/move-invite", () => ({
  decodeMoveInvite: (text: string) =>
    text === "move-code"
      ? { publicKey: new Uint8Array(32), token: new Uint8Array(16) }
      : null,
  isMoveInvite: (text: string) => text === "move-code",
}));

const mockCancel = jest.fn();
let mockSenderChange: ((state: unknown) => void) | null = null;
jest.mock("@services/move-sender", () => ({
  MoveSender: class {
    constructor(
      _invite: unknown,
      _history: boolean,
      hooks: { onChange: (state: unknown) => void },
    ) {
      mockSenderChange = hooks.onChange;
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    cancel(): void {
      mockCancel();
    }
    proceed(): void {}
  },
}));

jest.mock("@services/panic-wipe", () => ({
  panicWipe: () => Promise.resolve({ keysDestroyed: true }),
}));

jest.mock("@services/move-marker", () => ({ clearMoveMarker: () => {} }));

// Reanimated has no native half under jest, so the sheet is its contents while
// open, and a handoff runs at once.
jest.mock("@ui/components/bottom-sheet", () => ({
  __esModule: true,
  default: ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
  }) => (visible ? children : null),
  afterSheetsClose: (open: () => void) => {
    open();
    return () => {};
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

let appStateListener: ((state: AppStateStatus) => void) | null = null;

beforeEach(() => {
  mockCancel.mockReset();
  mockGetPermission.mockClear();
  mockRequestPermission.mockClear();
  mockOnScanned = null;
  mockSenderChange = null;
  appStateListener = null;
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderFlow({
  onErased = () => {},
  onResumeMesh = () => {},
}: {
  onErased?: (keysDestroyed: boolean) => void;
  onResumeMesh?: () => void;
} = {}): Promise<ReturnType<typeof render>> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <TransferOutFlow
        visible
        onClose={() => {}}
        onResumeMesh={onResumeMesh}
        onErased={onErased}
      />
    </SafeAreaProvider>,
  );
}

async function pressContinue(): Promise<void> {
  await userEvent
    .setup()
    .press(screen.getByRole("button", { name: t("common.continue") }));
}

describe("leaving the screen mid-transfer", () => {
  it("cancels the sender, which would otherwise hold the link with no screen", async () => {
    mockStoredPermission = GRANTED;
    mockHookPermission = GRANTED;
    const view = await renderFlow();
    await pressContinue();
    expect(mockOnScanned).not.toBeNull();
    await act(async () => {
      mockOnScanned?.({ data: "move-code" });
    });
    expect(screen.getByText(t("settings.transfer.connecting"))).toBeTruthy();

    await view.unmount();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it("still hands an erase that lands afterwards to the shell, once", async () => {
    mockStoredPermission = GRANTED;
    mockHookPermission = GRANTED;
    const onErased = jest.fn();
    const view = await renderFlow({ onErased });
    await pressContinue();
    await act(async () => {
      mockOnScanned?.({ data: "move-code" });
    });
    // Past the end of the stream, where cancel no longer stops the sender.
    await view.unmount();

    mockSenderChange?.({ phase: "erasing" });
    mockSenderChange?.({ phase: "done", keysDestroyed: true });
    mockSenderChange?.({ phase: "done", keysDestroyed: true });

    expect(onErased).toHaveBeenCalledTimes(1);
    expect(onErased).toHaveBeenCalledWith(true);
  });

  it("keeps this phone on an unconfirmed end, as the next launch would", async () => {
    mockStoredPermission = GRANTED;
    mockHookPermission = GRANTED;
    const onErased = jest.fn();
    const onResumeMesh = jest.fn();
    const view = await renderFlow({ onErased, onResumeMesh });
    await pressContinue();
    await act(async () => {
      mockOnScanned?.({ data: "move-code" });
    });
    await view.unmount();

    mockSenderChange?.({ phase: "unconfirmed" });

    expect(onResumeMesh).toHaveBeenCalledTimes(1);
    expect(onErased).not.toHaveBeenCalled();
  });
});

describe("a camera grant made in Settings", () => {
  it("is read again when the app comes back, replacing the camera-off panel", async () => {
    mockStoredPermission = DENIED;
    mockHookPermission = DENIED;
    await renderFlow();
    await pressContinue();
    expect(screen.getByText(t("contacts.verify.camera_off"))).toBeTruthy();

    mockStoredPermission = GRANTED;
    await act(async () => {
      appStateListener?.("active");
    });
    expect(screen.queryByText(t("contacts.verify.camera_off"))).toBeNull();
    expect(screen.getByText(t("settings.transfer.scan_title"))).toBeTruthy();
  });

  it("is read again when the flow is reopened", async () => {
    mockStoredPermission = GRANTED;
    mockHookPermission = DENIED;
    await renderFlow();
    await pressContinue();
    expect(screen.queryByText(t("contacts.verify.camera_off"))).toBeNull();
    expect(screen.getByText(t("settings.transfer.scan_title"))).toBeTruthy();
  });
});
