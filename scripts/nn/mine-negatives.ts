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

const [photos, output, weights = "vendor/qr-networks.json", shard = "0/1"] =
  Deno.args;
if (!photos || !output) {
  throw new Error(
    "Usage: mine-negatives.ts PHOTOS OUTPUT [WEIGHTS] [SHARD/TOTAL]",
  );
}
const [part, parts, ...extra] = shard.split("/").map(Number);
if (
  !Number.isInteger(part) || !Number.isInteger(parts) || part < 0 ||
  part >= parts || extra.length
) throw new Error("Expected a zero-based shard index, for example 0/4");
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
  ).sort().filter((_, i) => i % parts === part);

// Skip strongly matching finder patches even if ZXing cannot read the image.
function looksLikeFinder(input: Float32Array, pose: Float32Array) {
  let dark = 0, light = 0, darkCount = 0, lightCount = 0;
  for (let y = -4; y <= 4; y++) {
    for (let x = -4; x <= 4; x++) {
      const u = pose[0] + x * pose[2] + y * pose[4];
      const v = pose[1] + x * pose[3] + y * pose[5];
      const i = Math.floor((u + 5.5) * 32 / 11);
      const j = Math.floor((v + 5.5) * 32 / 11);
      if (i < 0 || i >= 32 || j < 0 || j >= 32) return false;
      const value = input[j * 32 + i],
        radius = Math.max(Math.abs(x), Math.abs(y));
      if (radius <= 1 || radius === 3) {
        dark += Number(value < -.2);
        darkCount++;
      } else {
        light += Number(value > .2);
        lightCount++;
      }
    }
  }
  return dark / darkCount >= .85 && light / lightCount >= .85;
}

const collected = new Error("Marker inference completed");
let total = 0, recognized = 0, excludedFinders = 0;
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
    recognized++;
    await Deno.remove(`${output}/${file.slice(0, -4)}.f32`).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
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
          const positives = Array.from({ length: count }, (_, i) => ({
            pose: outputs.subarray(i * 7, (i + 1) * 7),
            patch: input.subarray(i * 1024, (i + 1) * 1024),
          })).filter(({ pose }) => pose[6] >= 0).sort((a, b) =>
            b.pose[6] - a.pose[6]
          );
          const selected = [];
          for (const { patch, pose } of positives) {
            if (looksLikeFinder(patch, pose)) {
              excludedFinders++;
              continue;
            }
            selected.push(patch);
            if (selected.length === 32) break;
          }
          const patches = new Float32Array(selected.length * 1024);
          selected.forEach((patch, i) => patches.set(patch, i * 1024));
          total += selected.length;
          await Deno.writeFile(
            `${output}/${file.slice(0, -4)}.f32`,
            new Uint8Array(patches.buffer),
          );
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
  `${files.length} images, ${total} mined patches, ${recognized} decoded QR images excluded, ${excludedFinders} finder-like patches excluded`,
);
