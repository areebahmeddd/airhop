// The sender's congestion control (case for case against bitchat's
// LiveVideoCongestionControllerTests) and its pacing queue.

import { LiveVideoCongestionController } from "../live-video-congestion";
import { LiveVideoPacer } from "../live-video-pacer";
import { BLE_PACKET_BUDGET, LIVE_VIDEO_QUALITIES } from "../live-video-quality";

describe("LiveVideoCongestionController", () => {
  test("a growing queue backs off, then recovers gradually", () => {
    const c = new LiveVideoCongestionController(60_000);
    c.onBacklog(20, 0);
    expect(c.bitrate).toBe(48_000);
    // Rate-limited: a second high sample inside a second does not compound.
    c.onBacklog(20, 500);
    expect(c.bitrate).toBe(48_000);
    c.onBacklog(20, 1_000);
    expect(c.bitrate).toBe(38_400);
    // Calm: nothing for two seconds, then a step a second, capped at the preset.
    let now = 2_000;
    c.onBacklog(0, now);
    expect(c.bitrate).toBe(38_400);
    for (let i = 0; i < 20; i++) c.onBacklog(0, (now += 1_000));
    expect(c.bitrate).toBe(60_000);
  });

  test("a deep queue skips video and resumes with a keyframe", () => {
    const c = new LiveVideoCongestionController(60_000);
    const deep = c.onBacklog(80, 0);
    expect(deep.skipVideo).toBe(true);
    expect(deep.requestKeyframe).toBe(false);
    expect(c.onBacklog(30, 250).skipVideo).toBe(true);
    const drained = c.onBacklog(2, 500);
    expect(drained.skipVideo).toBe(false);
    expect(drained.requestKeyframe).toBe(true);
    expect(c.onBacklog(2, 750).requestKeyframe).toBe(false);
    expect(c.skipEpisodes).toBe(1);
  });

  test("the bitrate never drops below the floor", () => {
    const c = new LiveVideoCongestionController(20_000);
    for (let now = 0; now < 30 * 250; now += 250) c.onBacklog(100, now);
    expect(c.bitrate).toBe(6_000);
  });

  test("a middling queue resets the calm timer", () => {
    const c = new LiveVideoCongestionController(60_000, {
      minBitrate: 10_000,
    });
    c.onBacklog(20, 0);
    c.onBacklog(0, 1_000);
    c.onBacklog(10, 2_500);
    c.onBacklog(0, 3_000);
    expect(c.bitrate).toBe(48_000);
    c.onBacklog(0, 5_000);
    expect(c.bitrate).toBe(53_000);
  });
});

describe("LiveVideoPacer", () => {
  const packet = (n = 352): Uint8Array => new Uint8Array(n);

  test("holds a burst to the packet budget", () => {
    const pacer = new LiveVideoPacer(1_000_000, 10);
    pacer.enqueue(
      Array.from({ length: 20 }, () => packet()),
      0,
    );
    const sent: Uint8Array[] = [];
    // Six go at once (the burst allowance), then one per 100 ms.
    expect(pacer.drain(0, (p) => sent.push(p))).toBeGreaterThan(0);
    expect(sent).toHaveLength(6);
    pacer.drain(500, (p) => sent.push(p));
    expect(sent).toHaveLength(11);
    expect(pacer.backlog).toBe(9);
  });

  test("drops what waited past the deadline, unless it is the final drain", () => {
    const pacer = new LiveVideoPacer(1_000_000, 1);
    pacer.enqueue(
      Array.from({ length: 10 }, () => packet()),
      0,
    );
    let sent = 0;
    pacer.drain(0, () => sent++);
    pacer.drain(1_300, () => sent++);
    expect(pacer.staleDropped).toBe(10 - sent);
    expect(pacer.backlog).toBe(0);

    const final = new LiveVideoPacer(1_000_000, 1);
    final.enqueue([packet(), packet()], 0);
    final.drain(5_000, () => undefined, true);
    expect(final.staleDropped).toBe(0);
  });

  test("Low over Bluetooth paces under the route's budget", () => {
    const pacer = LiveVideoPacer.forQuality(
      LIVE_VIDEO_QUALITIES.low,
      BLE_PACKET_BUDGET,
    );
    pacer.enqueue(
      Array.from({ length: 200 }, () => packet()),
      0,
    );
    let sent = 0;
    for (let now = 0; now <= 1_000; now += 10) pacer.drain(now, () => sent++);
    // A second of Low is 30 kbps with parity and headroom, about 30 packets
    // of airtime; the 24-packet budget and the burst allowance cap it first.
    expect(sent).toBeLessThanOrEqual(BLE_PACKET_BUDGET + 6);
    expect(sent).toBeGreaterThan(10);
  });
});
