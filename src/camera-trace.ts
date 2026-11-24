import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import type { Point } from "./geometry.ts";
import type { Surface } from "./qr-surface.ts";

export type ScanPass =
  | "original"
  | "tracked"
  | "sharpen"
  | "shadow"
  | "tile"
  | "finder"
  | "marker-nn"
  | "structure-rejected"
  | "classical"
  | "surface-nn";
type Position = ReadResult["position"];
type GridOutcome = "rejected" | "unread" | "decoded";

export type CameraDebugFrame = {
  passes: Partial<Record<ScanPass, number>>;
  candidates: { position: Position; pass: ScanPass; selected?: boolean }[];
  markers: { center: Point; axes?: Point[] }[];
  grids: {
    lines: Point[][];
    size: number;
    score: number;
    outcome: GridOutcome;
    pass: ScanPass;
    sample?: { size: number; gray: Uint8Array };
  }[];
  decoded: Position[];
};

/** Collect bounded, structured-cloneable geometry in the original frame coordinates. */
export class CameraTrace {
  readonly frame: CameraDebugFrame = {
    passes: {},
    candidates: [],
    markers: [],
    grids: [],
    decoded: [],
  };

  pass(pass: ScanPass) {
    this.frame.passes[pass] = (this.frame.passes[pass] ?? 0) + 1;
  }

  candidate(position: Position, pass: ScanPass, selected = false) {
    const corners = Object.values(position);
    if (
      !corners.every(finite) ||
      corners.every((p) => p.x === corners[0].x && p.y === corners[0].y)
    ) return;
    const list = this.frame.candidates;
    const duplicate = list.find((c) =>
      Object.values(c.position).every((p, i) =>
        Math.hypot(p.x - corners[i].x, p.y - corners[i].y) < 2
      )
    );
    if (duplicate) {
      if (selected) duplicate.selected = true;
      return;
    }
    if (list.length >= 32) {
      if (!selected) return;
      const unselected = list.findIndex((c) => !c.selected);
      if (unselected < 0) return;
      list.splice(unselected, 1);
    }
    list.push({ position, pass, selected });
  }

  reads(pass: ScanPass, codes: ReadResult[], count = true) {
    if (count) this.pass(pass);
    for (const code of codes) {
      if (code.isValid === false) this.candidate(code.position, pass);
    }
  }

  marker(center: Point, axes?: Point[]) {
    const list = this.frame.markers;
    if (!finite(center) || axes?.some((p) => !finite(p))) return;
    const previous = list.findIndex((m) =>
      Math.hypot(m.center.x - center.x, m.center.y - center.y) < 3
    );
    if (previous >= 0) {
      if (axes) list[previous] = { center, axes };
    } else if (list.length < 48) list.push({ center, axes });
  }

  markerFrame(
    pose: number[],
    toFrame: (point: Point) => Point = (point) => point,
  ) {
    const [x, y, dx, dy, ex, ey] = pose;
    this.marker(toFrame({ x, y }), [
      toFrame({ x: x + 3 * dx, y: y + 3 * dy }),
      toFrame({ x: x + 3 * ex, y: y + 3 * ey }),
    ]);
  }

  grid(
    surface: Surface,
    pass: ScanPass,
    outcome: GridOutcome,
    toFrame: (point: Point) => Point = (point) => point,
    sampled?: Raster,
  ) {
    this.pass(pass);
    const list = this.frame.grids;
    const priority = (g: { outcome: GridOutcome; score: number }) =>
      ({ decoded: 0, unread: 1, rejected: 2 })[g.outcome] +
      Math.min(1, g.score);
    const rank = priority({ outcome, score: surface.score });
    if (!Number.isFinite(rank)) return;
    if (list.length >= 6 && rank >= priority(list[list.length - 1])) return;
    const lines: Point[][] = [];
    const at = (u: number, v: number) => toFrame(surface.map(u, v));
    for (let i = 0; i <= 6; i++) {
      const fixed = i / 3 - 1;
      lines.push(
        Array.from({ length: 13 }, (_, j) => at(fixed, j / 6 - 1)),
        Array.from({ length: 13 }, (_, j) => at(j / 6 - 1, fixed)),
      );
    }
    if (!lines.every((line) => line.every(finite))) return;
    const size = surface.size + 8;
    // The sampler emits a quiet zone and a flat block for every module.
    const sample = sampled && {
      size,
      gray: Uint8Array.from({ length: size * size }, (_, i) => {
        const x = Math.floor((i % size + .5) * sampled.width / size);
        const y = Math.floor(
          (Math.floor(i / size) + .5) * sampled.height / size,
        );
        const k = (y * sampled.width + x) * 4;
        return Math.round(
          .299 * sampled.data[k] + .587 * sampled.data[k + 1] +
            .114 * sampled.data[k + 2],
        );
      }),
    };
    list.push({
      lines,
      size: surface.size,
      score: surface.score,
      pass,
      outcome,
      sample,
    });
    list.sort((a, b) => priority(a) - priority(b));
    if (list.length > 6) list.pop();
  }

  finish(codes: ReadResult[]) {
    this.frame.decoded = codes.map((code) => code.position).slice(0, 32);
    return this.frame;
  }
}

function finite(point: Point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export type CameraScanResult = {
  codes: ReadResult[];
  debug?: CameraDebugFrame;
};
