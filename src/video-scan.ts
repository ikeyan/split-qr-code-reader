import type { ReadResult } from "zxing-wasm/reader";
import {
  candidateRegions,
  cropRaster,
  type QrCandidate,
  type Region,
} from "./curvature.ts";
import { type Raster, resizeRaster, sharpen } from "./image-enhance.ts";
import { correctIllumination } from "./illumination.ts";
import { locateQrCandidates } from "./qr-finders.ts";
import { fitQrSurfaces, sampleQrSurface } from "./qr-surface.ts";
import {
  locatingOptions,
  mergeReads,
  type RasterReader,
  sameLocation,
  type ScanMode,
  scanOptions,
  validReads,
} from "./scan.ts";

type Pending = {
  candidate: QrCandidate;
  trial: number;
  winner?: number;
  seen: number;
  seed?: { size: number; parameters: number[] };
  center?: { x: number; y: number };
};
function translated(
  codes: ReadResult[],
  region: Region,
  raster: Raster,
): ReadResult[] {
  const point = (p: { x: number; y: number }) => ({
    x: region.x + p.x * region.width / raster.width,
    y: region.y + p.y * region.height / raster.height,
  });
  return codes.map((code) => {
    const p = code.position;
    return {
      ...code,
      position: {
        topLeft: point(p.topLeft),
        topRight: point(p.topRight),
        bottomRight: point(p.bottomRight),
        bottomLeft: point(p.bottomLeft),
      },
    };
  });
}
function enlarged(image: Raster, max = 960): Raster {
  const factor = Math.min(
    3,
    Math.max(1, 320 / Math.min(image.width, image.height)),
    max / Math.max(image.width, image.height),
  );
  return resizeRaster(
    image,
    Math.max(1, Math.round(image.width * factor)),
    Math.max(1, Math.round(image.height * factor)),
  );
}

/** Retain search geometry, never stale decoded results, across live frames. */
export class VideoScanner {
  private frame = 0;
  private pending: Pending[] = [];
  private tracked: ReadResult[] = [];
  private mode: ScanMode | undefined;
  private dimensions = "";
  private lastRead = -1;
  async scan(
    image: Raster,
    reader: RasterReader,
    mode: ScanMode = "auto",
  ): Promise<ReadResult[]> {
    const dimensions = `${image.width}x${image.height}`;
    if (mode !== this.mode || dimensions !== this.dimensions) {
      this.pending = [];
      this.tracked = [];
      this.frame = 0;
      this.mode = mode;
      this.dimensions = dimensions;
      this.lastRead = -1;
    }
    const frame = this.frame++;
    const raw = await reader(image, locatingOptions);
    let results = validReads(raw), candidates = raw;
    if (mode === "standard") return results;
    // Re-read the current pixels around recent detections on every frame.
    for (const region of candidateRegions(image, this.tracked).slice(0, 4)) {
      const source = enlarged(cropRaster(image, region));
      let local = await reader(source, locatingOptions);
      for (const method of ["sauvola", "mean"] as const) {
        if (!validReads(local).length) {
          local = [
            ...local,
            ...await reader(correctIllumination(source, method), {
              ...locatingOptions,
              binarizer: "FixedThreshold",
            }),
          ];
        }
      }
      const mapped = translated(local, region, source);
      results = mergeReads(results, validReads(mapped));
      candidates = [...candidates, ...mapped];
    }
    if (mode === "sharpen" || !results.length) {
      const enhanced = await reader(sharpen(image, 2, 3), locatingOptions);
      results = mergeReads(results, validReads(enhanced));
      candidates = [...candidates, ...enhanced];
    }
    if (mode === "sharpen") {
      this.tracked = results;
      return results;
    }
    if (!results.length || mode === "shadow") {
      for (const method of ["sauvola", "mean"] as const) {
        if (!results.length || mode === "shadow") {
          const shadow = await reader(correctIllumination(image, method), {
            ...locatingOptions,
            binarizer: "FixedThreshold",
          });
          results = mergeReads(results, validReads(shadow));
          candidates = [...candidates, ...shadow];
        }
      }
    }
    if (mode === "shadow") {
      this.tracked = results;
      return results;
    }
    if (!results.length) {
      const mild = await reader(sharpen(image, 1, 2), locatingOptions);
      results = mergeReads(results, validReads(mild));
      candidates = [...candidates, ...mild];
      // Overlapping tiles enlarge small QR codes without fitting the whole scene.
      const width = Math.ceil(image.width * .65),
        height = Math.ceil(image.height * .7);
      const region = {
        x: frame % 2 ? image.width - width : 0,
        y: Math.floor(frame / 2) % 2 ? image.height - height : 0,
        width,
        height,
      };
      const crop = cropRaster(image, region),
        scale = Math.min(2, 1536 / Math.max(width, height));
      const tile = resizeRaster(
        crop,
        Math.round(region.width * scale),
        Math.round(region.height * scale),
      );
      let found = await reader(tile, locatingOptions);
      if (!found.some((c) => /^\d+$/.test(c.version))) {
        found = [
          ...found,
          ...await reader(sharpen(tile, 1, 2), locatingOptions),
        ];
      }
      const mapped = translated(found, region, tile);
      results = mergeReads(results, validReads(mapped));
      candidates = [...candidates, ...mapped];
      if (!candidates.some((c) => /^\d+$/.test(c.version))) {
        candidates = [
          ...candidates,
          ...locateQrCandidates(image).map(
            (c) => ({ ...c, isValid: false } as ReadResult),
          ),
        ];
      }
    }
    const updated = new Set<Pending>();
    for (
      const candidate of candidates.filter((c) =>
        c.isValid === false && /^\d+$/.test(c.version)
      )
    ) {
      if (results.some((c) => sameLocation(c, candidate))) continue;
      const old = this.pending.find((p) =>
        sameLocation(p.candidate, candidate)
      );
      if (old) {
        if (!old.seed && !updated.has(old)) old.candidate = candidate;
        old.seen = frame;
        updated.add(old);
      } else {
        const entry = { candidate, trial: 0, seen: frame };
        this.pending.push(entry);
        updated.add(entry);
      }
    }
    this.pending = this.pending.filter((p) => frame - p.seen <= 12).sort((
      a,
      b,
    ) =>
      (b.winner !== undefined ? 1 : 0) - (a.winner !== undefined ? 1 : 0) ||
      b.seen - a.seen
    ).slice(0, 4);
    for (const entry of this.pending) {
      if (entry.seed && entry.center) {
        const read = results.find((c) => sameLocation(c, entry.candidate));
        if (!read) continue;
        const corners = Object.values(read.position),
          center = {
            x: corners.reduce((s, p) => s + p.x, 0) / 4,
            y: corners.reduce((s, p) => s + p.y, 0) / 4,
          };
        const dx = center.x - entry.center.x,
          dy = center.y - entry.center.y,
          p = entry.candidate.position;
        const shift = (p: { x: number; y: number }) => ({
          x: p.x + dx,
          y: p.y + dy,
        });
        entry.candidate = {
          ...entry.candidate,
          position: {
            topLeft: shift(p.topLeft),
            topRight: shift(p.topRight),
            bottomRight: shift(p.bottomRight),
            bottomLeft: shift(p.bottomLeft),
          },
        };
        entry.center = center;
        entry.seen = frame;
      }
    }
    const unresolved = this.pending.filter((p) =>
      !results.some((c) => sameLocation(c, p.candidate))
    );
    const job = unresolved.find((p) => p.winner !== undefined) ??
      unresolved[frame % Math.max(1, unresolved.length)];
    if (job) {
      const region = candidateRegions(image, [job.candidate])[0];
      if (region) {
        const source = enlarged(cropRaster(image, region)),
          trial = job.winner ?? job.trial++;
        let recovered = false;
        const point = (p: { x: number; y: number }) => ({
          x: (p.x - region.x) * source.width / region.width,
          y: (p.y - region.y) * source.height / region.height,
        });
        const p = job.candidate.position,
          local = {
            ...job.candidate,
            position: {
              topLeft: point(p.topLeft),
              topRight: point(p.topRight),
              bottomRight: point(p.bottomRight),
              bottomLeft: point(p.bottomLeft),
            },
          };
        for (const surface of fitQrSurfaces(source, local, trial, job.seed)) {
          if (surface.score > .14) continue;
          const { raster, point: map } = sampleQrSurface(source, surface);
          let codes = validReads(
            await reader(raster, { ...scanOptions, isPure: true }),
          );
          if (!codes.length) {
            const binary =
              sampleQrSurface(correctIllumination(source, "mean"), surface)
                .raster;
            codes = validReads(
              await reader(binary, {
                ...scanOptions,
                isPure: true,
                binarizer: "FixedThreshold",
              }),
            );
          }
          codes = codes.map((c) => {
            const p = c.position;
            return {
              ...c,
              position: {
                topLeft: map(p.topLeft),
                topRight: map(p.topRight),
                bottomRight: map(p.bottomRight),
                bottomLeft: map(p.bottomLeft),
              },
            };
          });
          if (codes.length) {
            const mapped = translated(codes, region, source);
            results = mergeReads(results, mapped);
            job.winner = trial;
            job.seed = {
              size: surface.size,
              parameters: surface.parameters.slice(),
            };
            job.seen = frame;
            recovered = true;
            const corners = Object.values(mapped[0].position),
              center = {
                x: corners.reduce((s, p) => s + p.x, 0) / 4,
                y: corners.reduce((s, p) => s + p.y, 0) / 4,
              };
            if (job.center) {
              const dx = center.x - job.center.x,
                dy = center.y - job.center.y,
                p = job.candidate.position;
              const shift = (p: { x: number; y: number }) => ({
                x: p.x + dx,
                y: p.y + dy,
              });
              job.candidate = {
                ...job.candidate,
                position: {
                  topLeft: shift(p.topLeft),
                  topRight: shift(p.topRight),
                  bottomRight: shift(p.bottomRight),
                  bottomLeft: shift(p.bottomLeft),
                },
              };
            }
            job.center = center;
          }
        }
        if (!recovered) {
          job.winner = undefined;
          job.seed = undefined;
          job.center = undefined;
        }
      }
    }
    if (results.length) {
      this.tracked = results;
      this.lastRead = frame;
    }
    // Tracked windows expire too; an absent code is never returned from memory.
    if (frame - this.lastRead > 8) this.tracked = [];
    return results;
  }
}
