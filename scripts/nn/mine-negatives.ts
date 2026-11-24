import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { neuralReads } from "../../src/neural-scan.ts";
import { parseNetworks } from "../../src/nn-runtime.ts";
import { locatingOptions, type RasterReader } from "../../src/scan.ts";
import { referenceNetworks } from "../../tests/nn-reference.ts";

const [photos, output, weights = "vendor/qr-networks.json"] = Deno.args;
if (!photos || !output) {
  throw new Error("Usage: mine-negatives.ts PHOTOS OUTPUT [WEIGHTS]");
}
await Deno.mkdir(output, { recursive: true });
await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const runner = referenceNetworks(
  parseNetworks(await Deno.readTextFile(weights)),
);
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);
const files = (await Array.fromAsync(Deno.readDir(photos)))
  .filter((file) => file.isFile && file.name.endsWith(".png")).map((file) =>
    file.name
  ).sort();

const collected = new Error("Marker inference completed");
let total = 0;
for (const file of files) {
  const png = PNG.sync.read(
    Buffer.from(await Deno.readFile(`${photos}/${file}`)),
  );
  const image = {
    data: new Uint8ClampedArray(png.data),
    width: png.width,
    height: png.height,
  };
  const raw = await reader(image, locatingOptions);
  if (raw.some((code) => code.isValid)) {
    console.log(`Skipped image containing a readable QR: ${file}`);
    continue;
  }
  try {
    // Capture actual model inputs from the same proposals as the camera,
    // including provisional triples and individual components.
    await neuralReads(
      image,
      reader,
      {
        async run(name, input, count) {
          const outputs = await runner.run(name, input, count);
          const positive = Array.from({ length: count }, (_, i) => ({
            i,
            score: outputs[i * 7 + 6],
          })).filter(({ score }) => score >= 0).sort((a, b) =>
            b.score - a.score
          )
            .slice(0, 32);
          if (positive.length) {
            const patches = new Float32Array(positive.length * 1024);
            for (
              const [{ i }, row] of positive.map((candidate, row) =>
                [candidate, row] as const
              )
            ) {
              patches.set(input.subarray(i * 1024, (i + 1) * 1024), row * 1024);
            }
            total += positive.length;
            await Deno.writeFile(
              `${output}/${file.slice(0, -4)}.f32`,
              new Uint8Array(patches.buffer),
            );
          }
          throw collected;
        },
      },
      "neural",
      raw,
    );
  } catch (error) {
    if (error !== collected) throw error;
  }
}
console.log(
  `${files.length} source photos, ${total} positive marker proposals`,
);
