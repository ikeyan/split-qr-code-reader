import type { CameraTrace } from "./camera-trace.ts";
import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import type { NeuralRunner } from "./nn-runtime.ts";
import { locateQrCandidates, nestedFinders } from "./qr-finders.ts";
import type { QrCandidate } from "./curvature.ts";
import {
  alignmentMesh,
  refineFinderFrame,
  surfaceFromFrames,
} from "./qr-landmarks.ts";
import { sampleQrSurface, type Surface } from "./qr-surface.ts";
import { qrFunctionMarks } from "./qr-patterns.ts";
import { refineNeuralSurface } from "./nn-refine.ts";
import { timingEvidence } from "./qr-timing.ts";
import { readQrVersion } from "./qr-version.ts";
import { correctIllumination, limitRaster } from "./illumination.ts";
import {
  mergeReads,
  type RasterReader,
  sameLocation,
  scanOptions,
  validReads,
} from "./scan.ts";
export type SurfaceMethod = "classical" | "neural";
type Point = { x: number; y: number };
export function pixel(image: Raster, x: number, y: number): number {
  x -= .5;
  y -= .5;
  if (x < 0 || y < 0 || x >= image.width - 1 || y >= image.height - 1) return 1;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const gray = (i: number) =>
    (image.data[i] * .299 + image.data[i + 1] * .587 +
      image.data[i + 2] * .114) / 255;
  const i = (iy * image.width + ix) * 4;
  return gray(i) * (1 - fx) * (1 - fy) + gray(i + 4) * fx * (1 - fy) +
    gray(i + image.width * 4) * (1 - fx) * fy +
    gray(i + image.width * 4 + 4) * fx * fy;
}
function candidateMap(c: QrCandidate, x: number, y: number): Point {
  const p = c.position;
  return {
    x: p.topLeft.x * (1 - x) * (1 - y) + p.topRight.x * x * (1 - y) +
      p.bottomLeft.x * (1 - x) * y + p.bottomRight.x * x * y,
    y: p.topLeft.y * (1 - x) * (1 - y) + p.topRight.y * x * (1 - y) +
      p.bottomLeft.y * (1 - x) * y + p.bottomRight.y * x * y,
  };
}
export function markerInput(image: Raster, frame: number[]): Float32Array {
  const input = new Float32Array(1024);
  let sum = 0, squares = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const a = (x + .5) / 32 * 11 - 5.5,
        b = (y + .5) / 32 * 11 - 5.5,
        v = pixel(
          image,
          frame[0] + frame[2] * a + frame[4] * b,
          frame[1] + frame[3] * a + frame[5] * b,
        );
      input[y * 32 + x] = v;
      sum += v;
      squares += v * v;
    }
  }
  const mean = sum / 1024,
    std = Math.sqrt(Math.max(0, squares / 1024 - mean * mean)) + .1;
  return input.map((v) => (v - mean) / std);
}
export function frameFeatures(frames: number[][], size: number): Float32Array {
  const [a, b, c] = frames,
    ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = c[0] - a[0],
    vy = c[1] - a[1],
    det = ux * vy - uy * vx;
  const result = [];
  for (const p of frames) {
    result.push(
      (vy * p[2] - vx * p[3]) / det * (size - 7),
      (vy * p[4] - vx * p[5]) / det * (size - 7),
      (-uy * p[2] + ux * p[3]) / det * (size - 7),
      (-uy * p[4] + ux * p[5]) / det * (size - 7),
    );
  }
  return new Float32Array([...result, 7 / size]);
}
function cubic(a: number, b: number, c: number, d: number, t: number) {
  return b +
    .5 * t *
      (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}
export function meshSurface(
  frames: number[][],
  size: number,
  output: Float32Array,
): Surface {
  const [a, b, c] = frames,
    ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = c[0] - a[0],
    vy = c[1] - a[1];
  const coordinate = (x: number, y: number, k: number) => {
    const xx = x * 8,
      yy = y * 8,
      ix = Math.floor(xx),
      iy = Math.floor(yy),
      fx = xx - ix,
      fy = yy - iy;
    const get = (i: number, j: number) => {
      i = Math.max(0, Math.min(8, i));
      j = Math.max(0, Math.min(8, j));
      return output[(j * 9 + i) * 2 + k];
    };
    return cubic(
      ...[-1, 0, 1, 2].map((j) =>
        cubic(
          get(ix - 1, iy + j),
          get(ix, iy + j),
          get(ix + 1, iy + j),
          get(ix + 2, iy + j),
          fx,
        )
      ) as [number, number, number, number],
      fy,
    ) + (k === 0 ? x : y);
  };
  return {
    size,
    score: 0,
    parameters: [],
    fromFinders: true,
    map: (u, v) => {
      const x = coordinate((u + 1) / 2, (v + 1) / 2, 0),
        y = coordinate((u + 1) / 2, (v + 1) / 2, 1);
      return { x: a[0] + ux * x + vx * y, y: a[1] + uy * x + vy * y };
    },
  };
}
/** Multiple triples are evaluated independently. Payload decoding validates grouping. */
export async function neuralReads(
  image: Raster,
  reader: RasterReader,
  runner: NeuralRunner,
  method: SurfaceMethod,
  raw: ReadResult[] = [],
  trace?: CameraTrace,
): Promise<ReadResult[]> {
  const binary = correctIllumination(image, "mean");
  const smooth: Raster = {
    width: binary.width,
    height: binary.height,
    data: new Uint8ClampedArray(binary.data),
  };
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += binary.data[((y + dy) * image.width + x + dx) * 4];
        }
      }
      const i = (y * image.width + x) * 4;
      smooth.data[i] = smooth.data[i + 1] = smooth.data[i + 2] = sum / 9;
    }
  }
  const value = (x: number, y: number) => pixel(smooth, x, y);
  const known = validReads(raw);
  const candidates = [
    ...raw.filter((c) => c.isValid === false && /^\d+$/.test(c.version)),
    ...locateQrCandidates(image, known, true, trace),
  ];
  const jobs: { candidate: QrCandidate; initial: number[][] }[] = [];
  for (const candidate of candidates) {
    if (
      !Object.values(candidate.position).every((p) =>
        Number.isFinite(p.x) && Number.isFinite(p.y)
      )
    ) continue;
    const size = 17 + 4 * Number(candidate.version);
    if (!Number.isFinite(size) || size < 21 || size > 177) continue;
    const initial = [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5]].map(
      ([x, y]) => {
        const p = candidateMap(candidate, x / size, y / size),
          dx = candidateMap(candidate, (x + 1) / size, y / size),
          dy = candidateMap(candidate, x / size, (y + 1) / size);
        return [p.x, p.y, dx.x - p.x, dx.y - p.y, dy.x - p.x, dy.y - p.y];
      },
    );
    jobs.push({ candidate, initial });
  }
  const reduced = limitRaster(binary, 1024),
    blobs = nestedFinders(reduced, true),
    scaleX = image.width / reduced.width,
    scaleY = image.height / reduced.height;
  const blobFrames = blobs.map(
    (b) => [
      b.x * scaleX,
      b.y * scaleY,
      (b.pitchX ?? b.pitch) * scaleX,
      0,
      0,
      (b.pitchY ?? b.pitch) * scaleY,
    ],
  );
  const input = new Float32Array((jobs.length * 3 + blobFrames.length) * 1024);
  jobs.forEach((j, i) =>
    j.initial.forEach((p, k) =>
      input.set(markerInput(image, p), (i * 3 + k) * 1024)
    )
  );
  blobFrames.forEach((p, i) =>
    input.set(markerInput(image, p), (jobs.length * 3 + i) * 1024)
  );
  trace?.pass("marker-nn");
  const predictions = await runner.run(
    "marker",
    input,
    jobs.length * 3 + blobFrames.length,
  );
  const surfaces: {
    frames: number[][];
    size: number;
    base: Surface;
    evidence: number;
  }[] = [];
  const timingValue = (x: number, y: number) => pixel(binary, x, y);
  const append = (candidate: QrCandidate, frames: number[][]): boolean => {
    const evidence = timingEvidence(frames, timingValue);
    if (!(evidence >= 1)) {
      trace?.pass("structure-rejected");
      return false;
    }
    trace?.candidate(candidate.position, "marker-nn", true);
    const copies = [frames[1], frames[2]].map((p, k) =>
      Array.from({ length: 18 }, (_, i) => {
        const x = k ? -3 + Math.floor(i / 3) : -7 + i % 3,
          y = k ? -7 + i % 3 : -3 + Math.floor(i / 3);
        return value(p[0] + p[2] * x + p[4] * y, p[1] + p[3] * x + p[5] * y);
      })
    );
    const version = readQrVersion(copies),
      estimated = Number(candidate.version);
    for (
      const v of version ? [version] : [
        estimated,
        estimated - 1,
        estimated + 1,
        estimated - 2,
        estimated + 2,
      ].filter((v) => v >= 1 && v <= 40)
    ) {
      const size = 17 + 4 * v,
        base: Surface = {
          size,
          score: 0,
          parameters: [],
          map: (u, v) => candidateMap(candidate, (u + 1) / 2, (v + 1) / 2),
        };
      if (frameFeatures(frames, size).every(Number.isFinite)) {
        surfaces.push({ frames, size, base, evidence });
      }
    }
    return true;
  };
  for (const [i, job] of jobs.entries()) {
    const frames: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const q = predictions.subarray((i * 3 + k) * 7, (i * 3 + k + 1) * 7),
        p = job.initial[k];
      if (q[6] < 0) break;
      const seed = [
        p[0] + p[2] * q[0] + p[4] * q[1],
        p[1] + p[3] * q[0] + p[5] * q[1],
        p[2] * q[2] + p[4] * q[4],
        p[3] * q[2] + p[5] * q[4],
        p[2] * q[3] + p[4] * q[5],
        p[3] * q[3] + p[5] * q[5],
      ];
      let fitted = refineFinderFrame(seed, value, false, .18);
      if (!fitted) {
        for (const sx of [.7, 1, 1.3]) {
          for (const sy of [.7, 1, 1.3]) {
            if (sx === 1 && sy === 1) continue;
            fitted = refineFinderFrame(
              [
                seed[0],
                seed[1],
                seed[2] * sx,
                seed[3] * sx,
                seed[4] * sy,
                seed[5] * sy,
              ],
              value,
              false,
              .18,
            );
            if (fitted) break;
          }
          if (fitted) break;
        }
      }
      if (!fitted) fitted = refineFinderFrame(p, value, true, .18);
      if (!fitted) break;
      trace?.markerFrame(fitted);
      frames.push(fitted);
    }
    if (frames.length !== 3) continue;
    append(job.candidate, frames);
  }
  const markers: number[][] = [];
  for (const [i, p] of blobFrames.entries()) {
    const q = predictions.subarray(
      (jobs.length * 3 + i) * 7,
      (jobs.length * 3 + i + 1) * 7,
    );
    if (q[6] < 1) continue;
    const seed = [
        p[0] + p[2] * q[0],
        p[1] + p[5] * q[1],
        p[2] * q[2],
        p[5] * q[4],
        p[2] * q[3],
        p[5] * q[5],
      ],
      fitted = refineFinderFrame(seed, value, false, .18);
    if (fitted) trace?.markerFrame(fitted);
    if (
      fitted &&
      !markers.some((m) =>
        Math.hypot(m[0] - fitted[0], m[1] - fitted[1]) <
          Math.hypot(fitted[2], fitted[3]) * 2
      )
    ) markers.push(fitted);
  }
  const oriented = (
    p: number[],
    ux: number,
    uy: number,
    vx: number,
    vy: number,
  ) => {
    const options = [p, [p[0], p[1], p[4], p[5], -p[2], -p[3]], [
      p[0],
      p[1],
      -p[2],
      -p[3],
      -p[4],
      -p[5],
    ], [p[0], p[1], -p[4], -p[5], p[2], p[3]]];
    return options.sort((a, b) =>
      (b[2] * ux + b[3] * uy + b[4] * vx + b[5] * vy) -
      (a[2] * ux + a[3] * uy + a[4] * vx + a[5] * vy)
    )[0];
  };
  let groups = 0;
  for (const a of markers) {
    for (const b of markers) {
      for (const c of markers) {
        if (a === b || a === c || b === c || groups >= 32) continue;
        const ux = b[0] - a[0],
          uy = b[1] - a[1],
          vx = c[0] - a[0],
          vy = c[1] - a[1],
          u = Math.hypot(ux, uy),
          v = Math.hypot(vx, vy);
        if (
          ux * vy - uy * vx <= 0 ||
          Math.abs(ux * vx + uy * vy) / (u * v) > .8 || u / v < .25 || u / v > 4
        ) continue;
        const frames = [a, b, c].map((p) =>
          oriented(p, ux / u, uy / u, vx / v, vy / v)
        );
        const pitch = frames.reduce((s, p) =>
          s + Math.max(Math.hypot(p[2], p[3]), Math.hypot(p[4], p[5])), 0) / 3;
        if (Math.min(u, v) < pitch * 12) {
          continue;
        }
        const version = Math.max(
            1,
            Math.min(40, Math.round((Math.max(u, v) / pitch + 7 - 17) / 4)),
          ),
          size = 17 + version * 4;
        const point = (x: number, y: number) => ({
          x: a[0] + ux * (x - 3.5) / (size - 7) + vx * (y - 3.5) / (size - 7),
          y: a[1] + uy * (x - 3.5) / (size - 7) + vy * (y - 3.5) / (size - 7),
        });
        if (
          append({
            version: String(version),
            position: {
              topLeft: point(0, 0),
              topRight: point(size, 0),
              bottomRight: point(size, size),
              bottomLeft: point(0, size),
            },
          }, frames)
        ) {
          groups++;
        }
      }
    }
  }
  surfaces.sort((a, b) => b.evidence - a.evidence);
  const features = new Float32Array(surfaces.length * 13);
  surfaces.forEach((s, i) =>
    features.set(frameFeatures(s.frames, s.size), i * 13)
  );
  if (trace && method === "neural") {
    trace.frame.surfaceAttempts.neural += surfaces.length;
  }
  const meshes = method === "neural" && surfaces.length
    ? await runner.run("surface", features, surfaces.length)
    : new Float32Array();
  let results: ReadResult[] = [];
  for (const [i, s] of surfaces.entries()) {
    const position = {
      topLeft: s.base.map(-1, -1),
      topRight: s.base.map(1, -1),
      bottomRight: s.base.map(1, 1),
      bottomLeft: s.base.map(-1, 1),
    };
    if (results.some((code) => sameLocation(code, { position }))) continue;
    if (trace && method === "classical") {
      trace.frame.surfaceAttempts.classical++;
    }
    let surface = method === "neural"
      ? meshSurface(s.frames, s.size, meshes.subarray(i * 162, (i + 1) * 162))
      : surfaceFromFrames(s.base, s.frames, value);
    if (!surface) continue;
    if (method === "neural") surface = refineNeuralSurface(surface, value);
    const marks = qrFunctionMarks(surface.size);
    let score = 0;
    for (const m of marks) {
      const p = surface.map(m.u, m.v);
      score += (value(p.x, p.y) - (m.dark ? 0 : 1)) ** 2;
    }
    surface.score = score / marks.length;
    const pass = method === "neural" ? "surface-nn" : "classical";
    if (surface.score > .16) {
      trace?.grid(surface, pass, "rejected");
      continue;
    }
    surface = alignmentMesh(surface, value) ?? surface;
    const { raster, point } = sampleQrSurface(binary, surface, true);
    const decoded = validReads(
      await reader(raster, {
        ...scanOptions,
        isPure: true,
        binarizer: "FixedThreshold",
      }),
    );
    trace?.grid(
      surface,
      pass,
      decoded.length ? "decoded" : "unread",
      undefined,
      raster,
    );
    results = mergeReads(
      results,
      decoded.map((c) => ({
        ...c,
        position: {
          topLeft: point(c.position.topLeft),
          topRight: point(c.position.topRight),
          bottomRight: point(c.position.bottomRight),
          bottomLeft: point(c.position.bottomLeft),
        },
      })),
    );
  }
  return results;
}
