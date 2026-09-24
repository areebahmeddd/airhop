/**
 * @jest-environment node
 */
// Every Leave and Delete surface goes through leaveConversation, so these pin
// what it owes each kind of conversation, and what its confirmation says first.

const mockLeave = jest.fn();
const mockRemoveChannel = jest.fn();
const mockDismiss = jest.fn((_channel: string) => Promise.resolve());

jest.mock("@store/group-store", () => ({
  useGroupStore: { getState: () => ({ leave: mockLeave }) },
}));
jest.mock("@store/chat-store", () => ({
  useChatStore: { getState: () => ({ removeChannel: mockRemoveChannel }) },
}));
jest.mock("@services/notification-service", () => ({
  // Through a closure: the factory runs before this file's consts do.
  dismissNotificationsFor: (channel: string) => mockDismiss(channel),
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };
const mockShowAlert = jest.fn(
  (_title: string, _body: string, _buttons: AlertButton[]) => undefined,
);
let mockIsCreator = false;
jest.mock("@store/alert-store", () => ({
  showAlert: (title: string, body: string, buttons: AlertButton[]) =>
    mockShowAlert(title, body, buttons),
}));
jest.mock("@services/mesh-service", () => ({
  getMeshService: () => ({ isGroupCreator: () => mockIsCreator }),
}));
// Keys stand in for copy, so each assertion names the string it expects.
jest.mock("@i18n", () => ({ t: (key: string) => key }));

import {
  confirmLeaveConversation,
  leaveConversation,
} from "../leave-conversation";

beforeEach(() => {
  mockLeave.mockClear();
  mockRemoveChannel.mockClear();
  mockDismiss.mockClear();
  mockShowAlert.mockClear();
  mockIsCreator = false;
});

function lastAlert(): { title: string; body: string; buttons: AlertButton[] } {
  const [title, body, buttons] = mockShowAlert.mock.calls.at(-1)!;
  return { title, body, buttons };
}

describe("leaveConversation", () => {
  it("drops a group's key as well as its chat row", () => {
    leaveConversation("group:00ff");
    expect(mockLeave).toHaveBeenCalledWith("00ff");
    expect(mockRemoveChannel).toHaveBeenCalledWith("group:00ff");
  });

  it.each(["#mesh", "dm:aabbccdd00112233", "geohash:u4pruy"])(
    "leaves %s without touching the group store",
    (channel) => {
      leaveConversation(channel);
      expect(mockLeave).not.toHaveBeenCalled();
      expect(mockRemoveChannel).toHaveBeenCalledWith(channel);
    },
  );

  it("clears the conversation's delivered notification", () => {
    // Tapping one afterwards would open an empty thread under its name.
    leaveConversation("dm:aabbccdd00112233");
    expect(mockDismiss).toHaveBeenCalledWith("dm:aabbccdd00112233");
  });
});

describe("confirmLeaveConversation", () => {
  it("leaves nothing until the user confirms", () => {
    const onLeft = jest.fn();
    confirmLeaveConversation("#mesh", "#mesh", onLeft);
    expect(mockRemoveChannel).not.toHaveBeenCalled();

    const { title, body, buttons } = lastAlert();
    expect(title).toBe("chat.channels.leave");
    expect(body).toBe("chat.channels.leave_body");
    buttons.find((b) => b.style === "destructive")!.onPress!();
    expect(mockRemoveChannel).toHaveBeenCalledWith("#mesh");
    expect(onLeft).toHaveBeenCalled();
  });

  it("does nothing on cancel", () => {
    const onLeft = jest.fn();
    confirmLeaveConversation("group:00ff", "Hikers", onLeft);
    lastAlert()
      .buttons.find((b) => b.style === "cancel")!
      .onPress?.();
    expect(mockLeave).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("tells a group's creator that nobody can manage it after they leave", () => {
    mockIsCreator = true;
    confirmLeaveConversation("group:00ff", "Hikers");
    const { title, body } = lastAlert();
    expect(title).toBe("chat.info.leave_group");
    expect(body).toBe("chat.group.leave_creator_body");
  });

  it("gives an ordinary member the usual confirmation", () => {
    confirmLeaveConversation("group:00ff", "Hikers");
    expect(lastAlert().body).toBe("chat.channels.leave_body");
  });
});
