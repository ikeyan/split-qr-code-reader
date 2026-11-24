import {CameraTrace,type CameraScanResult} from './camera-trace.ts';
import {prepareZXingModule,readBarcodes,type ReadResult} from 'zxing-wasm/reader';
import wasm from './wasm-data.ts';
import {curvedReads,enhancedReads,locatingOptions,mergeReads,scanRaster,shadowReads,validReads,type ScanMode,type RasterReader} from './scan.ts';
import type {Raster} from './image-enhance.ts';
import {VideoScanner} from './video-scan.ts';
import {neuralRunner,disableNeural} from './neural-service.ts';
import {neuralReads,type SurfaceMethod} from './neural-scan.ts';
const binary=Uint8Array.from(atob(wasm),c=>c.charCodeAt(0));
const ready=prepareZXingModule({overrides:{wasmBinary:binary},fireImmediately:true});
const rasterReader:RasterReader=(image,options)=>readBarcodes(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>,image.width,image.height),options);
export function createVideoDecoder(){
  let scanner=new VideoScanner();
  let previousMethod:SurfaceMethod|undefined;
  return async(image:ImageData,mode:ScanMode,method:SurfaceMethod='neural',allowNeural=true,debug=false):Promise<CameraScanResult>=>{
    await ready;
    const trace=debug?new CameraTrace():undefined;
    const result=(codes:ReadResult[]):CameraScanResult=>trace?{codes,debug:trace.finish(codes)}:{codes};
    let raw:ReadResult[]|undefined;
    if(method!==previousMethod){scanner=new VideoScanner();previousMethod=method;}
    if(allowNeural&&(mode==='auto'||mode==='curve')){
      const runner=await neuralRunner();
      if(runner){
        raw=await rasterReader(image,locatingOptions);
        trace?.reads("original",raw);
        try{
          const codes=await neuralReads(image,rasterReader,runner,method,raw,trace);
          if(codes.length)return result(mergeReads(validReads(raw),codes));
        }catch{disableNeural();}
      }
    }
    return result(await scanner.scan(image,rasterReader,mode,raw,trace));
  };
}
async function rasterize(blob:Blob):Promise<{raster:Raster;scaleX:number;scaleY:number}>{
  let source:ImageBitmap|HTMLImageElement|undefined;
  let objectUrl:string|undefined;
  if(typeof createImageBitmap==='function'){
    try{source=await createImageBitmap(blob);}catch{/* Fall back to the browser image decoder. */}
  }
  if(!source){
    objectUrl=URL.createObjectURL(blob);
    const image=new Image();
    try{await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('画像を開けません'));image.src=objectUrl!;});source=image;}
    catch(error){URL.revokeObjectURL(objectUrl);throw error;}
  }
  try{
    const width=source instanceof HTMLImageElement?source.naturalWidth:source.width;
    const height=source instanceof HTMLImageElement?source.naturalHeight:source.height;
    const factor=Math.min(1,2048/Math.max(width,height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*factor));canvas.height=Math.max(1,Math.round(height*factor));
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('画像を開けません');
    context.drawImage(source,0,0,canvas.width,canvas.height);
    return {raster:context.getImageData(0,0,canvas.width,canvas.height),scaleX:width/canvas.width,scaleY:height/canvas.height};
  }finally{if(objectUrl)URL.revokeObjectURL(objectUrl);if('close' in source)source.close();}
}
function scalePositions(codes:ReadResult[],scaleX:number,scaleY:number):ReadResult[]{
  return codes.map(code=>{const position=code.position;const scale=(p:{x:number;y:number})=>({x:p.x*scaleX,y:p.y*scaleY});return {...code,position:{topLeft:scale(position.topLeft),topRight:scale(position.topRight),bottomRight:scale(position.bottomRight),bottomLeft:scale(position.bottomLeft)}};});
}
export async function decode(image:ImageData|Blob,mode:ScanMode='auto',enhanceFrame=true,cycle?:number,method:SurfaceMethod='neural',allowNeural=true):Promise<ReadResult[]>{
  await ready;
  if(!(image instanceof Blob)){
    let learned:ReadResult[]=[];
    if(allowNeural&&(mode==='auto'||mode==='curve')){
      const runner=await neuralRunner();
      if(runner)try{learned=await neuralReads(image,rasterReader,runner,method);}catch{disableNeural();}
    }
    return mergeReads(await scanRaster(image,rasterReader,mode,enhanceFrame,cycle),learned);
  }
  let raw:ReadResult[]=[];
  let baseError:unknown;
  if(mode!=='sharpen'){
    try{raw=await readBarcodes(image,locatingOptions);}catch(error){baseError=error;}
  }
  let base=validReads(raw);
  if(mode==='standard'){if(baseError)throw baseError;return base;}
  try{
    const {raster,scaleX,scaleY}=await rasterize(image);
    if(allowNeural&&(mode==='auto'||mode==='curve')){
      const runner=await neuralRunner();
      if(runner)try{base=mergeReads(base,scalePositions(await neuralReads(raster,rasterReader,runner,method),scaleX,scaleY));}catch{disableNeural();}
    }
    if(mode==='sharpen')return scalePositions(await enhancedReads(raster,rasterReader),scaleX,scaleY);
    if(mode==='auto')try{base=mergeReads(base,scalePositions(await enhancedReads(raster,rasterReader),scaleX,scaleY));}catch{/* Continue with other methods. */}
    let candidates=scalePositions(raw,1/scaleX,1/scaleY);
    if(mode==='auto'||mode==='shadow'||!candidates.some(code=>code.isValid===false)){
      try{const shadow=await shadowReads(raster,rasterReader,true);base=mergeReads(base,scalePositions(validReads(shadow),scaleX,scaleY));candidates=[...candidates,...shadow];}catch{/* Continue with original candidates. */}
      try{const shadow=await shadowReads(raster,rasterReader,true,'mean');base=mergeReads(base,scalePositions(validReads(shadow),scaleX,scaleY));candidates=[...candidates,...shadow];}catch{/* Continue with other candidates. */}
    }
    if(mode==='shadow')return base;
    const curved=scalePositions(await curvedReads(raster,rasterReader,candidates),scaleX,scaleY);
    return mergeReads(base,curved);
  }catch(error){if(mode==='sharpen'||(baseError&&!base.length))throw error;return base;}
}
