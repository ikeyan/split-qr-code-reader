import type { ReadResult } from "zxing-wasm/reader";
import type { CameraDebugFrame, ScanPass } from "./camera-trace.ts";
import type { Point } from "./geometry.ts";
import { videoFrame } from "./camera-focus.ts";

const passNames: Record<ScanPass, string> = {
  original: "原画",
  tracked: "追跡",
  sharpen: "輪郭",
  shadow: "影",
  tile: "拡大",
  finder: "マーカー探索",
  "marker-nn": "マーカーNN",
  classical: "従来格子",
  "surface-nn": "NN格子",
};

export function drawCameraDebug(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  view: { width: number; height: number },
  trace: CameraDebugFrame,
) {
  if (target.width !== source.width) target.width = source.width;
  if (target.height !== source.height) target.height = source.height;
  const ctx = target.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  const fit = videoFrame(view, source, "cover");
  const unit = fit ? 1 / fit.scale : 1;
  const width = fit ? view.width * unit : source.width;
  const height = fit ? view.height * unit : source.height;
  const left = (source.width - width) / 2, top = (source.height - height) / 2;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  function path(
    points: Point[],
    color: string,
    px: number,
    closed = false,
    dashed = false,
  ) {
    ctx!.beginPath();
    ctx!.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx!.lineTo(point.x, point.y);
    if (closed) ctx!.closePath();
    ctx!.setLineDash(dashed ? [4 * unit, 4 * unit] : []);
    ctx!.strokeStyle = color;
    ctx!.lineWidth = px * unit;
    ctx!.stroke();
  }
  const corners = (
    p: ReadResult["position"],
  ) => [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
  for (const { position, selected } of trace.candidates) {
    path(
      corners(position),
      selected ? "#ffd858" : "#ffd85899",
      selected ? 2.5 : 1.3,
      true,
      !selected,
    );
  }
  for (const grid of [...trace.grids].reverse()) {
    const color = grid.outcome === "rejected" ? "#ff7479a0" : "#61e7ffa0";
    for (const line of grid.lines) {
      path(line, color, 1.25, false, grid.outcome === "rejected");
    }
  }
  for (const { center, axes } of trace.markers) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, 3.5 * unit, 0, 2 * Math.PI);
    ctx.fillStyle = "#f2a7ff";
    ctx.fill();
    for (const tip of axes ?? []) path([center, tip], "#f2a7ff", 2);
  }
  for (const position of trace.decoded) {
    path(corners(position), "#79ff9d", 3, true);
  }

  ctx.translate(left, top);
  ctx.scale(unit, unit);
  const maxWidth = width / unit - 20, lineHeight = 17;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const stages = (Object.entries(trace.passes) as [ScanPass, number][])
    .map(([pass, count]) => passNames[pass] + (count > 1 ? ` ×${count}` : ""));
  const lines: string[] = [];
  let line = "";
  for (const stage of stages) {
    const next = line ? `${line} / ${stage}` : stage;
    if (line && ctx.measureText(next).width > maxWidth - 16) {
      lines.push(line);
      line = stage;
    } else line = next;
  }
  if (line) lines.push(line);
  const counts =
    `候補 ${trace.candidates.length}・マーカー ${trace.markers.length}・格子 ${trace.grids.length}・復号 ${trace.decoded.length}`;
  lines.push(counts);
  lines.push("黄 候補 / 紫 マーカー / 水色 格子");
  lines.push("赤点線 棄却格子 / 緑 復号");
  const best = trace.grids[0];
  if (best) {
    const status = {
      rejected: "棄却",
      unread: "復号失敗",
      decoded: "復号成功",
    }[best.outcome];
    lines.push(
      `${passNames[best.pass]} ${best.size}×${best.size}・誤差 ${
        best.score.toFixed(3)
      }・${status}`,
    );
  }
  const panelHeight = lines.length * lineHeight + 10;
  const y = Math.max(0, height / unit - panelHeight - 88);
  ctx.fillStyle = "#091710df";
  ctx.fillRect(10, y, maxWidth, panelHeight);
  lines.forEach((text, i) => {
    ctx.fillStyle = i === lines.length - 1 && best ? "#b9f2ff" : "#fff";
    ctx.fillText(text, 18, y + 5 + (i + .5) * lineHeight, maxWidth - 16);
  });
  const sample = best?.sample;
  if (sample && y > 104) {
    const side = Math.min(88, maxWidth / 3);
    const cell = side / sample.size, previewX = 10 + maxWidth - side;
    const previewY = y - side - 19;
    ctx.fillStyle = "#091710df";
    ctx.fillRect(previewX, previewY, side, side + 17);
    ctx.fillStyle = "#fff";
    ctx.fillText("標本化", previewX + 5, previewY + 8);
    for (const [i, gray] of sample.gray.entries()) {
      ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
      const x = previewX + i % sample.size * cell;
      const y = previewY + 17 + Math.floor(i / sample.size) * cell;
      ctx.fillRect(
        x,
        y,
        Math.ceil(cell * unit) / unit,
        Math.ceil(cell * unit) / unit,
      );
    }
  }
  ctx.restore();
}
