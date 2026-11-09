import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {createStructuredAppend, type StructuredAppendSymbol} from '@kubohiroya/qrcode-structured-append';
import iconv from 'iconv-lite';
import {PNG} from 'pngjs';
import {prepareZXingModule,readBarcodes} from 'zxing-wasm/reader';
import {addPart,emptyCollection} from '../src/collection.ts';

const wasmBinary=await Deno.readFile('vendor/zxing_reader.wasm');
await prepareZXingModule({overrides:{wasmBinary},fireImmediately:true});
function makeQr(qr: StructuredAppendSymbol) {
  const scale=5, quiet=4, size=(qr.size+quiet*2)*scale;
  const png=new PNG({width:size,height:size});png.data.fill(255);
  for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.isDark(x,y))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
    const pos=(((y+quiet)*scale+dy)*size+(x+quiet)*scale+dx)*4;
    png.data[pos]=png.data[pos+1]=png.data[pos+2]=0;
  }
  return PNG.sync.write(png);
}
Deno.test('generated structured QR images retain their metadata and reconstruct the message', async()=>{
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:30,maxLength:100}),async bytes=>{
    const parts=createStructuredAppend(bytes,{maxVersion:1});
    assert.ok(parts.length >= 2);
    let state=emptyCollection();
    for (let index=parts.length-1;index>=0;index--) {
      const codes=await readBarcodes(makeQr(parts[index]),{formats:['QRCode']});
      assert.equal(codes.length,1); const code=codes[0];
      assert.equal(code.sequenceIndex,index);assert.equal(code.sequenceSize,parts.length);assert.equal(Number(code.sequenceId),parts[index].parity);
      assert.deepEqual([...code.bytes],[...parts[index].bytes]);
      state=addPart(state,{index:code.sequenceIndex,total:code.sequenceSize,parity:Number(code.sequenceId),bytes:code.bytes}).collection;
    }
    assert.equal(state.suites.length,1); assert.deepEqual(state.suites[0].parts.flatMap(part=>[...part.bytes]),[...bytes]);
  }),{numRuns:25});
});

Deno.test('generated Shift_JIS structured QR images reconstruct Japanese text',async()=>{
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({min:0x3041,max:0x3093}),{minLength:15,maxLength:60}),async points=>{
    const text=String.fromCodePoint(...points);
    const bytes=iconv.encode(text,'shift_jis');
    const parts=createStructuredAppend(bytes,{maxVersion:1});
    let state=emptyCollection();
    for(const part of [...parts].reverse()){
      const [code]=await readBarcodes(makeQr(part),{formats:['QRCode']});
      state=addPart(state,{index:code.sequenceIndex,total:code.sequenceSize,parity:Number(code.sequenceId),bytes:code.bytes}).collection;
    }
    assert.equal(state.suites.length,1);
    assert.equal(state.suites[0].text,text);
  }),{numRuns:20});
});
Deno.test('several generated parts on one image are detected and assembled',async()=>{
  await fc.assert(fc.asyncProperty(fc.uint8Array({minLength:30,maxLength:55}),async bytes=>{
    const parts=createStructuredAppend(bytes,{maxVersion:1});
    const images=parts.map(part=>PNG.sync.read(makeQr(part)));
    const gap=20,width=images.reduce((sum,image)=>sum+image.width+gap,0)+gap,height=Math.max(...images.map(image=>image.height))+gap*2;
    const canvas=new PNG({width,height});canvas.data.fill(255);let x=gap;
    for(const image of images){PNG.bitblt(image,canvas,0,0,image.width,image.height,x,gap);x+=image.width+gap;}
    const codes=await readBarcodes(PNG.sync.write(canvas),{formats:['QRCode'],maxNumberOfSymbols:0});
    assert.equal(codes.length,parts.length);
    let state=emptyCollection();
    for(const code of codes)state=addPart(state,{index:code.sequenceIndex,total:code.sequenceSize,parity:Number(code.sequenceId),bytes:code.bytes}).collection;
    assert.equal(state.suites.length,1);
    assert.deepEqual(state.suites[0].parts.flatMap(p=>[...p.bytes]),[...bytes]);
  }),{numRuns:12});
});
