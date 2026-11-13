import type {ReadResult,ReaderOptions} from 'zxing-wasm/reader';
import {sharpen,type Raster} from './image-enhance.ts';
import {candidateRegions,cropRaster,curveVariants,flattenCurve,mapCurvePositions,type Region} from './curvature.ts';
import {correctIllumination,limitRaster} from './illumination.ts';
export type ScanMode='auto'|'standard'|'sharpen'|'curve'|'shadow';
export type RasterReader=(image:Raster,options:Partial<ReaderOptions>)=>Promise<ReadResult[]>;
export const scanOptions:Partial<ReaderOptions>={formats:['QRCode'],tryHarder:true,tryDenoise:true,maxNumberOfSymbols:0};
export const locatingOptions:Partial<ReaderOptions>={...scanOptions,returnErrors:true};
export function validReads(reads:ReadResult[]):ReadResult[]{return reads.filter(result=>result.isValid!==false);}
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
  return validReads(await reader(sharpen(image,2,3),scanOptions));
}
export async function shadowReads(image:Raster,reader:RasterReader,includeErrors=false,method:'sauvola'|'mean'='sauvola'):Promise<ReadResult[]> {
  const limited=limitRaster(image);
  const raw=await reader(correctIllumination(limited,method),{...scanOptions,binarizer:'FixedThreshold',returnErrors:includeErrors});
  const codes=includeErrors?raw:validReads(raw);
  const scale=(p:{x:number;y:number})=>({x:p.x*image.width/limited.width,y:p.y*image.height/limited.height});
  return codes.map(code=>{const p=code.position;return {...code,position:{topLeft:scale(p.topLeft),topRight:scale(p.topRight),bottomRight:scale(p.bottomRight),bottomLeft:scale(p.bottomLeft)}};});
}
/** Undefined cycle means still image: try every candidate. Video tries one per frame. */
export async function curvedReads(image:Raster,reader:RasterReader,raw:ReadResult[],cycle?:number):Promise<ReadResult[]> {
  const regions=candidateRegions(image,raw.filter(code=>code.isValid===false));
  if(!regions.length){
    if(raw.some(code=>code.isValid!==false))return [];
    regions.push({x:0,y:0,width:image.width,height:image.height});
  }
  const jobs:{region:Region;index:number}[]=[];
  if(cycle===undefined){for(const region of regions)for(let index=0;index<curveVariants.length;index++)jobs.push({region,index});}
  else jobs.push({region:regions[Math.floor(cycle/curveVariants.length)%regions.length],index:cycle%curveVariants.length});
  let results:ReadResult[]=[];
  let previousRegion:Region|undefined,source:Raster=image;
  for(const {region,index} of jobs){
    if(region!==previousRegion){
      source=region.x===0&&region.y===0&&region.width===image.width&&region.height===image.height?image:cropRaster(image,region);
      previousRegion=region;
    }
    const curve={...curveVariants[index],angle:region.angle??0};
    const flattened=flattenCurve(source,curve,960);
    try{
      let decoded=validReads(await reader(flattened,scanOptions));
      if(!decoded.length)decoded=await shadowReads(flattened,reader);
      const adjusted=mapCurvePositions(decoded,curve,flattened,source).map(code=>{
        const translate=(p:{x:number;y:number})=>({x:p.x+region.x,y:p.y+region.y});
        const p=code.position;
        return {...code,position:{topLeft:translate(p.topLeft),topRight:translate(p.topRight),bottomRight:translate(p.bottomRight),bottomLeft:translate(p.bottomLeft)}};
      });
      results=mergeReads(results,adjusted);
    }catch{/* Keep results from other attempts. */}
    if(cycle===undefined)await new Promise(resolve=>setTimeout(resolve,0));
  }
  return results;
}
export async function scanRaster(image:Raster,reader:RasterReader,mode:ScanMode,enhanceFrame=true,cycle?:number):Promise<ReadResult[]> {
  if(mode==='sharpen')return await enhancedReads(image,reader);
  const raw=await reader(image,locatingOptions);
  let base=validReads(raw),candidates=raw;
  if(mode==='standard'||(mode==='auto'&&!enhanceFrame))return base;
  if(mode==='auto')try{base=mergeReads(base,await enhancedReads(image,reader));}catch{/* Keep unprocessed reads. */}
  const wantsShadow=mode==='shadow'||(mode==='auto'&&(cycle===undefined||cycle%2===0));
  if(wantsShadow){
    try{const shadow=await shadowReads(image,reader,true);base=mergeReads(base,validReads(shadow));candidates=[...candidates,...shadow];}catch{/* Keep unprocessed reads. */}
    try{const shadow=await shadowReads(image,reader,true,'mean');base=mergeReads(base,validReads(shadow));candidates=[...candidates,...shadow];}catch{/* Keep other reads. */}
  }
  if(mode==='shadow')return base;
  if(mode==='auto'&&cycle!==undefined&&cycle%2===0)return base;
  if(!wantsShadow&&!candidates.some(code=>code.isValid===false)){
    try{const shadow=await shadowReads(image,reader,true);base=mergeReads(base,validReads(shadow));candidates=[...candidates,...shadow];}catch{/* Continue with original candidates. */}
    try{const shadow=await shadowReads(image,reader,true,'mean');base=mergeReads(base,validReads(shadow));candidates=[...candidates,...shadow];}catch{/* Continue with other candidates. */}
  }
  try{return mergeReads(base,await curvedReads(image,reader,candidates,cycle===undefined?undefined:mode==='auto'?Math.floor(cycle/2):cycle));}catch{return base;}
}
