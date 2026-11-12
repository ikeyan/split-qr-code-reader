import type {ReadResult,ReaderOptions} from 'zxing-wasm/reader';
import {sharpen,type Raster} from './image-enhance.ts';
export type ScanMode='auto'|'standard'|'sharpen';
export type RasterReader=(image:Raster,options:Partial<ReaderOptions>)=>Promise<ReadResult[]>;
export const scanOptions:Partial<ReaderOptions>={formats:['QRCode'],tryHarder:true,tryDenoise:true,maxNumberOfSymbols:0};
function sameLocation(a:ReadResult,b:ReadResult):boolean {
  const points=(r:ReadResult)=>[r.position.topLeft,r.position.topRight,r.position.bottomRight,r.position.bottomLeft];
  const ap=points(a),bp=points(b);
  const center=(p:typeof ap)=>({x:p.reduce((n,p)=>n+p.x,0)/4,y:p.reduce((n,p)=>n+p.y,0)/4});
  const ac=center(ap),bc=center(bp);
  const size=(p:typeof ap)=>{const c=center(p);return Math.max(...p.map(q=>Math.hypot(q.x-c.x,q.y-c.y)));};
  return Math.hypot(ac.x-bc.x,ac.y-bc.y)<Math.min(size(ap),size(bp))*0.6;
}
function samePayload(a:ReadResult,b:ReadResult):boolean {
  return a.sequenceIndex===b.sequenceIndex&&a.sequenceSize===b.sequenceSize&&a.sequenceId===b.sequenceId&&a.bytes.length===b.bytes.length&&a.bytes.every((value,i)=>value===b.bytes[i]);
}
export function mergeReads(base:ReadResult[],extra:ReadResult[]):ReadResult[] {
  const results=base.slice();
  for(const read of extra)if(!results.some(existing=>samePayload(existing,read)&&sameLocation(existing,read)))results.push(read);
  return results;
}
export async function enhancedReads(image:Raster,reader:RasterReader):Promise<ReadResult[]> {
  return await reader(sharpen(image,2,3),scanOptions);
}
export async function scanRaster(image:Raster,reader:RasterReader,mode:ScanMode,enhanceFrame=true):Promise<ReadResult[]> {
  if(mode==='sharpen')return await enhancedReads(image,reader);
  const base=await reader(image,scanOptions);
  if(mode==='standard'||!enhanceFrame)return base;
  try{return mergeReads(base,await enhancedReads(image,reader));}catch{return base;}
}
