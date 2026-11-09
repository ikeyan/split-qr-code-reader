import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {isHeif,prepareImage} from '../src/images.ts';
Deno.test('HEIF signatures are detected and converted locally regardless of MIME type',async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom('heic','heix','hevc','mif1'),fc.uint8Array({maxLength:40}),async(brand,payload)=>{
    const header=new Uint8Array([0,0,0,20,102,116,121,112,...new TextEncoder().encode(brand),0,0,0,0,104,101,105,99]);
    const file=new Blob([header,payload],{type:''});
    assert.equal(await isHeif(file),true);
    let called=0;
    const png=new Blob([payload],{type:'image/png'});
    const result=await prepareImage(file,({blob,type})=>{called++;assert.equal(blob,file);assert.equal(type,'image/png');return Promise.resolve(png);});
    assert.equal(called,1);assert.equal(result,png);
  }));
});
Deno.test('ordinary images pass through and AVIF is not identified as HEIC',async()=>{
  const avif=new Blob([new Uint8Array([0,0,0,20,102,116,121,112,97,118,105,102,0,0,0,0,109,105,102,49])],{type:'image/avif'});
  assert.equal(await isHeif(avif),false);
  assert.equal(await prepareImage(avif,()=>Promise.reject(new Error('must not convert'))),avif);
  assert.equal(await isHeif(new Blob([new Uint8Array([0,1,2])])),false);
});
