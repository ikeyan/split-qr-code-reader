import { strict as assert } from "node:assert";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { CameraTrace } from "../src/camera-trace.ts";
import type { RasterReader } from "../src/scan.ts";
import { VideoScanner } from "../src/video-scan.ts";
import { curvedPaper } from "./curved-paper.ts";

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);

Deno.test("camera diagnostics preserve decoding and map the grid back to the analyzed frame", async () => {
  const { image, expected } = curvedPaper(842017, 0);
  const scanner = new VideoScanner(), control = new VideoScanner();
  for (let i = 0; i < 4; i++) {
    const trace = new CameraTrace();
    const codes = await scanner.scan(image, reader, "curve", undefined, trace);
    assert.deepEqual(codes, await control.scan(image, reader, "curve"));
    const debug = structuredClone(trace.finish(codes));
    assert.equal(debug.passes.original, 1);
    const grid = debug.grids.find((grid) => grid.outcome === "decoded");
    if (!grid) continue;
    assert.ok(
      codes.some((code) =>
        code.bytes.every((v, j) => v === expected[j]) &&
        code.bytes.length === expected.length
      ),
    );
    assert.equal(grid.pass, "classical");
    assert.ok(debug.candidates.some((c) => c.selected));
    assert.ok(debug.markers.length > 0);
    assert.ok(grid.sample?.gray.some((value) => value < 100));
    assert.ok(debug.decoded.length > 0);
    const points = grid.lines.flat();
    assert.ok(points.every((p) =>
      p.x >= 0 && p.x < image.width &&
      p.y >= 0 && p.y < image.height
    ));
    const topLeft = debug.decoded[0].topLeft;
    assert.ok(
      Math.hypot(points[0].x - topLeft.x, points[0].y - topLeft.y) < 12,
    );
    return;
  }
  assert.fail(
    "Generated curved QR should yield a decoded surface with diagnostics",
  );
});
