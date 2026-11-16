// LAN_ENDPOINT (0x56): where a phone's LAN transport listens, refused whole on
// anything but the exact layout.

import { decodeLanEndpoint, encodeLanEndpoint } from "../lan-endpoint-payload";

describe("LAN_ENDPOINT", () => {
  test("round-trips a port and its addresses, byte for byte", () => {
    const endpoint = { port: 40_123, hosts: ["192.168.1.23", "10.0.0.7"] };
    const body = encodeLanEndpoint(endpoint);
    expect(body).toEqual(
      Uint8Array.of(0x9c, 0xbb, 2, 192, 168, 1, 23, 10, 0, 0, 7),
    );
    expect(decodeLanEndpoint(body!)).toEqual(endpoint);
  });

  test("encodes nothing it could not decode", () => {
    expect(encodeLanEndpoint({ port: 0, hosts: ["10.0.0.1"] })).toBeNull();
    expect(encodeLanEndpoint({ port: 65_536, hosts: ["10.0.0.1"] })).toBeNull();
    expect(encodeLanEndpoint({ port: 1, hosts: [] })).toBeNull();
    expect(
      encodeLanEndpoint({ port: 1, hosts: Array(5).fill("10.0.0.1") }),
    ).toBeNull();
    expect(encodeLanEndpoint({ port: 1, hosts: ["example.com"] })).toBeNull();
    expect(encodeLanEndpoint({ port: 1, hosts: ["10.0.0.256"] })).toBeNull();
  });

  // Listeners take an ephemeral port; a low one names a system service.
  test("refuses a port below 1024, a bad count or a stray byte", () => {
    const good = encodeLanEndpoint({ port: 1024, hosts: ["10.0.0.1"] })!;
    expect(decodeLanEndpoint(good)).not.toBeNull();
    expect(encodeLanEndpoint({ port: 1023, hosts: ["10.0.0.1"] })).toBeNull();
    expect(decodeLanEndpoint(Uint8Array.of(0, 0, 1, 10, 0, 0, 1))).toBeNull();
    expect(decodeLanEndpoint(Uint8Array.of(3, 255, 1, 10, 0, 0, 1))).toBeNull();
    expect(decodeLanEndpoint(Uint8Array.of(4, 0, 0))).toBeNull();
    expect(
      decodeLanEndpoint(Uint8Array.of(4, 0, 5, ...Array<number>(20).fill(1))),
    ).toBeNull();
    expect(decodeLanEndpoint(Uint8Array.of(...good, 0))).toBeNull();
    expect(decodeLanEndpoint(good.slice(0, -1))).toBeNull();
    expect(decodeLanEndpoint(new Uint8Array(0))).toBeNull();
  });
});
