// The deadline each write carries into a link's native queue: live media
// expires as bitchat's live branch expires it, everything else never does.
import { PacketType } from "../../wire/packet-codec";
import { isLiveMedia, LIVE_WRITE_TTL_MS, writeTtlMs } from "../write-deadline";

describe("writeTtlMs", () => {
  it("gives push-to-talk and live video bitchat's 1.5 s", () => {
    expect(LIVE_WRITE_TTL_MS).toBe(1_500);
    expect(writeTtlMs(PacketType.VOICE_FRAME)).toBe(1_500);
    expect(writeTtlMs(PacketType.VIDEO_FRAME)).toBe(1_500);
  });

  it("never expires anything else, fragments included", () => {
    for (const type of [
      PacketType.ANNOUNCE,
      PacketType.FRAGMENT,
      PacketType.NOISE_ENCRYPTED,
      PacketType.FILE_TRANSFER,
    ]) {
      expect(isLiveMedia(type)).toBe(false);
      expect(writeTtlMs(type)).toBe(0);
    }
  });
});
