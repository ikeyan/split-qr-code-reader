import { chromium } from "npm:playwright-core@1.65.0";
import { strict as assert } from "node:assert";
import { PNG } from "pngjs";
import { parseNetworks } from "../src/nn-runtime.ts";
import { referenceNetworks } from "../tests/nn-reference.ts";
import { curvedPaper } from "../tests/curved-paper.ts";

const temporary = await Deno.makeTempDir({ prefix: "qr-gpu-check-" });
const modulePath = temporary + "/runtime.js";
const bundle = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform=browser",
    "src/nn-runtime.ts",
    "--output",
    modulePath,
  ],
}).output();
if (!bundle.success) throw new Error(new TextDecoder().decode(bundle.stderr));
const sample = curvedPaper(581239, 0, { version: 7, angle: .65, roll: 0 }),
  png = new PNG({ width: sample.image.width, height: sample.image.height });
png.data.set(sample.image.data);
const fixture = PNG.sync.write(png), runtime = await Deno.readFile(modulePath);
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: () => {},
}, async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/nn-test.js") {
    return new Response(runtime, {
      headers: { "Content-Type": "text/javascript" },
    });
  }
  if (path === "/camera-test.png") {
    return new Response(fixture, { headers: { "Content-Type": "image/png" } });
  }
  if (path.includes("..")) return new Response("", { status: 400 });
  try {
    const file = path === "/" ? "index.html" : path.slice(1),
      body = await Deno.readFile("dist/" + file);
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".json")
      ? "application/json"
      : "text/html";
    return new Response(body, { headers: { "Content-Type": type } });
  } catch {
    return new Response("", { status: 404 });
  }
});
const browser = await chromium.launch({
  executablePath: Deno.env.get("CHROME_BIN") ?? "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--use-angle=swiftshader",
    "--use-fake-ui-for-media-stream",
  ],
});
try {
  const address = `http://127.0.0.1:${server.addr.port}`;
  const reference = referenceNetworks(
    parseNetworks(await Deno.readTextFile("vendor/qr-networks.json")),
  );
  const vectors = [];
  for (const [name, size] of [["marker", 1024], ["surface", 13]] as const) {
    const input = Float32Array.from(
      { length: size * 4 },
      (_, i) => Math.sin(i * .713) * .7,
    );
    vectors.push({
      name,
      input: Array.from(input),
      output: Array.from(await reference.run(name, input, 4)),
    });
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const Original = Worker;
    const methods: string[] = [];
    (globalThis as unknown as { workerMethods: string[] }).workerMethods =
      methods;
    globalThis.Worker = class extends Original {
      private sent = new Map<number, string>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          if (event.data.codes?.length) {
            const method = this.sent.get(event.data.id);
            if (method) methods.push(method);
          }
        });
      }
      override postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const data = message as { id: number; method?: string };
        if (data.method) this.sent.set(data.id, data.method);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    const gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (options) => {
      const adapter = await request(options);
      if (adapter) {
        const make = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (d) => {
          const device = await make(d);
          (globalThis as unknown as { testDevice: GPUDevice }).testDevice ??=
            device;
          return device;
        };
      }
      return adapter;
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const bitmap = await createImageBitmap(
        await (await fetch("/camera-test.png")).blob(),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      setInterval(() => ctx.drawImage(bitmap, 0, 0), 100);
      return canvas.captureStream(10);
    };
  });
  await page.goto(address);
  await page.waitForFunction(() =>
    !document.querySelector(
      'select[aria-label="曲面推定"] option[value="neural"]',
    )?.hasAttribute("disabled")
  );
  assert.ok(
    !(await page.locator(".build-commit").innerText()).includes("No GPU"),
  );
  assert.ok(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  );
  await page.getByLabel("写真を選ぶ", { exact: true }).setInputFiles({
    name: "generated-qr.png",
    mimeType: "image/png",
    buffer: fixture,
  });
  await page.locator(".result-card textarea").first().waitFor({
    timeout: 60000,
  });
  assert.equal(
    await page.locator(".result-card textarea").first().inputValue(),
    new TextDecoder().decode(sample.expected),
  );
  const gpuErrors = await page.evaluate(async (vectors) => {
    const module = await import("/nn-test.js");
    const networks = await module.GpuNetworks.create();
    if (!networks) throw Error("WebGPU initialization failed");
    const errors: Record<string, number> = {};
    for (const v of vectors) {
      const actual = await networks.run(v.name, new Float32Array(v.input), 4);
      errors[v.name] = Math.max(
        ...Array.from(
          actual as Float32Array,
          (x, i) => Math.abs(x - v.output[i]),
        ),
      );
    }
    return errors;
  }, vectors);
  assert.ok(
    gpuErrors.marker < .001 && gpuErrors.surface < .001,
    JSON.stringify(gpuErrors),
  );
  await page.getByRole("button", { name: "カメラで読む", exact: true }).click();
  await page.locator(".observed-item").first().waitFor({ timeout: 60000 });
  assert.equal(
    await page.locator(".observed-text").first().innerText(),
    new TextDecoder().decode(sample.expected),
  );
  await page.getByLabel("曲面推定", { exact: true }).nth(1).selectOption(
    "classical",
  );
  await page.waitForFunction(() =>
    (globalThis as unknown as { workerMethods: string[] }).workerMethods
      .includes("classical")
  );
  await page.getByLabel("曲面推定", { exact: true }).nth(1).selectOption(
    "neural",
  );
  await page.waitForFunction(() =>
    (globalThis as unknown as { workerMethods: string[] }).workerMethods
      .includes("neural")
  );
  await page.getByRole("button", { name: "カメラを停止", exact: true }).click();
  await page.evaluate(() => {
    (globalThis as unknown as { testDevice: GPUDevice }).testDevice.destroy();
  });
  await page.waitForFunction(() =>
    document.querySelector(".build-commit")?.textContent?.endsWith(" No GPU")
  );
  for (const denied of ["missing", "denied"]) {
    const fallback = await browser.newPage();
    await fallback.addInitScript((denied) => {
      if (denied === "missing") {
        Object.defineProperty(navigator, "gpu", { value: undefined });
      } else navigator.gpu.requestAdapter = async () => null;
    }, denied);
    await fallback.goto(address);
    await fallback.waitForFunction(() =>
      document.querySelector(".build-commit")?.textContent?.endsWith(" No GPU")
    );
    assert.equal(
      await fallback.getByLabel("曲面推定", { exact: true }).first()
        .inputValue(),
      "classical",
    );
    await fallback.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      gpuErrors,
      camera: "exact payload",
      photo: "exact payload",
      switching: "passed",
      deviceLoss: "No GPU",
      missingAndDenied: "classical fallback",
    }),
  );
} finally {
  await browser.close();
  await server.shutdown();
  await Deno.remove(temporary, { recursive: true });
}
