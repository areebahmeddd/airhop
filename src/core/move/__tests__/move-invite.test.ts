/**
 * @jest-environment node
 */
import { encodeQRContent } from "../../crypto/contact-exchange";
import {
  decodeMoveInvite,
  encodeMoveInvite,
  isMoveInvite,
  MAX_MOVE_HOSTS,
  type MoveInvite,
} from "../move-invite";

function invite(overrides: Partial<MoveInvite> = {}): MoveInvite {
  return {
    publicKey: new Uint8Array(32).fill(7),
    token: new Uint8Array(16).fill(9),
    port: 51820,
    hosts: ["192.168.1.24"],
    ...overrides,
  };
}

describe("move invite", () => {
  it("round-trips key, token, port and every address", () => {
    const original = invite({ hosts: ["192.168.1.24", "172.20.10.1"] });
    const decoded = decodeMoveInvite(encodeMoveInvite(original));
    expect(decoded).not.toBeNull();
    expect(decoded?.publicKey).toEqual(original.publicKey);
    expect(decoded?.token).toEqual(original.token);
    expect(decoded?.port).toBe(51820);
    expect(decoded?.hosts).toEqual(["192.168.1.24", "172.20.10.1"]);
  });

  it("carries only IPv4 addresses, and at most four", () => {
    const hosts = [
      "fe80::1",
      "10.0.0.2",
      "10.0.0.3",
      "10.0.0.4",
      "10.0.0.5",
      "10.0.0.6",
    ];
    const decoded = decodeMoveInvite(encodeMoveInvite(invite({ hosts })));
    expect(decoded?.hosts).toHaveLength(MAX_MOVE_HOSTS);
    expect(decoded?.hosts[0]).toBe("10.0.0.2");
  });

  it("refuses to encode a code nobody could dial", () => {
    expect(() => encodeMoveInvite(invite({ hosts: ["fe80::1"] }))).toThrow();
    expect(() => encodeMoveInvite(invite({ port: 0 }))).toThrow();
    expect(() => encodeMoveInvite(invite({ hosts: ["300.1.1.1"] }))).toThrow();
  });

  it("is told apart from a contact code", () => {
    const contact = encodeQRContent({
      peerID: "0011223344556677",
      noisePubKey: new Uint8Array(32),
      signingPubKey: new Uint8Array(32),
      nickname: "sam",
      nostrPubKey: new Uint8Array(32),
    });
    expect(isMoveInvite(contact)).toBe(false);
    expect(decodeMoveInvite(contact)).toBeNull();
    expect(isMoveInvite(encodeMoveInvite(invite()))).toBe(true);
  });

  it("rejects a truncated or padded payload rather than guessing", () => {
    const code = encodeMoveInvite(invite());
    expect(decodeMoveInvite(code.slice(0, -4))).toBeNull();
    expect(decodeMoveInvite(`${code}AAAA`)).toBeNull();
    expect(decodeMoveInvite("airhop-move:v1/!!!")).toBeNull();
  });
});
