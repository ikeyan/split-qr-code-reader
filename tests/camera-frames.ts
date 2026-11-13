import { curvedPaper } from "./curved-paper.ts";
import type { Raster } from "../src/image-enhance.ts";

/** Independent, moving, small QR scenes; no recorded pixels or decoded receipt data. */
export function cameraFrame(
  seed: number,
  index: number,
  angle: number,
  step = 0,
  defocus = 0,
) {
  const sample = curvedPaper(seed, index, {
    angle,
    roll: (index % 4) * Math.PI / 2 + .12,
  });
  const scale = .4 + (index % 3) * .12, width = 1280, height = 720;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4,
        value = 110 + 35 * Math.sin(x / 190) + y / 20;
      const text = y % 47 < 7 && x % 21 < 13 && y < 200;
      data[k] = data[k + 1] = data[k + 2] = text ? 40 : value;
      data[k + 3] = 255;
    }
  }
  const left = 260 + (index * 83) % 300 + step * 3, top = 180 + step * 2;
  const w = Math.round(sample.image.width * scale),
    h = Math.round(sample.image.height * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from =
        (Math.min(sample.image.height - 1, Math.floor((y + .5) / scale)) *
            sample.image.width +
          Math.min(sample.image.width - 1, Math.floor((x + .5) / scale))) * 4;
      data.set(
        sample.image.data.subarray(from, from + 4),
        ((y + top) * width + x + left) * 4,
      );
    }
  }
  // Optical blur independent of the surface model, and varying subpixel alignment.
  const blurred = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * width + x) * 4 + c;
        blurred[i] = data[i] * .6 +
          (data[i - 4] + data[i + 4] + data[i - width * 4] +
              data[i + width * 4]) * .1;
      }
    }
  }
  if (defocus) {
    const radius = Math.ceil(defocus * 2),
      kernel = Array.from(
        { length: radius * 2 + 1 },
        (_, i) => Math.exp(-((i - radius) ** 2) / (2 * defocus ** 2)),
      ),
      sum = kernel.reduce((a, b) => a + b, 0);
    const horizontal = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let k = -radius; k <= radius; k++) {
            v += blurred[
              (y * width + Math.max(0, Math.min(width - 1, x + k))) * 4 + c
            ] * kernel[k + radius] / sum;
          }
          horizontal[(y * width + x) * 3 + c] = v;
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let k = -radius; k <= radius; k++) {
            v += horizontal[
              (Math.max(0, Math.min(height - 1, y + k)) * width + x) * 3 + c
            ] * kernel[k + radius] / sum;
          }
          blurred[(y * width + x) * 4 + c] = v;
        }
      }
    }
  }
  return {
    image: { width, height, data: blurred } as Raster,
    expected: sample.expected,
    symbol: sample.symbol,
  };
}
