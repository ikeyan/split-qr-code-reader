import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {createStructuredAppend, type StructuredAppendSymbol} from '@kubohiroya/qrcode-structured-append';
import {PNG} from 'pngjs';
import {prepareZXingModule,readBarcodes} from 'zxing-wasm/reader';
import {accept,assemble,type Assembly} from '../src/assemble.ts';

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
    let state: Assembly=null;
    for (let index=parts.length-1;index>=0;index--) {
      const codes=await readBarcodes(makeQr(parts[index]),{formats:['QRCode']});
      assert.equal(codes.length,1); const code=codes[0];
      assert.equal(code.sequenceIndex,index);assert.equal(code.sequenceSize,parts.length);assert.equal(Number(code.sequenceId),parts[index].parity);
      assert.deepEqual([...code.bytes],[...parts[index].bytes]);
      state=accept(state,{index:code.sequenceIndex,total:code.sequenceSize,parity:Number(code.sequenceId),bytes:code.bytes}).state;
    }
    const result=assemble(state);assert.equal(result.status,'complete');assert.deepEqual([...result.bytes!],[...bytes]);
  }),{numRuns:25});
});
