import { createVideoDecoder } from "./decoder.ts";
import type { ScanMode } from "./scan.ts";

import { neuralStatus } from "./neural-service.ts";
import type { SurfaceMethod } from "./neural-scan.ts";
neuralStatus((gpu) => globalThis.postMessage({ gpu }));

let decode = createVideoDecoder(), queue = Promise.resolve();
globalThis.onmessage = (event: MessageEvent) => {
  const request = event.data as {
    id: number;
    reset?: boolean;
    image?: ImageData;
    mode?: ScanMode;
    method?: SurfaceMethod;
    allowNeural?: boolean;
    debug?: boolean;
  };
  queue = queue.then(async () => {
    try {
      if (request.reset) {
        decode = createVideoDecoder();
        globalThis.postMessage({ id: request.id, codes: [] });
        return;
      }
      const image = request.image!;
      const result = await decode(
        new ImageData(image.data, image.width, image.height),
        request.mode ?? "auto",
        request.method ?? "neural",
        request.allowNeural ?? true,
        request.debug ?? false,
      );
      globalThis.postMessage({ id: request.id, ...result });
    } catch (error) {
      globalThis.postMessage({ id: request.id, error: String(error) });
    }
  });
};
