// The full-screen viewer follows its row through a stream's whole life,
// including the rows the receiver merges or drops when the stream ends.

import type { ChatAttachment, ChatMessage } from "@store/chat-store";
import {
  liveVideoViewerState,
  type LiveVideoViewerTarget,
} from "../live-video-viewer-state";

const SENDER = "a1b2c3d4e5f60718";
const STREAM = "0102030405060708";
const BASE = `live-video-${SENDER}-${STREAM}`;

const target: LiveVideoViewerTarget = {
  channel: "#bluetooth",
  rowID: BASE,
  senderID: SENDER,
  streamID: STREAM,
};

function recording(name = `video_${STREAM}.mp4`): ChatAttachment {
  return { type: "video", uri: `file:///cache/${name}`, name };
}

function row(
  id: string,
  fields: Pick<ChatMessage, "liveVideo" | "attachment">,
  senderID = SENDER,
): ChatMessage {
  return {
    id,
    channel: target.channel,
    senderID,
    senderNickname: "alice",
    text: "",
    timestampMs: 0,
    isMine: false,
    ...fields,
  };
}

const live = {
  streamID: STREAM,
  state: "live" as const,
  startedAtMs: 0,
  width: 240,
  height: 320,
  hasAudio: true,
};

describe("liveVideoViewerState", () => {
  test("a live row is live, and says when it is reconnecting", () => {
    expect(
      liveVideoViewerState([row(BASE, { liveVideo: live })], target),
    ).toEqual({ kind: "live", rowID: BASE, live });
    const quiet = { ...live, state: "reconnecting" as const };
    expect(
      liveVideoViewerState([row(BASE, { liveVideo: quiet })], target),
    ).toEqual({ kind: "live", rowID: BASE, live: quiet });
  });

  test("a stream that resumes after its close is followed to its new row", () => {
    const resumed = `${BASE}-1700000000000`;
    expect(
      liveVideoViewerState(
        [
          row(BASE, { attachment: recording() }),
          row(resumed, { liveVideo: live }),
        ],
        target,
      ),
    ).toEqual({ kind: "live", rowID: resumed, live });
  });

  test("an ended stream replays the recording its row now carries", () => {
    const file = recording();
    expect(
      liveVideoViewerState([row(BASE, { attachment: file })], target),
    ).toEqual({ kind: "ended", replay: file });
  });

  test("a resumed segment's viewer finds the sender's file in the first row", () => {
    const file = recording();
    const resumed = { ...target, rowID: `${BASE}-1700000000000` };
    expect(
      liveVideoViewerState([row(BASE, { attachment: file })], resumed),
    ).toEqual({ kind: "ended", replay: file });
  });

  test("a canceled stream, or one that recorded nothing, has nothing to replay", () => {
    expect(liveVideoViewerState([], target)).toEqual({
      kind: "ended",
      replay: null,
    });
    expect(liveVideoViewerState(undefined, target)).toEqual({
      kind: "ended",
      replay: null,
    });
  });

  test("another sender's or another stream's recording is never borrowed", () => {
    expect(
      liveVideoViewerState(
        [
          row("other-sender", { attachment: recording() }, "ffffffffffffffff"),
          row("other-stream", {
            attachment: recording("video_ffffffffffffffff.mp4"),
          }),
        ],
        target,
      ),
    ).toEqual({ kind: "ended", replay: null });
  });
});
