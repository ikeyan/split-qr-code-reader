import { strict as assert } from "node:assert";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { type RasterReader, scanRaster } from "../src/scan.ts";
import { cameraFrame } from "./camera-frames.ts";
import { VideoScanner } from "../src/video-scan.ts";

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);
for (const angle of [0, .65]) {
  Deno.test(`small rotated camera QR with blur and clutter: bend ${angle}`, async () => {
    let found = 0;
    const missed: number[] = [];
    for (let i = 0; i < 12; i++) {
      const sample = cameraFrame(531007 + i * 4327, i, angle);
      const reads = await scanRaster(sample.image, reader, "auto");
      if (
        reads.some((code) =>
          code.bytes.length === sample.expected.length &&
          code.bytes.every((b, j) => b === sample.expected[j])
        )
      ) found++;
      else missed.push(i);
    }
    console.log({ angle, found, missed });
    assert.ok(found >= 11, `only ${found}/12 small QR frames decoded`);
  });
}

Deno.test("defocused camera clips acquire exact bytes within four frames before and after bending", async () => {
  let found = 0;
  for (let i = 0; i < 8; i++) {
    const scanner = new VideoScanner();
    for (let frame = 0; frame < 4; frame++) {
      const sample = cameraFrame(
        815021 + i * 1373,
        i % 2,
        .45 * (i % 2),
        frame,
        1,
      );
      const reads = await scanner.scan(sample.image, reader, "auto");
      if (
        reads.some((code) =>
          code.bytes.length === sample.expected.length &&
          code.bytes.every((b, j) => b === sample.expected[j])
        )
      ) {
        found++;
        break;
      }
    }
  }
  console.log({ defocused: found });
  assert.ok(found >= 7, `only ${found}/8 defocused frames decoded`);
});

Deno.test("a moving camera QR stays readable between enhanced frames", async () => {
  let found = 0;
  const scanner = new VideoScanner();
  for (let frame = 0; frame < 9; frame++) {
    const sample = cameraFrame(531007, 0, .65, frame);
    const reads = await scanner.scan(sample.image, reader, "auto");
    if (
      reads.some((code) =>
        code.bytes.length === sample.expected.length &&
        code.bytes.every((b, j) => b === sample.expected[j])
      )
    ) found++;
  }
  assert.ok(found >= 8, `only ${found}/9 consecutive moving frames decoded`);
  const empty = {
    width: 1280,
    height: 720,
    data: new Uint8ClampedArray(1280 * 720 * 4).fill(255),
  };
  assert.equal(
    (await scanner.scan(empty, reader, "auto")).length,
    0,
    "an absent code must not be returned from cached geometry",
  );
});
