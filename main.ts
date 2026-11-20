// news-image-20261120 — entry program.
//
// Copies the bundled front-page image (entry.png) to the output directory
// as entry.png, after checking it is a whole, in-limits PNG. Node 22,
// standard library only, no network, no dependencies.
//
// Validation order:
//   1. entry.png exists and is at most 1 MiB (1048576 bytes);
//   2. the first 8 bytes are the PNG signature;
//   3. the first chunk is a 13-byte IHDR whose width and height are each
//      between 1 and 1024 pixels and whose bit depth, colour type and
//      methods are values the PNG spec allows;
//   4. every chunk in turn: its length fits inside the file and the CRC-32
//      stored after its data matches the bytes it covers; at least one
//      IDAT chunk must be present, so the file carries image data;
//   5. the file ends with an empty IEND chunk and nothing follows it.
// Any failure is reported on stderr and exits non-zero; nothing is copied.
// On success the file is copied byte for byte, so two runs write identical
// bytes. Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for
// /output:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (IEEE 802.3, polynomial 0xEDB88320), table built once at startup.
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fail(message: string): never {
  console.error(`entry check failed: ${message}`);
  process.exit(1);
}

function checkPng(data: Buffer): void {
  if (data.length < 8 + 25) {
    fail(`file is only ${data.length} bytes, too short to be a PNG`);
  }
  if (!data.subarray(0, 8).equals(PNG_MAGIC)) {
    fail("first 8 bytes are not the PNG signature");
  }

  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (offset < data.length) {
    if (offset + 8 > data.length) {
      fail(`chunk header at byte ${offset} is cut off`);
    }
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd + 4 > data.length) {
      fail(`chunk ${type} at byte ${offset} runs past the end of the file`);
    }
    const stored = data.readUInt32BE(bodyEnd);
    const actual = crc32(data.subarray(offset + 4, bodyEnd));
    if (stored !== actual) {
      fail(`chunk ${type} at byte ${offset} has a bad CRC`);
    }

    if (!sawIhdr) {
      if (type !== "IHDR") {
        fail(`first chunk is ${type}, not IHDR`);
      }
      if (length !== 13) {
        fail(`IHDR is ${length} bytes, expected 13`);
      }
      const width = data.readUInt32BE(bodyStart);
      const height = data.readUInt32BE(bodyStart + 4);
      if (width < 1 || height < 1) {
        fail(`image has a zero dimension (${width}x${height})`);
      }
      if (width > MAX_SIDE || height > MAX_SIDE) {
        fail(`image is ${width}x${height}, over the ${MAX_SIDE}x${MAX_SIDE} limit`);
      }
      // IHDR fields the gate's "whole image" check also depends on: a bit
      // depth and colour type the PNG spec allows, and the standard
      // deflate/interlace methods, so a corrupt header cannot slip past
      // the CRC check alone.
      const bitDepth = data[bodyStart + 8];
      const colourType = data[bodyStart + 9];
      const compression = data[bodyStart + 10];
      const filter = data[bodyStart + 11];
      const interlace = data[bodyStart + 12];
      if (![1, 2, 4, 8, 16].includes(bitDepth)) {
        fail(`IHDR bit depth ${bitDepth} is not a PNG bit depth`);
      }
      if (![0, 2, 3, 4, 6].includes(colourType)) {
        fail(`IHDR colour type ${colourType} is not a PNG colour type`);
      }
      if (colourType === 3 && bitDepth === 16) {
        fail("IHDR pairs palette colour type with 16-bit depth");
      }
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        fail(`IHDR methods are not standard (compression ${compression}, filter ${filter}, interlace ${interlace})`);
      }
      sawIhdr = true;
    }

    if (type === "IDAT") {
      sawIdat = true;
    }

    if (type === "IEND") {
      if (length !== 0) {
        fail(`IEND carries ${length} bytes, expected none`);
      }
      if (bodyEnd + 4 !== data.length) {
        fail("bytes follow the IEND chunk");
      }
      sawIend = true;
      break;
    }

    offset = bodyEnd + 4;
  }

  if (!sawIhdr) fail("no IHDR chunk found");
  if (!sawIdat) fail("no IDAT chunk found: the PNG carries no image data");
  if (!sawIend) fail("no IEND chunk found: the PNG is truncated");
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "entry.png");
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

  let size: number;
  try {
    size = statSync(source).size;
  } catch {
    fail(`cannot stat ${source}: file missing`);
  }
  if (size > MAX_BYTES) {
    fail(`entry.png is ${size} bytes, over the ${MAX_BYTES} byte limit`);
  }

  const data = readFileSync(source);
  checkPng(data);

  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, "entry.png");
  copyFileSync(source, target);

  // Re-read the copy and confirm it matches byte for byte.
  if (!readFileSync(target).equals(data)) {
    fail(`copy at ${target} differs from entry.png`);
  }
  console.log(`ok: entry.png (${size} bytes) written to ${target}`);
}

main();
