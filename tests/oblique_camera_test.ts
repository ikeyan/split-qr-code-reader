import { strict as assert } from "node:assert";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { VideoScanner } from "../src/video-scan.ts";
import { type RasterReader } from "../src/scan.ts";
import { curvedPaper } from "./curved-paper.ts";

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);

Deno.test("oblique camera acquires a complete bent QR beside a clipped QR within four frames", async () => {
  let acquired = 0;
  const missed: number[] = [];
  for (let i = 0; i < 8; i++) {
    const index = i % 4 + (i < 4 ? 0 : 8);
    const sample = curvedPaper(864193 + i * 7919, index, {
      version: 9,
      resolution: 2,
      angle: .9,
      pitch: i < 4 ? -.3 : .1,
      yaw: i < 4 ? .1 : -.3,
    });
    const other = curvedPaper(418173 + i * 1543, index, {
      version: 9,
      resolution: 2,
      angle: 0,
    });
    const width = 1400,
      height = 1400,
      data = new Uint8ClampedArray(width * height * 4);
    data.fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = x < 850 ? sample.image : other.image;
        const sx = x < 850 ? x + 200 : x - 850;
        if (sx < source.width) {
          data.set(
            source.data.subarray(
              (y * source.width + sx) * 4,
              (y * source.width + sx) * 4 + 4,
            ),
            (y * width + x) * 4,
          );
        }
      }
    }
    const scanner = new VideoScanner();
    let found = false;
    for (let frame = 0; frame < 4; frame++) {
      let pureAttempts = 0;
      const reads = await scanner.scan(
        { width, height, data },
        (image, options) => {
          if (options.isPure) pureAttempts++;
          return reader(image, options);
        },
      );
      assert.ok(
        pureAttempts <= 10,
        "at most five surface hypotheses and their threshold retries per frame",
      );
      assert.ok(
        reads.every((code) =>
          code.bytes.length === sample.expected.length &&
          code.bytes.every((b, j) => b === sample.expected[j])
        ),
        "unexpected payload",
      );
      if (reads.length) {
        found = true;
        break;
      }
    }
    if (found) acquired++;
    else missed.push(i);
  }
  console.log(`acquired: ${acquired}/8; missed: ${missed}`);
  assert.ok(acquired >= 7, `only ${acquired}/8 camera clips acquired`);
});
