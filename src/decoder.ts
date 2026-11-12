import {prepareZXingModule,readBarcodes,type ReadResult} from 'zxing-wasm/reader';
import wasm from './wasm-data.ts';
import {enhancedReads,mergeReads,scanOptions,scanRaster,type ScanMode,type RasterReader} from './scan.ts';
import type {Raster} from './image-enhance.ts';
const binary=Uint8Array.from(atob(wasm),c=>c.charCodeAt(0));
const ready=prepareZXingModule({overrides:{wasmBinary:binary},fireImmediately:true});
const rasterReader:RasterReader=(image,options)=>readBarcodes(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>,image.width,image.height),options);
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
export async function decode(image:ImageData|Blob,mode:ScanMode='auto',enhanceFrame=true):Promise<ReadResult[]>{
  await ready;
  if(!(image instanceof Blob))return await scanRaster(image,rasterReader,mode,enhanceFrame);
  let base:ReadResult[]=[];
  let baseError:unknown;
  if(mode!=='sharpen'){
    try{base=await readBarcodes(image,scanOptions);}catch(error){baseError=error;}
  }
  if(mode==='standard'){if(baseError)throw baseError;return base;}
  try{
    const {raster,scaleX,scaleY}=await rasterize(image);
    const extra=scalePositions(await enhancedReads(raster,rasterReader),scaleX,scaleY);
    return mergeReads(base,extra);
  }catch(error){if(mode==='sharpen'||baseError)throw error;return base;}
}
