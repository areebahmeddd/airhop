// Packetizer to a lossy, reordering channel to assembler, with synthetic units
// and a fake clock: bitchat's VideoStreamLossSimulationTests, case for case.

import { Prng } from "../../../../__tests__/simulation/harness/prng";
import {
  decodeVideoBurstPacket,
  encodeEntries,
  type LiveVideoConfig,
  type LiveVideoEntry,
  type VideoBurstPacket,
  type VideoTrack,
} from "../video-burst-packet";
import {
  expandCount,
  expandSequence,
  VideoStreamAssembler,
  type LiveVideoOutput,
} from "../video-stream-assembler";
import {
  fecPolicy,
  parityCount,
  VideoStreamPacketizer,
  type LiveVideoFecPolicy,
} from "../video-stream-packetizer";

const config: LiveVideoConfig = {
  width: 144,
  height: 192,
  fps: 8,
  bitrateKbps: 24,
  hasAudio: true,
};

type VideoOut = Extract<LiveVideoOutput, { kind: "video" }>;

const videoOf = (outputs: LiveVideoOutput[]): VideoOut[] =>
  outputs.filter((o): o is VideoOut => o.kind === "video");
const audioOf = (outputs: LiveVideoOutput[]): Uint8Array[] =>
  outputs.flatMap((o) => (o.kind === "audio" ? [o.data] : []));
const endedCount = (outputs: LiveVideoOutput[]): number =>
  outputs.filter((o) => o.kind === "ended").length;

function decode(bytes: Uint8Array): VideoBurstPacket {
  const packet = decodeVideoBurstPacket(bytes);
  if (packet === null) throw new Error("packetizer emitted an invalid packet");
  return packet;
}

interface Sent {
  keyframe: boolean;
  data: Uint8Array;
}

// A 10 s stream: 8 fps video with a 2 s GOP (keyframes about 2.4 KB, deltas
// 120 to 260 B) and 64 ms audio frames of about 96 B. `lose` decides per
// packet whether the channel drops it.
function run(
  seed: number,
  lose: (index: number) => boolean,
  { fec = fecPolicy(0.25, 0.5), reorderMs = 0 } = {},
): {
  outputs: LiveVideoOutput[];
  sentVideo: Sent[];
  sentAudio: Sent[];
  assembler: VideoStreamAssembler;
  packetizer: VideoStreamPacketizer;
} {
  const random = new Prng(seed);
  const packetizer = new VideoStreamPacketizer(
    new Uint8Array(8).fill(9),
    config,
    fec,
  );
  const assembler = new VideoStreamAssembler();
  const sentVideo: Sent[] = [];
  const sentAudio: Sent[] = [];
  let inFlight: { due: number; order: number; packet: Uint8Array }[] = [];
  const outputs: LiveVideoOutput[] = [];
  let packetIndex = 0;

  const send = (now: number, packets: Uint8Array[]): void => {
    for (const packet of packets) {
      const order = packetIndex++;
      if (lose(order)) continue;
      const delay = reorderMs > 0 ? random.int(0, reorderMs - 1) : 0;
      inFlight.push({ due: now + delay, order, packet });
    }
  };
  const deliver = (now: number): void => {
    const due = inFlight
      .filter((p) => p.due <= now)
      .sort((a, b) => a.due - b.due || a.order - b.order);
    inFlight = inFlight.filter((p) => p.due > now);
    for (const { packet } of due) {
      outputs.push(...assembler.onPacket(decode(packet), packet.length, now));
    }
    outputs.push(...assembler.onTick(now));
  };

  send(0, packetizer.start());
  let nextVideo = 0;
  let nextAudio = 0;
  let frame = 0;
  for (let now = 0; now <= 10_000; now += 4) {
    if (now >= nextVideo) {
      const keyframe = frame % 16 === 0;
      const data = random.bytes(keyframe ? 2_400 : random.int(120, 259));
      sentVideo.push({ keyframe, data });
      send(
        now,
        packetizer.add({ track: "video", ptsMs: now, keyframe, data }, now),
      );
      frame++;
      nextVideo += 125;
    }
    if (now >= nextAudio) {
      const data = random.bytes(random.int(80, 109));
      sentAudio.push({ keyframe: false, data });
      send(
        now,
        packetizer.add(
          { track: "audio", ptsMs: now, keyframe: false, data },
          now,
        ),
      );
      nextAudio += 64;
    }
    send(now, packetizer.tick(now));
    deliver(now);
  }
  send(10_000, packetizer.finish(10_000, 10_000));
  for (let now = 10_000; now <= 13_000; now += 10) deliver(now);
  if (!assembler.isFinished) outputs.push(...assembler.flush());
  return { outputs, sentVideo, sentAudio, assembler, packetizer };
}

describe("live video over a lossy channel", () => {
  test("a lossless channel delivers every unit in order", () => {
    const r = run(1, () => false);
    const video = videoOf(r.outputs);
    const audio = audioOf(r.outputs);
    expect(video).toHaveLength(r.sentVideo.length);
    expect(audio).toHaveLength(r.sentAudio.length);
    video.forEach((unit, i) => {
      expect(unit.data).toEqual(r.sentVideo[i].data);
      expect(unit.keyframe).toBe(r.sentVideo[i].keyframe);
      expect(unit.sequence).toBe(i);
    });
    audio.forEach((data, i) => expect(data).toEqual(r.sentAudio[i].data));
    expect(endedCount(r.outputs)).toBe(1);
    const stats = r.assembler.stats();
    expect(stats.skippedVideoUnits).toBe(0);
    expect(stats.recentLoss).toBe(0);
    expect(r.assembler.endReceived).toBe(true);
    expect(r.assembler.config).toEqual(config);
    expect(r.packetizer.unitsEmitted("video")).toBe(r.sentVideo.length);
    expect(r.packetizer.unitsEmitted("audio")).toBe(r.sentAudio.length);
    expect(r.packetizer.droppedUnits).toBe(0);
  });

  test("aggregation keeps packets full", () => {
    const r = run(2, () => false);
    const bytes = [...r.sentVideo, ...r.sentAudio].reduce(
      (n, u) => n + u.data.length,
      0,
    );
    const sourcePackets = r.packetizer.packetCount - r.packetizer.parityPackets;
    // Small audio and delta units share shards.
    expect(sourcePackets).toBeLessThan(
      ((r.sentVideo.length + r.sentAudio.length) * 2) / 3,
    );
    expect(bytes / sourcePackets).toBeGreaterThan(180);
  });

  test.each([70, 71, 72, 73, 74, 75, 76, 77])(
    "parity repairs 5%% independent loss (seed %i)",
    (seed) => {
      const loss = new Prng(seed * 7919);
      const r = run(seed, () => loss.chance(0.05), { reorderMs: 120 });
      expect(r.assembler.stats().recoveredShards).toBeGreaterThan(0);
      // A rare unrecoverable block costs at most the rest of its GOP.
      expect(videoOf(r.outputs).length).toBeGreaterThanOrEqual(
        r.sentVideo.length * 0.8,
      );
      expect(audioOf(r.outputs).length).toBeGreaterThanOrEqual(
        r.sentAudio.length * 0.95,
      );
      expect(endedCount(r.outputs)).toBe(1);
    },
  );

  test("a burst loss freezes until the next keyframe, never a broken delta", () => {
    // 40 packets in a row: a whole GOP's shards and their parity.
    const r = run(4, (i) => i >= 60 && i <= 99);
    const sent = new Set(r.sentVideo.map((u) => u.data.join()));
    let chainValid = false;
    let previous = -1;
    for (const unit of videoOf(r.outputs)) {
      expect(sent.has(unit.data.join())).toBe(true);
      if (unit.keyframe) chainValid = true;
      expect(chainValid).toBe(true);
      if (!unit.keyframe) expect(unit.sequence).toBe(previous + 1);
      previous = unit.sequence;
    }
    expect(r.assembler.stats().skippedVideoUnits).toBeGreaterThan(0);
    expect(videoOf(r.outputs).length).toBeGreaterThan(r.sentVideo.length / 2);
  });

  test("a late joiner starts at the first keyframe", () => {
    const r = run(5, (i) => i < 150);
    expect(videoOf(r.outputs)[0]?.keyframe).toBe(true);
    expect(r.outputs.some((o) => o.kind === "config")).toBe(true);
  });

  test("duplicated packets are ignored", () => {
    const packetizer = new VideoStreamPacketizer(
      new Uint8Array(8),
      config,
      fecPolicy(0.25, 0.5),
    );
    const assembler = new VideoStreamAssembler();
    const packets = [
      ...packetizer.start(),
      ...packetizer.add(
        {
          track: "video",
          ptsMs: 0,
          keyframe: true,
          data: new Uint8Array(900).fill(3),
        },
        0,
      ),
      ...packetizer.finish(1_000, 1_000),
    ];
    const outputs = [...packets, ...packets].flatMap((bytes) =>
      assembler.onPacket(decode(bytes), bytes.length, 0),
    );
    expect(videoOf(outputs)).toHaveLength(1);
    expect(endedCount(outputs)).toBe(1);
    expect(outputs.at(-1)).toEqual({ kind: "ended", durationMs: 1_000 });
  });

  test("a stream resumes after a long silence at the next keyframe", () => {
    // 10 s with nothing arriving mid-stream: the viewer drains what it has,
    // keeps the stream open and carries on at the first keyframe after.
    let silenceDrained = false;
    const packetizer = new VideoStreamPacketizer(
      new Uint8Array(8).fill(4),
      config,
      fecPolicy(0.2, 0.4),
    );
    const assembler = new VideoStreamAssembler();
    const outputs: LiveVideoOutput[] = [];
    const random = new Prng(9);
    const deliver = (packets: Uint8Array[], now: number, silent: boolean) => {
      if (silent) return;
      for (const bytes of packets) {
        outputs.push(...assembler.onPacket(decode(bytes), bytes.length, now));
      }
    };
    deliver(packetizer.start(), 0, false);
    let frame = 0;
    for (let now = 0; now <= 30_000; now += 125) {
      const silent = now >= 10_000 && now < 20_000;
      if (silent && !silenceDrained && now >= 14_000) {
        outputs.push(...assembler.drain());
        silenceDrained = true;
      }
      const keyframe = frame % 16 === 0;
      const data = random.bytes(keyframe ? 2_000 : random.int(100, 199));
      deliver(
        packetizer.add({ track: "video", ptsMs: now, keyframe, data }, now),
        now,
        silent,
      );
      deliver(packetizer.tick(now), now, silent);
      outputs.push(...assembler.onTick(now));
      frame++;
    }
    deliver(packetizer.finish(30_000, 30_000), 30_000, false);
    outputs.push(...assembler.onTick(31_000));

    const video = videoOf(outputs);
    const after = video.filter((u) => u.ptsMs >= 20_000);
    expect(video.filter((u) => u.ptsMs < 10_000).length).toBeGreaterThanOrEqual(
      75,
    );
    expect(after.length).toBeGreaterThanOrEqual(60);
    expect(after[0]?.keyframe).toBe(true);
    expect(silenceDrained).toBe(true);
    expect(endedCount(outputs)).toBe(1);
  });
});

describe("VideoStreamAssembler edge cases", () => {
  const dataPacket = (
    block: number,
    sequence: number,
    entries: LiveVideoEntry[],
  ): VideoBurstPacket => ({
    streamID: new Uint8Array(8),
    sequence,
    kind: "data",
    block,
    index: 0,
    region: encodeEntries(entries),
  });
  const unit = (
    track: VideoTrack,
    sequence: number,
    keyframe = false,
  ): LiveVideoEntry => ({
    track,
    keyframe,
    unitSequence: sequence,
    ptsMs: sequence,
    fragmentIndex: 0,
    fragmentCount: 1,
    bytes: Uint8Array.of(sequence & 0xff),
  });

  test("unit sequences expand across the 16-bit wrap", () => {
    const assembler = new VideoStreamAssembler();
    const outputs = [65_534, 65_535, 0, 1].flatMap((sequence, i) =>
      assembler.onPacket(
        dataPacket(i, i, [unit("video", sequence, i === 0)]),
        0,
        0,
      ),
    );
    expect(videoOf(outputs).map((u) => u.sequence)).toEqual([
      65_534, 65_535, 65_536, 65_537,
    ]);
    expect(expandSequence(2, 65_535)).toBe(65_538);
    expect(expandSequence(65_535, 65_538)).toBe(65_535);
    expect(expandSequence(65_535, 0)).toBe(-1);
    expect(expandCount(3, 65_537)).toBe(65_539);
    expect(expandCount(0, 0)).toBe(0);
  });

  test("a gap is skipped after the deadline and breaks the video chain", () => {
    const assembler = new VideoStreamAssembler(900);
    const first = assembler.onPacket(
      dataPacket(0, 0, [unit("video", 0, true)]),
      0,
      0,
    );
    // Unit 1 is lost; unit 2, a delta, waits for it.
    assembler.onPacket(dataPacket(1, 2, [unit("video", 2)]), 0, 100);
    expect(videoOf(first)).toHaveLength(1);
    expect(assembler.onTick(999)).toEqual([]);
    // The gap is skipped, and the delta after it withheld rather than decoded.
    expect(assembler.onTick(1_000)).toEqual([
      { kind: "videoSkipped", count: 1 },
      { kind: "videoSkipped", count: 1 },
    ]);
    expect(assembler.stats().skippedVideoUnits).toBe(2);
    const resumed = assembler.onPacket(
      dataPacket(2, 3, [unit("video", 3, true)]),
      0,
      1_100,
    );
    expect(videoOf(resumed).map((u) => u.sequence)).toEqual([3]);
  });

  test("a ready backlog past the cap skips the head gap", () => {
    const assembler = new VideoStreamAssembler();
    const outputs = assembler.onPacket(
      dataPacket(0, 0, [unit("audio", 0)]),
      0,
      0,
    );
    // Unit 1 never arrives; 193 later units pile up behind it.
    for (let sequence = 2; sequence <= 194; sequence++) {
      outputs.push(
        ...assembler.onPacket(
          dataPacket(sequence, sequence, [unit("audio", sequence)]),
          0,
          0,
        ),
      );
    }
    const released = outputs.flatMap((o) =>
      o.kind === "audio" ? [o.sequence] : [],
    );
    expect(released).toEqual([
      0,
      ...Array.from({ length: 193 }, (_, i) => i + 2),
    ]);
    expect(assembler.stats().audioUnits).toBe(194);
  });

  test("CANCELED ends the stream at once", () => {
    const assembler = new VideoStreamAssembler();
    const cancel: VideoBurstPacket = {
      streamID: new Uint8Array(8),
      sequence: 1,
      kind: "canceled",
    };
    expect(assembler.onPacket(cancel, 11, 0)).toEqual([{ kind: "canceled" }]);
    expect(assembler.isFinished).toBe(true);
    expect(
      assembler.onPacket(dataPacket(0, 2, [unit("audio", 0)]), 0, 0),
    ).toEqual([]);
    expect(assembler.flush()).toEqual([]);
  });

  test("flush ends once without an END", () => {
    const assembler = new VideoStreamAssembler();
    assembler.onPacket(dataPacket(0, 0, [unit("video", 0, true)]), 0, 0);
    expect(assembler.flush()).toEqual([{ kind: "ended", durationMs: 0 }]);
    expect(assembler.isFinished).toBe(true);
    expect(assembler.flush()).toEqual([]);
  });

  test("recent loss reflects the missing sequences", () => {
    const assembler = new VideoStreamAssembler();
    for (let sequence = 0; sequence < 128; sequence += 2) {
      assembler.onPacket(
        dataPacket(sequence, sequence, [unit("audio", sequence)]),
        10,
        0,
      );
    }
    const stats = assembler.stats();
    expect(stats.packets).toBe(64);
    expect(stats.bytes).toBe(640);
    expect(stats.recentLoss).toBeCloseTo(1 - 64 / 127, 9);
  });
});

describe("FEC policy", () => {
  const policy: LiveVideoFecPolicy = fecPolicy(0.25, 0.5);

  test("two parity shards from four sources, and never past the cap", () => {
    expect(parityCount(policy, 1, false)).toBe(1);
    expect(parityCount(policy, 4, false)).toBe(2);
    expect(parityCount(policy, 12, false)).toBe(3);
    expect(parityCount(policy, 12, true)).toBe(6);
    expect(parityCount(fecPolicy(1, 1), 32, true)).toBe(16);
    expect(parityCount(fecPolicy(0, 0), 8, true)).toBe(0);
  });
});
