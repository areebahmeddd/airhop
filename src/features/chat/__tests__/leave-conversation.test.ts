/**
 * @jest-environment node
 */
// Every Leave and Delete surface goes through leaveConversation, so these pin
// what it owes each kind of conversation.

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

import { leaveConversation } from "../leave-conversation";

beforeEach(() => {
  mockLeave.mockClear();
  mockRemoveChannel.mockClear();
  mockDismiss.mockClear();
});

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
