import { PNG } from "pngjs";
import { Buffer } from "node:buffer";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { type RasterReader, scanRaster } from "../src/scan.ts";
import { limitRaster } from "../src/illumination.ts";

if (Deno.args.length !== 1) {
  throw new Error("使い方: deno task verify-png /tmp/確認する画像.png");
}
const image = PNG.sync.read(Buffer.from(await Deno.readFile(Deno.args[0])));
await prepareZXingModule({
  overrides: { wasmBinary: await Deno.readFile("vendor/zxing_reader.wasm") },
  fireImmediately: true,
});
const reader: RasterReader = async (raster, options) => {
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data.set(raster.data);
  return await readBarcodes(PNG.sync.write(png), options);
};
// Match the browser's 2048px input bound before applying the shared scan pipeline.
const raster = limitRaster({
  width: image.width,
  height: image.height,
  data: new Uint8ClampedArray(image.data),
}, 2048);
const codes = await scanRaster(raster, reader, "auto");
const original = (p: { x: number; y: number }) => ({
  x: p.x * image.width / raster.width,
  y: p.y * image.height / raster.height,
});
console.log(JSON.stringify(
  codes.map((code) => ({
    text: code.text,
    bytes: Array.from(code.bytes),
    version: code.version,
    sequenceIndex: code.sequenceIndex,
    sequenceSize: code.sequenceSize,
    sequenceId: code.sequenceId,
    position: {
      topLeft: original(code.position.topLeft),
      topRight: original(code.position.topRight),
      bottomRight: original(code.position.bottomRight),
      bottomLeft: original(code.position.bottomLeft),
    },
  })),
  null,
  2,
));
if (!codes.length) Deno.exit(1);
