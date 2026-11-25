import { crc32, deflateSync } from "node:zlib";

/** 4×4 PNG of a random color: unique MD5, so never mistaken for an existing asset. */
export function randomPng(): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t), d]);
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const px = [0, 1, 2].map(() => Math.floor(Math.random() * 256));
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array.from({ length: 4 }, () => px).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
