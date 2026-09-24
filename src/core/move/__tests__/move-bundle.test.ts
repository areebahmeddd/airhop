/**
 * @jest-environment node
 */
import { BundleAssembler, buildOffer, chunksOf } from "../move-bundle";

const enc = new TextEncoder();

function sections() {
  return [
    { name: "mmkv:contacts-store", data: enc.encode("x".repeat(70_000)) },
    { name: "wallet", data: new Uint8Array(0) },
    { name: "secret:identity", data: enc.encode('{"noisePrivHex":"00"}') },
  ];
}

describe("move bundle", () => {
  it("reassembles every section byte for byte across chunk boundaries", () => {
    const { offer, stream } = buildOffer(sections(), {
      appVersion: "1.0.8",
      history: true,
    });
    const assembler = new BundleAssembler(offer);
    for (const chunk of chunksOf(stream, 4096)) assembler.push(chunk.slice());
    const out = assembler.complete();
    for (const s of sections()) expect(out.get(s.name)).toEqual(s.data);
    expect(assembler.receivedBytes).toBe(assembler.total);
  });

  it("refuses a stream that ends early", () => {
    const { offer, stream } = buildOffer(sections(), {
      appVersion: "1.0.8",
      history: true,
    });
    const assembler = new BundleAssembler(offer);
    assembler.push(stream.slice(0, stream.length - 1));
    expect(() => assembler.complete()).toThrow();
  });

  it("refuses more bytes than were offered", () => {
    const { offer, stream } = buildOffer(sections(), {
      appVersion: "1.0.8",
      history: true,
    });
    const assembler = new BundleAssembler(offer);
    assembler.push(stream);
    expect(() => assembler.push(Uint8Array.of(0))).toThrow();
  });

  it("catches a section that does not match its hash", () => {
    const { offer, stream } = buildOffer(sections(), {
      appVersion: "1.0.8",
      history: true,
    });
    const corrupt = stream.slice();
    corrupt[10] ^= 0xff;
    const assembler = new BundleAssembler(offer);
    assembler.push(corrupt);
    expect(() => assembler.complete()).toThrow(/contacts-store/);
  });
});
