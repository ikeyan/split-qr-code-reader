import type {} from "@webgpu/types";

export type DenseLayer = {
  input: number;
  output: number;
  weights: number[];
  bias: number[];
};
export type DenseModel = { layers: DenseLayer[] };
export type NeuralModels = { marker: DenseModel; surface: DenseModel };
/** The checked-in model contains little-endian float32 weights, encoded as base64. */
export function parseNetworks(text: string): NeuralModels {
  const packed = JSON.parse(text);
  if (packed.format !== "f32le-base64") {
    throw new Error("Unknown QR model format");
  }
  const numbers = (data: string) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.length % 4) throw new Error("Truncated QR weights");
    const view = new DataView(bytes.buffer);
    return Array.from(
      { length: bytes.length / 4 },
      (_, i) => view.getFloat32(i * 4, true),
    );
  };
  const models = {} as NeuralModels;
  for (const name of ["marker", "surface"] as const) {
    const layers = packed[name].layers.map((
      layer: { input: number; output: number; weights: string; bias: string },
    ) => ({
      input: layer.input,
      output: layer.output,
      weights: numbers(layer.weights),
      bias: numbers(layer.bias),
    }));
    for (const [i, layer] of layers.entries()) {
      if (
        !Number.isInteger(layer.input) || !Number.isInteger(layer.output) ||
        layer.input < 1 || layer.output < 1 ||
        layer.weights.length !== layer.input * layer.output ||
        layer.bias.length !== layer.output ||
        (i && layer.input !== layers[i - 1].output) ||
        layer.weights.some((v: number) => !Number.isFinite(v)) ||
        layer.bias.some((v: number) => !Number.isFinite(v))
      ) throw new Error("Invalid QR weights");
    }
    models[name] = { layers };
  }
  if (
    models.marker.layers[0]?.input !== 1024 ||
    models.marker.layers.at(-1)?.output !== 7 ||
    models.surface.layers[0]?.input !== 13 ||
    models.surface.layers.at(-1)?.output !== 162
  ) throw new Error("Unsupported QR architecture");
  return models;
}
export type NeuralRunner = {
  run(
    model: keyof NeuralModels,
    inputs: Float32Array,
    count: number,
  ): Promise<Float32Array>;
};

/** All learned inference uses WebGPU. A failed device is discarded by the caller. */
export class GpuNetworks implements NeuralRunner {
  private constructor(
    private device: GPUDevice,
    private models: NeuralModels,
  ) {}
  static async create(
    gpu: Pick<GPU, "requestAdapter"> | null = globalThis.navigator?.gpu ?? null,
  ): Promise<GpuNetworks | undefined> {
    let device: GPUDevice | undefined;
    try {
      const adapter = await gpu?.requestAdapter();
      if (!adapter) return;
      device = await adapter.requestDevice();
      const url = new URL("./qr-networks.json", import.meta.url);
      const revision = new URL(import.meta.url).searchParams.get("v") ??
        (typeof document === "undefined"
          ? "dev"
          : document.querySelector<HTMLMetaElement>('meta[name="build-commit"]')
            ?.content ?? "dev");
      url.searchParams.set("v", revision);
      const response = await fetch(url);
      if (!response.ok) throw new Error("QR model unavailable");
      const models = parseNetworks(await response.text());
      const result = new GpuNetworks(device, models);
      // Verify the execution backend, including shader compilation and readback.
      await result.run("surface", new Float32Array(13), 1);
      await result.run("marker", new Float32Array(1024), 1);
      return result;
    } catch {
      device?.destroy();
      return undefined;
    }
  }
  get lost() {
    return this.device.lost;
  }
  private pipelines = new Map<string, GPUComputePipeline>();
  private weights = new Map<DenseLayer, GPUBuffer>();
  async run(
    name: keyof NeuralModels,
    inputs: Float32Array,
    count: number,
  ): Promise<Float32Array> {
    if (
      !Number.isInteger(count) || count < 0 ||
      inputs.length !== count * this.models[name].layers[0].input
    ) throw new Error("Invalid neural batch");
    if (!count) return new Float32Array();
    const device = this.device, transient: GPUBuffer[] = [];
    const buffer = (bytes: number, usage: GPUBufferUsageFlags) => {
      const b = device.createBuffer({ size: Math.max(4, bytes), usage });
      transient.push(b);
      return b;
    };
    device.pushErrorScope("validation");
    try {
      let input = buffer(
        inputs.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      device.queue.writeBuffer(input, 0, inputs as Float32Array<ArrayBuffer>);
      const encoder = device.createCommandEncoder();
      const layers = this.models[name].layers;
      for (const [index, layer] of layers.entries()) {
        const key = `${name}-${index}`;
        let pipeline = this.pipelines.get(key);
        if (!pipeline) {
          const code = `@group(0) @binding(0) var<storage,read> x:array<f32>;
@group(0) @binding(1) var<storage,read> w:array<f32>;
@group(0) @binding(2) var<storage,read_write> y:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let neuron=gid.x;let sample=gid.y;if(neuron>=${layer.output}u){return;}
 var sum=w[${layer.input * layer.output}u+neuron];
 for(var i=0u;i<${layer.input}u;i++){sum+=x[sample*${layer.input}u+i]*w[neuron*${layer.input}u+i];}
 y[sample*${layer.output}u+neuron]=${
            index === layers.length - 1 ? "sum" : "max(sum,0.0)"
          };
}`;
          pipeline = await device.createComputePipelineAsync({
            layout: "auto",
            compute: {
              module: device.createShaderModule({ code }),
              entryPoint: "main",
            },
          });
          this.pipelines.set(key, pipeline);
        }
        let weights = this.weights.get(layer);
        if (!weights) {
          const data = new Float32Array([...layer.weights, ...layer.bias]);
          weights = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(weights, 0, data);
          this.weights.set(layer, weights);
        }
        const output = buffer(
          count * layer.output * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        );
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [input, weights, output].map((b, binding) => ({
            binding,
            resource: { buffer: b },
          })),
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(layer.output / 64), count);
        pass.end();
        input = output;
      }
      const result = buffer(
        count * layers.at(-1)!.output * 4,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      );
      encoder.copyBufferToBuffer(input, 0, result, 0, result.size);
      device.queue.submit([encoder.finish()]);
      await result.mapAsync(GPUMapMode.READ);
      const output = new Float32Array(result.getMappedRange().slice(0));
      result.unmap();
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      if (output.some((v) => !Number.isFinite(v))) {
        throw new Error("Invalid GPU output");
      }
      return output;
    } catch (error) {
      await device.popErrorScope().catch(() => {});
      throw error;
    } finally {
      transient.forEach((b) => b.destroy());
    }
  }
}
