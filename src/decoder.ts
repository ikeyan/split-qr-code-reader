import {prepareZXingModule, readBarcodes, type ReadResult} from 'zxing-wasm/reader';
import wasm from './wasm-data.ts';
const binary = Uint8Array.from(atob(wasm), c => c.charCodeAt(0));
const ready = prepareZXingModule({overrides:{wasmBinary: binary}, fireImmediately: true});
export async function decode(image: ImageData | Blob): Promise<ReadResult[]> {
  await ready;
  return await readBarcodes(image, {formats:['QRCode'], tryHarder:true, maxNumberOfSymbols: 0});
}
