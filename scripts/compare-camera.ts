import { chromium } from "npm:playwright-core@1.65.0";
import { PNG } from "pngjs";
import { curvedPaper } from "../tests/curved-paper.ts";
import type { CameraScanResult } from "../src/camera-trace.ts";
import type { CurvePipeline } from "../src/decoder.ts";

const [backgrounds, weights = "dist/qr-networks.json"] = Deno.args;
const files = backgrounds
  ? (await Array.fromAsync(Deno.readDir(backgrounds)))
    .filter((file) => file.isFile && file.name.endsWith(".png"))
    .map((file) => file.name).sort()
  : [];
const cases = files.map((_, index) => ({
  path: `/background/${index}`,
  group: "background",
  expected: [] as number[],
}));
const images: Uint8Array<ArrayBuffer>[] = [];
for (const degrees of [30, 40]) {
  for (let i = 0; i < 8; i++) {
    const tilt = degrees * Math.PI / 180 * (i % 2 ? -1 : 1);
    const sample = curvedPaper(827459 + i * 7919, i % 4 + (i < 4 ? 0 : 8), {
      version: 7 + i % 4,
      resolution: 2,
      angle: .9,
      pitch: i < 4 ? tilt : .1,
      yaw: i < 4 ? .1 : tilt,
      bendOffset: i % 2 ? .08 : -.08,
    });
    const png = new PNG({
      width: sample.image.width,
      height: sample.image.height,
    });
    png.data.set(sample.image.data);
    cases.push({
      path: `/curved/${images.length}`,
      group: `${degrees}°`,
      expected: Array.from(sample.expected),
    });
    images.push(new Uint8Array(PNG.sync.write(png)));
  }
}
const workerScript = await Deno.readFile("dist/camera-worker.js");
const model = await Deno.readFile(weights);
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/") {
      return new Response("<!doctype html><title>Camera benchmark</title>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (path === "/camera-worker.js") {
      return new Response(workerScript, {
        headers: { "content-type": "text/javascript" },
      });
    }
    if (path === "/qr-networks.json") return new Response(model);
    const match = path.match(/^\/(curved|background)\/(\d+)$/);
    if (match) {
      const index = Number(match[2]);
      const image = match[1] === "curved"
        ? images[index]
        : files[index] && await Deno.readFile(`${backgrounds}/${files[index]}`);
      if (image) {
        return new Response(image, {
          headers: { "content-type": "image/png" },
        });
      }
    }
    return new Response(null, { status: 404 });
  },
);

const nativeGpu = Deno.env.get("NATIVE_GPU") === "1";
try {
  const browser = await chromium.launch({
    executablePath: Deno.env.get("CHROME_BIN") ?? "/usr/bin/chromium",
    args: nativeGpu
      ? []
      : ["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.addr.port}`);
    console.log(
      JSON.stringify({
        gpu: nativeGpu ? "native requested" : "SwiftShader",
        backgroundPhotos: files.length,
      }),
    );
    const methods: CurvePipeline[] = ["traditional", "classical", "neural"];
    for (const method of methods) {
      const stats = await page.evaluate(async ({ method, cases }) => {
        const worker = new Worker("/camera-worker.js", { type: "module" });
        try {
          await new Promise<void>((resolve, reject) => {
            worker.onerror = (event) => reject(new Error(event.message));
            worker.onmessage = ({ data }) => {
              if (data.gpu === true) resolve();
              if (data.gpu === false) reject(new Error("WebGPU unavailable"));
            };
          });
          let id = 0;
          async function send(job: object): Promise<CameraScanResult> {
            return await new Promise((resolve, reject) => {
              const next = id++;
              worker.onerror = (event) => reject(new Error(event.message));
              worker.onmessage = ({ data }) => {
                if (data.gpu === false) reject(new Error("WebGPU lost"));
                if (data.id !== next) return;
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              };
              worker.postMessage({ id: next, ...job });
            });
          }
          const groups: Record<string, {
            images: number;
            correct: number;
            unexpected: number;
            frames: number;
            neural: number;
            classical: number;
            milliseconds: number[];
            firstMilliseconds: number[];
          }> = {};
          for (const fixture of cases) {
            const bitmap = await createImageBitmap(
              await (await fetch(fixture.path)).blob(),
            );
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            const image = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            await send({ reset: true });
            const group = groups[fixture.group] ??= {
              images: 0,
              correct: 0,
              unexpected: 0,
              frames: 0,
              neural: 0,
              classical: 0,
              milliseconds: [],
              firstMilliseconds: [],
            };
            group.images++;
            let total = 0;
            for (
              let frame = 0;
              frame < (fixture.expected.length ? 4 : 1);
              frame++
            ) {
              const start = performance.now();
              const { codes, debug } = await send({
                image,
                method,
                debug: true,
              });
              const milliseconds = performance.now() - start;
              const correct = codes.filter((code) =>
                fixture.expected.length > 0 &&
                code.bytes.length === fixture.expected.length &&
                code.bytes.every((byte, i) => byte === fixture.expected[i])
              );
              group.frames++;
              group.neural += debug!.surfaceAttempts.neural;
              group.classical += debug!.surfaceAttempts.classical;
              group.milliseconds.push(milliseconds);
              group.unexpected += codes.length - correct.length;
              total += milliseconds;
              if (correct.length) {
                group.correct++;
                group.firstMilliseconds.push(total);
                break;
              }
            }
          }
          const median = (values: number[]) =>
            values.length
              ? Math.round(
                values.sort((a, b) => a - b)[Math.floor(values.length / 2)],
              )
              : null;
          return Object.fromEntries(
            Object.entries(groups).map(([name, group]) => {
              const { milliseconds, firstMilliseconds, ...counts } = group;
              return [name, {
                ...counts,
                medianMs: median(milliseconds),
                firstReadMedianMs: median(firstMilliseconds),
              }];
            }),
          );
        } finally {
          worker.terminate();
        }
      }, { method, cases });
      console.log(JSON.stringify({ method, stats }));
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.shutdown();
}
