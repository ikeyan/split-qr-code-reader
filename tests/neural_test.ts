import { strict as assert } from "node:assert";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { CameraTrace } from "../src/camera-trace.ts";
import { VideoScanner } from "../src/video-scan.ts";
import type { NeuralModels } from "../src/nn-runtime.ts";
import { GpuNetworks, parseNetworks } from "../src/nn-runtime.ts";
import { referenceNetworks } from "./nn-reference.ts";
import { curvedPaper } from "./curved-paper.ts";
import { frameFeatures, meshSurface, neuralReads } from "../src/neural-scan.ts";

const models = parseNetworks(
  await Deno.readTextFile("vendor/qr-networks.json"),
);
const runner = referenceNetworks(models);
await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader = (
  image: Parameters<typeof neuralReads>[0],
  options: Parameters<Parameters<typeof neuralReads>[1]>[1],
) => readBarcodesFromImageData(image as ImageData, options);
Deno.test("learned surface predicts an independent renderer across pose and bend directions", async () => {
  let squared = 0, count = 0;
  for (let i = 0; i < 16; i++) {
    const tilt = (i % 2 ? 1 : -1) * Math.PI / 6,
      index = i % 4 + (i < 8 ? 0 : 8);
    const sample = curvedPaper(471199 + i * 1823, index, {
      version: 7 + i % 4,
      angle: .7,
      resolution: 2,
      pitch: i < 8 ? tilt : 0,
      yaw: i < 8 ? 0 : tilt,
    });
    const n = sample.size,
      frames = [[3.5, 3.5], [n - 3.5, 3.5], [3.5, n - 3.5]].map(([x, y]) => {
        const p = sample.point(x, y),
          dx = sample.point(x + .01, y),
          dy = sample.point(x, y + .01);
        return [
          p.x,
          p.y,
          (dx.x - p.x) * 100,
          (dx.y - p.y) * 100,
          (dy.x - p.x) * 100,
          (dy.y - p.y) * 100,
        ];
      });
    const prediction = await runner.run("surface", frameFeatures(frames, n), 1),
      surface = meshSurface(frames, n, prediction),
      span = Math.hypot(
        frames[1][0] - frames[0][0],
        frames[1][1] - frames[0][1],
      );
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const p = surface.map(x / 4 - 1, y / 4 - 1),
          q = sample.point(x / 8 * n, y / 8 * n);
        squared += ((p.x - q.x) ** 2 + (p.y - q.y) ** 2) / (span * span);
        count++;
      }
    }
  }
  assert.ok(
    Math.sqrt(squared / count) < .01,
    "surface error must stay below one percent of symbol width",
  );
});
Deno.test("many finder markers in one frame yield separate learned QR surfaces", async () => {
  const samples = [0, 1, 2].map((i) =>
    curvedPaper(581239 + i * 7919, i === 2 ? 4 : i, {
      version: 7,
      angle: .65,
      roll: 0,
    })
  );
  const width = 1800,
    height = 700,
    data = new Uint8ClampedArray(width * height * 4);
  for (const [i, s] of samples.entries()) {
    for (let y = 0; y < height; y++) {
      data.set(
        s.image.data.subarray(y * 600 * 4, (y + 1) * 600 * 4),
        (y * width + i * 600) * 4,
      );
    }
  }
  const reads = await neuralReads(
    { width, height, data },
    reader,
    runner,
    "neural",
  );
  for (const s of samples) {
    const correct = reads.find((c) =>
      c.bytes.length === s.expected.length &&
      c.bytes.every((b, i) => b === s.expected[i])
    );
    if (s.symbol) {
      assert.equal(correct?.sequenceIndex, s.symbol.index);
      assert.equal(correct?.sequenceSize, s.symbol.count);
      assert.equal(Number(correct?.sequenceId), s.symbol.parity);
    }
    assert.ok(
      reads.some((c) =>
        c.bytes.length === s.expected.length &&
        c.bytes.every((b, i) => b === s.expected[i])
      ),
      "every visible QR must be recovered",
    );
  }
  assert.ok(
    reads.every((c) =>
      samples.some((s) =>
        c.bytes.length === s.expected.length &&
        c.bytes.every((b, i) => b === s.expected[i])
      )
    ),
  );
});
Deno.test("unavailable WebGPU initializes the classical fallback", async () => {
  assert.equal(await GpuNetworks.create(null), undefined);
  assert.equal(
    await GpuNetworks.create({ requestAdapter: async () => null }),
    undefined,
  );
  assert.equal(
    await GpuNetworks.create({
      requestAdapter: async () => {
        throw new Error("denied");
      },
    }),
    undefined,
  );
  assert.throws(() => parseNetworks('{"format":"unknown"}'));
});

Deno.test("three finder-like squares without timing lines do not reach the learned grid", async () => {
  const width = 560, height = 450;
  for (const pitch of [4, 7, 10]) {
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(255);
    for (const [left, top] of [[65, 58], [345, 75], [49, 323]]) {
      for (let y = 0; y < 7 * pitch; y++) {
        for (let x = 0; x < 7 * pitch; x++) {
          const d = Math.max(
            Math.abs(Math.floor(x / pitch) - 3),
            Math.abs(Math.floor(y / pitch) - 3),
          );
          if (d !== 3 && d > 1) continue;
          const offset = ((top + y) * width + left + x) * 4;
          data.fill(25, offset, offset + 3);
        }
      }
    }
    const trace = new CameraTrace();
    let surfaceJobs = 0;
    const reads = await neuralReads(
      { width, height, data },
      reader,
      {
        run(name, input, count) {
          if (name === "surface") surfaceJobs += count;
          return runner.run(name, input, count);
        },
      },
      "neural",
      [],
      trace,
    );
    assert.ok(trace.frame.passes["structure-rejected"]);
    assert.deepEqual(reads, []);
    assert.equal(surfaceJobs, 0, `pitch ${pitch}`);
    const classical = new CameraTrace();
    assert.deepEqual(
      await new VideoScanner().scan(
        { width, height, data },
        reader,
        "curve",
        undefined,
        classical,
      ),
      [],
    );
    const grids = classical.frame.passes.classical ?? 0;
    assert.ok(grids < 5, `pitch ${pitch}: ${grids} classical grids`);
  }
});
