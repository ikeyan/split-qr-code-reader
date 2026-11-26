import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import {
  prepareZXingModule,
  readBarcodesFromImageData,
} from "zxing-wasm/reader";
import { CameraTrace } from "../../src/camera-trace.ts";
import { neuralReads } from "../../src/neural-scan.ts";
import { parseNetworks } from "../../src/nn-runtime.ts";
import { locatingOptions, type RasterReader } from "../../src/scan.ts";
import { referenceNetworks } from "../../tests/nn-reference.ts";

const [photos, before, after, shard = "0/1"] = Deno.args;
if (!photos || !before || !after) {
  throw new Error(
    "Usage: evaluate-backgrounds.ts PHOTOS BEFORE AFTER [SHARD/TOTAL]",
  );
}
const [part, parts] = shard.split("/").map(Number);
if (
  !Number.isInteger(part) || !Number.isInteger(parts) || part < 0 ||
  part >= parts
) {
  throw new Error("Expected a zero-based shard index, for example 0/4");
}
const files = (await Array.fromAsync(Deno.readDir(photos)))
  .filter((file) => file.isFile && file.name.endsWith(".png")).map((file) =>
    file.name
  ).sort().filter((_, i) => i % parts === part);

await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = (image, options) =>
  readBarcodesFromImageData(image as ImageData, options);
const models = await Promise.all([before, after].map(async (path) => ({
  runner: referenceNetworks(parseNetworks(await Deno.readTextFile(path))),
  trials: 0,
  imagesWithTrials: 0,
  decoded: 0,
})));
let excluded = 0;
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
    excluded++;
    continue;
  }
  for (const model of models) {
    const trace = new CameraTrace();
    const decoded = await neuralReads(
      image,
      reader,
      model.runner,
      "neural",
      raw,
      trace,
    );
    const trials = trace.frame.surfaceAttempts.neural;
    model.trials += trials;
    model.imagesWithTrials += Number(trials > 0);
    model.decoded += decoded.length;
  }
}
console.log(JSON.stringify({
  images: files.length - excluded,
  excluded,
  models: models.map(({ trials, imagesWithTrials, decoded }) => ({
    trials,
    imagesWithTrials,
    decoded,
  })),
}));
