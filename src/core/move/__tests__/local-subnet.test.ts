/**
 * @jest-environment node
 */
import { isOnLocalSubnet, type LocalSubnet } from "../local-subnet";

const WIFI: LocalSubnet = { address: "192.168.1.30", prefixLength: 24 };

describe("isOnLocalSubnet", () => {
  it("accepts an address on one of this phone's networks", () => {
    expect(isOnLocalSubnet("192.168.1.20", [WIFI])).toBe(true);
    // An iOS Personal Hotspot, /28.
    const hotspot = { address: "172.20.10.1", prefixLength: 28 };
    expect(isOnLocalSubnet("172.20.10.14", [WIFI, hotspot])).toBe(true);
    expect(isOnLocalSubnet("172.20.10.17", [WIFI, hotspot])).toBe(false);
    // Campus Wi-Fi handing out public addresses is still one network.
    const campus = { address: "128.232.10.5", prefixLength: 16 };
    expect(isOnLocalSubnet("128.232.200.9", [campus])).toBe(true);
  });

  it("refuses an address on no network this phone is on", () => {
    expect(isOnLocalSubnet("203.0.113.7", [WIFI])).toBe(false);
    expect(isOnLocalSubnet("192.168.2.20", [WIFI])).toBe(false);
    // Private, but not here: a VPN would route it off the phone.
    expect(isOnLocalSubnet("10.0.0.5", [WIFI])).toBe(false);
    expect(isOnLocalSubnet("192.168.1.20", [])).toBe(false);
  });

  it("treats a prefix wider than /8 as a route, not a network", () => {
    expect(
      isOnLocalSubnet("8.8.8.8", [{ address: "1.2.3.4", prefixLength: 0 }]),
    ).toBe(false);
    expect(
      isOnLocalSubnet("11.8.8.8", [{ address: "10.2.3.4", prefixLength: 7 }]),
    ).toBe(false);
    expect(
      isOnLocalSubnet("10.200.8.8", [{ address: "10.2.3.4", prefixLength: 8 }]),
    ).toBe(true);
  });

  it("handles the edges of the address space and bad input", () => {
    const top = { address: "255.255.255.1", prefixLength: 24 };
    expect(isOnLocalSubnet("255.255.255.254", [top])).toBe(true);
    const host = { address: "192.168.1.30", prefixLength: 32 };
    expect(isOnLocalSubnet("192.168.1.30", [host])).toBe(true);
    expect(isOnLocalSubnet("192.168.1.31", [host])).toBe(false);
    expect(isOnLocalSubnet("192.168.1.256", [WIFI])).toBe(false);
    expect(isOnLocalSubnet("fe80::1", [WIFI])).toBe(false);
    expect(
      isOnLocalSubnet("192.168.1.20", [{ address: "x", prefixLength: 24 }]),
    ).toBe(false);
    expect(
      isOnLocalSubnet("192.168.1.20", [{ ...WIFI, prefixLength: 33 }]),
    ).toBe(false);
  });
});
