import { strict as assert } from "node:assert";
import { PNG } from "pngjs";
import {
  prepareZXingModule,
  readBarcodes,
  type ReadResult,
} from "zxing-wasm/reader";
import { type RasterReader, scanRaster } from "../src/scan.ts";
import { contains } from "../src/geometry.ts";
import { curvedPaper } from "./curved-paper.ts";
import { Byte, Encoder } from "@nuintun/qrcode";
import { qrFunctionMarks } from "../src/qr-surface.ts";

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = async (image, options) => {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return await readBarcodes(PNG.sync.write(png), options);
};
function matches(code: ReadResult, sample: ReturnType<typeof curvedPaper>) {
  const { expected, symbol } = sample;
  return code.isValid !== false && code.bytes.length === expected.length &&
    code.bytes.every((v, i) => v === expected[i]) &&
    (symbol
      ? code.sequenceIndex === symbol.index &&
        code.sequenceSize === symbol.count &&
        Number(code.sequenceId) === symbol.parity
      : code.sequenceSize < 0);
}
for (
  const [name, seed] of [["development", 842017], ["holdout", 291853]] as const
) {
  Deno.test(`independent curved paper with poor lighting: ${name} >= 90% exact reads`, async () => {
    const count = name === "development" ? 32 : 128;
    let successes = 0;
    const failures: number[] = [];
    for (let i = 0; i < count; i++) {
      const sample = curvedPaper(seed + i * 7919, i),
        reads = await scanRaster(sample.image, reader, "auto");
      const correct = reads.find((code) => matches(code, sample));
      // Never accept plausible text or the first decoded symbol as ground truth.
      assert.ok(
        reads.every((code) => matches(code, sample)),
        "unexpected payload or structured-append header",
      );
      if (correct) {
        successes++;
        const p = correct.position;
        assert.ok(
          contains(
            [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft],
            sample.center,
          ),
          "coordinates must cover the original QR",
        );
        const n = sample.size,
          expected = [
            sample.point(0, 0),
            sample.point(n, 0),
            sample.point(n, n),
            sample.point(0, n),
          ];
        [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].forEach(
          (point, j) => {
            assert.ok(
              Math.hypot(point.x - expected[j].x, point.y - expected[j].y) <
                sample.image.width / n * 2,
              "corners must map back to the source image",
            );
          },
        );
      } else failures.push(i);
    }
    console.log(
      `${name}: ${successes}/${count}; missed indices: ${failures.join(",")}`,
    );
    assert.ok(
      successes >= Math.ceil(count * .9),
      `only ${successes}/${count} exact reads`,
    );
  });
}

Deno.test("QR function patterns agree with an independent encoder for versions 1 through 40", () => {
  for (let version = 1; version <= 40; version++) {
    const qr = new Encoder({ version, level: "M" }).encode(new Byte("test"));
    for (const mark of qrFunctionMarks(qr.size)) {
      const x = Math.floor((mark.u + 1) * qr.size / 2),
        y = Math.floor((mark.v + 1) * qr.size / 2);
      assert.equal(
        qr.get(x, y) === 1,
        mark.dark,
        `version ${version}, module ${x},${y}`,
      );
    }
  }
});

Deno.test("three finder patterns without a QR payload are never accepted", async () => {
  const scale = 6,
    size = 25,
    width = (size + 8) * scale,
    data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const dark = x === 0 || x === 6 || y === 0 || y === 6 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4);
        if (dark) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const i =
                (((top + y + 4) * scale + dy) * width + (left + x + 4) * scale +
                  dx) * 4;
              data[i] = data[i + 1] = data[i + 2] = 0;
            }
          }
        }
      }
    }
  }
  assert.deepEqual(
    await scanRaster({ width, height: width, data }, reader, "auto"),
    [],
  );
});

Deno.test("a large curved camera frame keeps source coordinates and bounds surface decode attempts", async () => {
  const sample = curvedPaper(842017, 0), factor = 3;
  const width = sample.image.width * factor,
    height = sample.image.height * factor;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from =
        (Math.floor(y / factor) * sample.image.width + Math.floor(x / factor)) *
        4;
      data.set(sample.image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  let pureAttempts = 0;
  const counted: RasterReader = (image, options) => {
    if (options.isPure) pureAttempts++;
    return reader(image, options);
  };
  const reads = await scanRaster(
    { width, height, data },
    counted,
    "curve",
    true,
    0,
  );
  const code = reads.find((code) => matches(code, sample));
  assert.ok(code, "the first camera cycle must recover this generated frame");
  assert.ok(
    pureAttempts > 0 && pureAttempts <= 2,
    "at most one surface and its threshold retry per frame",
  );
  const p = code.position;
  assert.ok(contains([p.topLeft, p.topRight, p.bottomRight, p.bottomLeft], {
    x: sample.center.x * factor,
    y: sample.center.y * factor,
  }));
  const expected = sample.point(0, 0);
  assert.ok(
    Math.hypot(
      p.topLeft.x - expected.x * factor,
      p.topLeft.y - expected.y * factor,
    ) < 20,
  );
});
