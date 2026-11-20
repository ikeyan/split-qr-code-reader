import { strict as assert } from "node:assert";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { type RasterReader, scanRaster } from "../src/scan.ts";
import { curvedPaper } from "./curved-paper.ts";
import { sampleQrSurface } from "../src/qr-surface.ts";
import { correctIllumination } from "../src/illumination.ts";

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);

// Independent 3D rendering: denser symbols, an off-center bend, and a camera
// inclined toward either side of the cylinder. No captured-image fixtures.
for (
  const [name, seed, count] of [
    ["development", 735911, 16],
    ["holdout", 591337, 32],
  ] as const
) {
  Deno.test(`oblique curved paper: ${name} >= 90% exact reads`, async () => {
    let successes = 0;
    const missed: number[] = [];
    for (let i = 0; i < count; i++) {
      const vertical = Math.floor(i / 8) % 2 === 0;
      const tilt = (i % 2 ? 1 : -1) * (.25 + (i % 3) * .05);
      const sample = curvedPaper(seed + i * 7919, i, {
        version: [7, 8, 9, 10][i % 4],
        angle: .9,
        resolution: 2,
        pitch: vertical ? tilt : .1,
        yaw: vertical ? .1 : tilt,
        bendOffset: i % 2 ? -.08 : .08,
      });
      const oracle = sampleQrSurface(
        correctIllumination(sample.image, "mean"),
        {
          size: sample.size,
          score: 0,
          parameters: [],
          map: (u, v) =>
            sample.point((u + 1) * sample.size / 2, (v + 1) * sample.size / 2),
        },
      );
      assert.ok(
        (await reader(oracle.raster, {
          formats: ["QRCode"],
          isPure: true,
          binarizer: "FixedThreshold",
        })).some((code) =>
          code.bytes.length === sample.expected.length &&
          code.bytes.every((b, j) => b === sample.expected[j])
        ),
        `generated fixture ${i} must be readable with the ground-truth lattice`,
      );
      const reads = await scanRaster(sample.image, reader, "auto");
      const matches = (code: typeof reads[number]) =>
        code.bytes.length === sample.expected.length &&
        code.bytes.every((b, j) => b === sample.expected[j]) &&
        (sample.symbol
          ? code.sequenceIndex === sample.symbol.index &&
            code.sequenceSize === sample.symbol.count &&
            Number(code.sequenceId) === sample.symbol.parity
          : code.sequenceSize < 0);
      assert.ok(reads.every(matches), "unexpected payload or append metadata");
      const correct = reads.find(matches);
      if (correct) {
        successes++;
        const n = sample.size,
          corners = [
            sample.point(0, 0),
            sample.point(n, 0),
            sample.point(n, n),
            sample.point(0, n),
          ];
        const pitch = (Math.hypot(
          corners[0].x - corners[1].x,
          corners[0].y - corners[1].y,
        ) +
          Math.hypot(
            corners[0].x - corners[3].x,
            corners[0].y - corners[3].y,
          )) / (2 * n);
        const p = correct.position;
        [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].forEach((
          point,
          j,
        ) =>
          assert.ok(
            Math.hypot(point.x - corners[j].x, point.y - corners[j].y) <
              pitch * 2.5,
            "corners must map back to the original oblique surface",
          )
        );
      } else missed.push(i);
    }
    console.log(`${name}: ${successes}/${count}; missed: ${missed}`);
    assert.ok(
      successes >= Math.ceil(count * .9),
      `only ${successes}/${count} exact reads`,
    );
  });
}
