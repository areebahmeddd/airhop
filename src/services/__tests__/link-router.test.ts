/**
 * @jest-environment node
 */
// What an airhop:// channel link joins. A private invite must never land in
// the public room of the same name, where the user would talk in the clear.

jest.mock("../mesh-service", () => ({ getMeshService: () => null }));

import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import { useChatStore } from "@store/chat-store";
import { applyAirhopLink } from "../link-router";

beforeEach(() => {
  useChatStore.getState().clearAll();
});

test("a valid invite joins the private channel", () => {
  const key = generateChannelKey();
  const channel = applyAirhopLink({
    kind: "channel",
    channel: "#crew",
    key,
    overNostr: false,
  });
  expect(channel).not.toBeNull();
  expect(useChatStore.getState().channelKeys[channel ?? ""]).toBe(key);
});

test("an invite with a malformed key joins nothing", () => {
  const channel = applyAirhopLink({
    kind: "channel",
    channel: "#crew",
    key: "not-a-key",
    overNostr: false,
  });
  expect(channel).toBeNull();
  expect(useChatStore.getState().channels).not.toContain("#crew");
});

test("a link without a key joins the public room", () => {
  expect(
    applyAirhopLink({ kind: "channel", channel: "#crew", overNostr: false }),
  ).toBe("#crew");
  expect(useChatStore.getState().channels).toContain("#crew");
});
