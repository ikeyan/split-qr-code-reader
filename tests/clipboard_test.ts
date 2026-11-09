import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {clipboardImages,readClipboardImages} from '../src/clipboard.ts';
Deno.test('paste extracts only image files',()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{maxLength:20}),flags=>{
    const files=flags.map((image,i)=>new File([String(i)],`${i}`,{type:image?'image/png':'text/plain'}));
    const items=files.map(file=>({kind:'file',type:file.type,getAsFile:()=>file}));
    const data={items,files} as unknown as DataTransfer;
    assert.deepEqual(clipboardImages(data),files.filter(file=>file.type.startsWith('image/')));
  }));
});
Deno.test('clipboard button reads image types only',async()=>{
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(),{maxLength:20}),async flags=>{
    const items=flags.map(image=>({types:[image?'image/png':'text/plain'],getType:async(type:string)=>new Blob(['x'],{type})}));
    const clipboard={read:async()=>items} as unknown as Clipboard;
    const images=await readClipboardImages(clipboard);
    assert.equal(images.length,flags.filter(Boolean).length);assert.ok(images.every(image=>image.type==='image/png'));
  }));
});
Deno.test('HEIC filenames are accepted even when MIME type is missing',()=>{
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,12}$/),name=>{
    const file=new File(['x'],`${name}.HEIC`,{type:''});
    const data={items:[{kind:'file',type:'',getAsFile:()=>file}],files:[file]} as unknown as DataTransfer;
    assert.deepEqual(clipboardImages(data),[file]);
  }));
});
