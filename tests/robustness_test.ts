import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {PNG} from 'pngjs';
import {createStructuredAppend} from '@kubohiroya/qrcode-structured-append';
import {prepareZXingModule,readBarcodes,type ReadResult} from 'zxing-wasm/reader';
import {scanRaster,scanOptions,shadowReads,type RasterReader} from '../src/scan.ts';
import {curvedPoint,curveVariants,type Curve} from '../src/curvature.ts';
import type {Raster} from '../src/image-enhance.ts';
import {contains} from '../src/geometry.ts';

await prepareZXingModule({overrides:{wasmBinary:await Deno.readFile('vendor/zxing_reader.wasm')},fireImmediately:true});
const reader:RasterReader=async(image,options)=>{const png=new PNG({width:image.width,height:image.height});png.data.set(image.data);return await readBarcodes(PNG.sync.write(png),options);};
function generated(bytes:Uint8Array):Raster{
  const qr=createStructuredAppend(bytes,{maxVersion:2})[0],scale=5,width=(qr.size+8)*scale,data=new Uint8ClampedArray(width*width*4);data.fill(255);
  for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.isDark(x,y))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
    const i=(((y+4)*scale+dy)*width+(x+4)*scale+dx)*4;data[i]=data[i+1]=data[i+2]=0;
  }
  return {width,height:width,data};
}
/** Inverse mapping simulates paper bent around an axis. */
function bend(image:Raster,curve:Curve):Raster {
  const {width,height}=image,data=new Uint8ClampedArray(image.data.length),horizontal=curve.axis==='horizontal';data.fill(255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const main=(horizontal?(x+0.5)/width:(y+0.5)/height)*2-1,cross=(horizontal?(y+0.5)/height:(x+0.5)/width)*2-1;
    let lo=-1,hi=1;
    for(let i=0;i<14;i++){const t=(lo+hi)/2;if(t+curve.strength*(t*t*t-t)<main)lo=t;else hi=t;}
    const t=(lo+hi)/2,v=cross/(1-curve.strength*0.25*(1-t*t));
    const sx=Math.floor((horizontal?t+1:v+1)/2*width),sy=Math.floor((horizontal?v+1:t+1)/2*height);
    if(sx>=0&&sx<width&&sy>=0&&sy<height){const from=(sy*width+sx)*4,to=(y*width+x)*4;data[to]=data[to+1]=data[to+2]=image.data[from];}
  }
  return {width,height,data};
}
function place(image:Raster,left:number,top:number):Raster{
  const width=image.width*3,height=image.height*2,data=new Uint8ClampedArray(width*height*4);data.fill(255);
  for(let y=0;y<image.height;y++)data.set(image.data.subarray(y*image.width*4,(y+1)*image.width*4),((y+top)*width+left)*4);
  return {width,height,data};
}
function isExpected(code:ReadResult,bytes:Uint8Array){const expected=createStructuredAppend(bytes,{maxVersion:2})[0];return code.isValid!==false&&code.sequenceIndex===expected.index&&code.sequenceSize===expected.count&&Number(code.sequenceId)===expected.parity&&code.bytes.length===expected.bytes.length&&code.bytes.every((value,i)=>value===expected.bytes[i]);}
Deno.test('curved QR candidates can be recovered and mapped back to their position',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.constantFrom('horizontal','vertical'),fc.constantFrom(0.3,0.4,-0.3,-0.4),fc.integer({min:10,max:30}),async(bytes,axis,strength,offset)=>{
    const qr=bend(generated(bytes),{axis,strength});
    const left=qr.width+offset,top=offset,image=place(qr,left,top);
    const before=await reader(image,scanOptions);
    const after=await scanRaster(image,reader,'curve');
    for(const item of after)assert.notEqual(item.isValid,false);
    const code=after.find(item=>isExpected(item,bytes));
    if(!before.some(item=>isExpected(item,bytes))&&code){
      recovered++;
      const p=code.position;
      assert.ok(contains([p.topLeft,p.topRight,p.bottomRight,p.bottomLeft],{x:left+qr.width/2,y:top+qr.height/2}));
    }
  }),{numRuns:16,seed:20261112});
  assert.ok(recovered>=4,`only ${recovered} curved samples recovered`);
});
Deno.test('partial shadow correction retains original reads and recovers difficult cases',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.integer({min:35,max:65}),fc.integer({min:20,max:40}),fc.integer({min:40,max:60}),async(bytes,dark,contrast,boundary)=>{
    const image=generated(bytes),start=Math.floor(image.width*boundary/100);
    for(let y=0;y<image.height;y++)for(let x=start;x<image.width;x++){
      const i=(y*image.width+x)*4,value=dark+image.data[i]*contrast/255;image.data[i]=image.data[i+1]=image.data[i+2]=value;
    }
    const before=await reader(image,scanOptions),after=await scanRaster(image,reader,'shadow');
    for(const original of before)assert.ok(after.some(code=>code.sequenceIndex===original.sequenceIndex&&code.sequenceId===original.sequenceId&&code.bytes.length===original.bytes.length&&code.bytes.every((v,i)=>v===original.bytes[i])));
    if(!before.some(code=>isExpected(code,bytes))&&after.some(code=>isExpected(code,bytes)))recovered++;
  }),{numRuns:20,seed:20261112});
  assert.ok(recovered>=5,`only ${recovered} shadow samples recovered`);
});
Deno.test('an alternative local threshold can recover low-contrast codes across a partial shadow',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(
    fc.uint8Array({minLength:30,maxLength:50}),fc.integer({min:195,max:210}),fc.integer({min:55,max:75}),
    fc.integer({min:60,max:75}),fc.oneof(fc.integer({min:15,max:30}),fc.integer({min:65,max:85})),
    async(bytes,light,contrast,factor,boundary)=>{
      const image=generated(bytes);
      for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
        const i=(y*image.width+x)*4;
        const value=(image.data[i]===0?light-contrast:light)*(x>image.width*boundary/100?factor/100:1);
        image.data[i]=image.data[i+1]=image.data[i+2]=value;
      }
      const raw=await reader(image,scanOptions),sauvola=await shadowReads(image,reader),mean=await shadowReads(image,reader,false,'mean');
      if(!raw.some(code=>isExpected(code,bytes))&&!sauvola.some(code=>isExpected(code,bytes))&&mean.some(code=>isExpected(code,bytes))){
        recovered++;
        assert.ok((await scanRaster(image,reader,'auto')).some(code=>isExpected(code,bytes)));
      }
    }),{numRuns:100,seed:123});
  assert.ok(recovered>0,`no additional low-contrast QR recovered`);
});
Deno.test('curve transforms leave normalized center and valid coordinates stable',()=>{
  fc.assert(fc.property(fc.constantFrom(...curveVariants),fc.double({min:0,max:1,noNaN:true}),fc.double({min:0,max:1,noNaN:true}),(curve,x,y)=>{
    const p=curvedPoint(x,y,curve),center=curvedPoint(0.5,0.5,curve);
    assert.ok(p.x>=-0.1&&p.x<=1.1&&p.y>=-0.1&&p.y<=1.1);
    assert.deepEqual(center,{x:0.5,y:0.5});
  }));
});
Deno.test('a curved QR with partial shadow can be recovered through combined corrections',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.constantFrom('horizontal','vertical'),fc.integer({min:45,max:65}),fc.integer({min:22,max:35}),async(bytes,axis,dark,contrast)=>{
    const qr=bend(generated(bytes),{axis,strength:0.4});
    for(let y=0;y<qr.height;y++)for(let x=Math.floor(qr.width*.48);x<qr.width;x++){
      const i=(y*qr.width+x)*4,value=dark+qr.data[i]*contrast/255;qr.data[i]=qr.data[i+1]=qr.data[i+2]=value;
    }
    const image=place(qr,qr.width+20,20);
    const before=await reader(image,scanOptions),after=await scanRaster(image,reader,'auto');
    if(!before.some(code=>isExpected(code,bytes))&&after.some(code=>isExpected(code,bytes)))recovered++;
  }),{numRuns:10,seed:20261112});
  assert.ok(recovered>=2,`only ${recovered} combined samples recovered`);
});
Deno.test('curved QR codes can be recovered when the paper is rotated',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.constantFrom('horizontal','vertical'),fc.integer({min:-30,max:30}),async(bytes,axis,degrees)=>{
    const source=bend(generated(bytes),{axis,strength:0.4});
    const size=Math.ceil(source.width*1.5),data=new Uint8ClampedArray(size*size*4);data.fill(255);
    const angle=degrees*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const u=x-size/2,v=y-size/2,sx=Math.floor(cos*u+sin*v+source.width/2),sy=Math.floor(-sin*u+cos*v+source.height/2);
      if(sx>=0&&sy>=0&&sx<source.width&&sy<source.height){const from=(sy*source.width+sx)*4,to=(y*size+x)*4;data[to]=data[to+1]=data[to+2]=source.data[from];}
    }
    const image=place({width:size,height:size,data},size+15,15),before=await reader(image,scanOptions),after=await scanRaster(image,reader,'curve');
    if(!before.some(code=>isExpected(code,bytes))&&after.some(code=>isExpected(code,bytes)))recovered++;
  }),{numRuns:14,seed:20261112});
  assert.ok(recovered>=2,`only ${recovered} rotated curved samples recovered`);
});
Deno.test('curvature fallback recovers some independently modeled cylindrical projections',async()=>{
  let recovered=0, missed=0, found=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.constantFrom('horizontal','vertical'),fc.integer({min:110,max:140}),async(bytes,axis,anglePercent)=>{
    const source=generated(bytes),width=source.width,height=source.height,data=new Uint8ClampedArray(source.data.length),horizontal=axis==='horizontal';data.fill(255);
    const angle=anglePercent/100,project=Math.sin(angle);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const main=(horizontal?(x+.5)/width:(y+.5)/height)*2-1,cross=(horizontal?(y+.5)/height:(x+.5)/width)*2-1;
      const original=Math.asin(Math.max(-1,Math.min(1,main*project)))/angle;
      const perpendicular=cross/(1-0.06*(1-original*original));
      const sx=Math.floor((horizontal?original+1:perpendicular+1)*width/2),sy=Math.floor((horizontal?perpendicular+1:original+1)*height/2);
      if(sx>=0&&sx<width&&sy>=0&&sy<height){const from=(sy*width+sx)*4,to=(y*width+x)*4;data[to]=data[to+1]=data[to+2]=source.data[from];}
    }
    const image=place({width,height,data},width+20,20),before=await reader(image,scanOptions),after=await scanRaster(image,reader,'curve');
    if(!before.some(code=>isExpected(code,bytes)))missed++;
    if(after.some(code=>isExpected(code,bytes)))found++;
    if(!before.some(code=>isExpected(code,bytes))&&after.some(code=>isExpected(code,bytes)))recovered++;
  }),{numRuns:20,seed:20261112});
  assert.ok(recovered>0,`cylindrical: missed ${missed}, found ${found}, recovered ${recovered}`);
});
Deno.test('a readable QR and a curved QR in one image are both retained',async()=>{
  let recovered=0;
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:35,maxLength:50}),fc.uint8Array({minLength:35,maxLength:50}),async(first,second)=>{
    const clean=generated(first),curved=bend(generated(second),{axis:'horizontal',strength:0.4}),gap=20;
    const width=clean.width+curved.width+gap*3,height=Math.max(clean.height,curved.height)+gap*2;
    const data=new Uint8ClampedArray(width*height*4);data.fill(255);
    for(const [part,left] of [[clean,gap],[curved,clean.width+gap*2]] as const)for(let y=0;y<part.height;y++)data.set(part.data.subarray(y*part.width*4,(y+1)*part.width*4),((y+gap)*width+left)*4);
    const image={width,height,data},before=await reader(image,scanOptions),after=await scanRaster(image,reader,'auto');
    assert.ok(after.some(code=>isExpected(code,first)));
    if(!before.some(code=>isExpected(code,second))&&after.some(code=>isExpected(code,second)))recovered++;
  }),{numRuns:10,seed:20261112});
  assert.ok(recovered>0,`no additional curved QR recovered`);
});
Deno.test('invalid detection candidates are never returned as readable QR codes',async()=>{
  const image=generated(new Uint8Array(40).fill(73));
  const point=(x:number,y:number)=>({x,y});
  const invalid={isValid:false,position:{topLeft:point(10,10),topRight:point(40,10),bottomRight:point(40,40),bottomLeft:point(10,40)}} as ReadResult;
  const result=await scanRaster(image,()=>Promise.resolve([invalid]),'auto',true,1);
  assert.deepEqual(result,[]);
});
