import type { NeuralModels, NeuralRunner } from "../src/nn-runtime.ts";
/** CPU reference for checking exported weights. The app executes learned layers on WebGPU. */
export function referenceNetworks(models: NeuralModels): NeuralRunner {
  return {
    async run(name, input, count) {
      let values = input;
      for (const [index, layer] of models[name].layers.entries()) {
        const next = new Float32Array(count * layer.output);
        for (let row = 0; row < count; row++) {
          for (let output = 0; output < layer.output; output++) {
            let sum = layer.bias[output];
            for (let i = 0; i < layer.input; i++) {
              sum += values[row * layer.input + i] *
                layer.weights[output * layer.input + i];
            }
            next[row * layer.output + output] =
              index === models[name].layers.length - 1 ? sum : Math.max(0, sum);
          }
        }
        values = next;
      }
      return values;
    },
  };
}
