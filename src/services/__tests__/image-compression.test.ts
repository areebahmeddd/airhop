/**
 * @jest-environment node
 */
// A small GIF or PNG goes out untouched, and only when its bytes are what its
// declared type says: the receiver checks the magic bytes and drops a
// mismatch. Every JPEG and WebP is re-encoded, which is what strips EXIF.

import { prepareImageForSend } from "../image-compression";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const GIF = new TextEncoder().encode("GIF89a\u0000\u0000");
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const mockJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

// uri -> bytes on disk.
const mockDisk = new Map<string, Uint8Array>();

jest.mock("expo-file-system", () => ({
  File: class {
    private readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists(): boolean {
      return mockDisk.has(this.uri);
    }
    get size(): number {
      return mockDisk.get(this.uri)?.length ?? 0;
    }
    bytes(): Promise<Uint8Array> {
      const b = mockDisk.get(this.uri);
      return b === undefined
        ? Promise.reject(new Error("gone"))
        : Promise.resolve(b);
    }
  },
  Paths: { cache: {} },
}));

// Each render the manipulator is asked for, in order: the probe first, then one
// per rung. `failFrom` makes it refuse from that render on, as it does for a
// file it cannot decode; `rungSizes` is what each saved rung weighs.
const mockManipulator = {
  renders: 0,
  saves: 0,
  failFrom: Infinity,
  rungSizes: [] as number[],
};

jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: () => ({
      resize: () => undefined,
      renderAsync: () => {
        mockManipulator.renders += 1;
        if (mockManipulator.renders >= mockManipulator.failFrom) {
          return Promise.reject(new Error("cannot decode"));
        }
        return Promise.resolve({
          width: 800,
          height: 600,
          saveAsync: () => {
            const n = mockManipulator.saves++;
            const uri = `file:///rung${String(n)}.jpg`;
            const size = mockManipulator.rungSizes[n];
            mockDisk.set(
              uri,
              size === undefined ? mockJpeg : new Uint8Array(size),
            );
            return Promise.resolve({ uri });
          },
        });
      },
    }),
  },
}));

jest.mock("../file-transfer-service", () => ({
  adoptIntoAttachmentCache: jest.fn((uri: string) => Promise.resolve(uri)),
  discardPickerCopy: jest.fn(),
}));

const fileTransfer = jest.requireMock<{
  adoptIntoAttachmentCache: jest.Mock;
  discardPickerCopy: jest.Mock;
}>("../file-transfer-service");

beforeEach(() => {
  mockDisk.clear();
  mockManipulator.renders = 0;
  mockManipulator.saves = 0;
  mockManipulator.failFrom = Infinity;
  mockManipulator.rungSizes = [];
  fileTransfer.adoptIntoAttachmentCache.mockClear();
  fileTransfer.discardPickerCopy.mockClear();
});

describe("prepareImageForSend", () => {
  // The picker's JPEG can carry the camera's GPS; only an encode drops it.
  it("re-encodes a JPEG however small, so its metadata never leaves", async () => {
    mockDisk.set("file:///a.jpg", mockJpeg);
    const ready = await prepareImageForSend("file:///a.jpg", "a.jpg");
    expect(ready?.uri).toBe("file:///rung0.jpg");
    expect(ready?.mimeType).toBe("image/jpeg");
    // The picker's copy, EXIF and all, does not stay behind either.
    expect(fileTransfer.discardPickerCopy).toHaveBeenCalledWith(
      "file:///a.jpg",
    );
  });

  it("re-encodes a small WebP too", async () => {
    mockDisk.set("file:///w.webp", WEBP);
    const ready = await prepareImageForSend(
      "file:///w.webp",
      "w.webp",
      "image/webp",
    );
    expect(ready?.uri).toBe("file:///rung0.jpg");
    expect(ready?.name).toBe("w.jpg");
  });

  it("sends a small GIF as it is, so it stays animated", async () => {
    mockDisk.set("file:///g.gif", GIF);
    const ready = await prepareImageForSend(
      "file:///g.gif",
      "g.gif",
      "image/gif",
    );
    expect(ready?.uri).toBe("file:///g.gif");
    expect(ready?.mimeType).toBe("image/gif");
    // Moved under the attachment prefix, so retention and Clear see it.
    expect(fileTransfer.adoptIntoAttachmentCache).toHaveBeenCalledWith(
      "file:///g.gif",
      "g.gif",
    );
    expect(fileTransfer.discardPickerCopy).not.toHaveBeenCalled();
  });

  it("re-encodes a PNG that a .jpg name would have labelled JPEG", async () => {
    mockDisk.set("file:///img_1.jpg", PNG);
    const ready = await prepareImageForSend("file:///img_1.jpg", "img_1.jpg");
    expect(ready?.uri).toBe("file:///rung0.jpg");
    expect(ready?.mimeType).toBe("image/jpeg");
  });

  it("keeps a correctly labelled PNG as a PNG", async () => {
    mockDisk.set("file:///b.png", PNG);
    const ready = await prepareImageForSend(
      "file:///b.png",
      "b.png",
      "image/png",
    );
    expect(ready?.uri).toBe("file:///b.png");
    expect(ready?.mimeType).toBe("image/png");
  });

  // The encode is what strips the camera's GPS, so a file it cannot open is
  // refused rather than sent with its metadata.
  it("refuses a JPEG the encoder cannot open, and keeps nothing of it", async () => {
    mockDisk.set("file:///a.jpg", mockJpeg);
    mockManipulator.failFrom = 1;
    const ready = await prepareImageForSend("file:///a.jpg", "a.jpg");
    expect(ready).toBeNull();
    expect(fileTransfer.adoptIntoAttachmentCache).not.toHaveBeenCalled();
    expect(fileTransfer.discardPickerCopy).toHaveBeenCalledWith(
      "file:///a.jpg",
    );
  });

  it("refuses a WebP whose first encode fails after the probe", async () => {
    mockDisk.set("file:///w.webp", WEBP);
    mockManipulator.failFrom = 2;
    const ready = await prepareImageForSend(
      "file:///w.webp",
      "w.webp",
      "image/webp",
    );
    expect(ready).toBeNull();
    expect(fileTransfer.adoptIntoAttachmentCache).not.toHaveBeenCalled();
  });

  // Only the version that is sent is adopted; every other rung is deleted, or
  // it would count toward Storage with no message pointing at it.
  it("keeps only the rung it sends", async () => {
    mockDisk.set("file:///a.jpg", mockJpeg);
    mockManipulator.rungSizes = [400 * 1024, 300 * 1024, 100 * 1024];
    const ready = await prepareImageForSend("file:///a.jpg", "a.jpg");
    expect(ready?.uri).toBe("file:///rung2.jpg");
    expect(fileTransfer.adoptIntoAttachmentCache).toHaveBeenCalledTimes(1);
    expect(fileTransfer.adoptIntoAttachmentCache).toHaveBeenCalledWith(
      "file:///rung2.jpg",
      "a.jpg",
    );
    const discarded = fileTransfer.discardPickerCopy.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(discarded).toEqual(
      expect.arrayContaining(["file:///rung0.jpg", "file:///rung1.jpg"]),
    );
    expect(discarded).not.toContain("file:///rung2.jpg");
  });
});
