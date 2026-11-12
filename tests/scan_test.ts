import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {createStructuredAppend} from '@kubohiroya/qrcode-structured-append';
import {PNG} from 'pngjs';
import {prepareZXingModule,readBarcodes,type ReadResult} from 'zxing-wasm/reader';
import {mergeReads,scanRaster,type RasterReader} from '../src/scan.ts';
import type {Raster} from '../src/image-enhance.ts';

await prepareZXingModule({overrides:{wasmBinary:await Deno.readFile('vendor/zxing_reader.wasm')},fireImmediately:true});
const reader:RasterReader=async(image,options)=>{const png=new PNG({width:image.width,height:image.height});png.data.set(image.data);return await readBarcodes(PNG.sync.write(png),options);};
function createQr(bytes:Uint8Array,scale:number):Raster {
  const qr=createStructuredAppend(bytes,{maxVersion:2})[0],size=(qr.size+8)*scale;
  const data=new Uint8ClampedArray(size*size*4);data.fill(255);
  for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.isDark(x,y))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
    const i=(((y+4)*scale+dy)*size+(x+4)*scale+dx)*4;data[i]=data[i+1]=data[i+2]=0;
  }
  return {width:size,height:size,data};
}
function distort(image:Raster,skew:number,perspective:number,blur:number):Raster {
  const {width,height}=image,warped=new Uint8ClampedArray(image.data.length);warped.fill(255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rel=(y/height)-0.5;
    const srcX=Math.round((x-width/2-skew*rel*width)/(1+perspective*rel)+width/2);
    if(srcX>=0&&srcX<width){const i=(y*width+x)*4,j=(y*width+srcX)*4;warped[i]=warped[i+1]=warped[i+2]=image.data[j];}
  }
  if(!blur)return {width,height,data:warped};
  const data=new Uint8ClampedArray(warped.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let total=0,count=0;
    for(let dy=-blur;dy<=blur;dy++)for(let dx=-blur;dx<=blur;dx++){
      const xx=Math.max(0,Math.min(width-1,x+dx)),yy=Math.max(0,Math.min(height-1,y+dy));total+=warped[(yy*width+xx)*4];count++;
    }
    const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=Math.round(total/count);data[i+3]=255;
  }
  return {width,height,data};
}
Deno.test('generated blurred QR images retain baseline reads and recover additional codes',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:55}),async bytes=>{
    const expected=createStructuredAppend(bytes,{maxVersion:2})[0];
    const image=distort(createQr(bytes,3),0,0,2);
    const baseline=await readBarcodes((()=>{const png=new PNG({width:image.width,height:image.height});png.data.set(image.data);return PNG.sync.write(png);})(),{formats:['QRCode'],tryHarder:true,maxNumberOfSymbols:0});
    const result=await scanRaster(image,reader,'auto');
    for(const original of baseline)assert.ok(result.some(item=>item.sequenceIndex===original.sequenceIndex&&item.sequenceSize===original.sequenceSize&&item.sequenceId===original.sequenceId&&item.bytes.length===original.bytes.length&&item.bytes.every((b,i)=>b===original.bytes[i])));
    if(!baseline.length&&result.some(code=>code.sequenceIndex===expected.index&&code.sequenceSize===expected.count&&Number(code.sequenceId)===expected.parity&&code.bytes.length===expected.bytes.length&&code.bytes.every((byte,i)=>byte===expected.bytes[i])))recovered++;
  }),{numRuns:30,seed:20261112});
  assert.ok(recovered>0,'enhanced scanning should recover some images missed by the previous method');
});
Deno.test('generated QR codes with skew and moderate blur remain readable',async()=>{
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:30,maxLength:50}),fc.integer({min:-18,max:18}),fc.integer({min:-12,max:12}),async(bytes,skew,perspective)=>{
    const part=createStructuredAppend(bytes,{maxVersion:2})[0];
    const image=distort(createQr(bytes,5),skew/100,perspective/100,1);
    const result=await scanRaster(image,reader,'auto');
    assert.ok(result.some(code=>code.sequenceIndex===part.index&&code.sequenceSize===part.count&&Number(code.sequenceId)===part.parity&&code.bytes.every((byte,i)=>byte===part.bytes[i])));
  }),{numRuns:20});
});
function fakeRead(x:number,text:string):ReadResult {
  const point=(x:number,y:number)=>({x,y});
  return {sequenceIndex:0,sequenceSize:2,sequenceId:'1',bytes:new TextEncoder().encode(text),position:{topLeft:point(x,0),topRight:point(x+10,0),bottomRight:point(x+10,10),bottomLeft:point(x,10)}} as ReadResult;
}
Deno.test('merging scans retains separate codes with identical content',()=>{
  fc.assert(fc.property(fc.integer({min:30,max:1000}),fc.string({minLength:1,maxLength:20}),(separation,text)=>{
    const a=fakeRead(0,text),same=fakeRead(1,text),other=fakeRead(separation,text);
    assert.equal(mergeReads([a],[same,other]).length,2);
  }));
});
Deno.test('method selection invokes the requested scans',async()=>{
  const image=createQr(new Uint8Array(40).fill(42),4);
  for(const mode of ['standard','sharpen','shadow','curve','auto'] as const){
    const calls:Raster[]=[];
    await scanRaster(image,(raster)=>{calls.push(raster);return Promise.resolve([]);},mode);
    if(mode==='standard'||mode==='sharpen')assert.equal(calls.length,1);
    else assert.ok(calls.length>=2);
    assert.equal(calls[0]===image,mode!=='sharpen');
  }
});
Deno.test('multiple generated codes remain visible after enhanced scanning',async()=>{
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:30,maxLength:50}),fc.uint8Array({minLength:30,maxLength:50}),async(first,second)=>{
    const a=createQr(first,5),b=distort(createQr(second,5),0.1,0.08,1),gap=20;
    const width=a.width+b.width+gap*3,height=Math.max(a.height,b.height)+gap*2;
    const data=new Uint8ClampedArray(width*height*4);data.fill(255);
    for(const [source,left] of [[a,gap],[b,a.width+gap*2]] as const)for(let y=0;y<source.height;y++){
      data.set(source.data.subarray(y*source.width*4,(y+1)*source.width*4),((y+gap)*width+left)*4);
    }
    const result=await scanRaster({width,height,data},reader,'auto');
    assert.ok(result.length>=2);
    assert.ok(result.some(code=>code.position.topLeft.x<width/2));
    assert.ok(result.some(code=>code.position.topLeft.x>width/2));
  }),{numRuns:15});
});
