import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {sharpen} from '../src/image-enhance.ts';
Deno.test('enhancement preserves uniform images and never modifies the source',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:30}),fc.integer({min:1,max:30}),fc.integer({min:0,max:255}),(width,height,value)=>{
    const data=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=value;data[i+3]=255;}
    const before=data.slice(),result=sharpen({width,height,data});
    assert.deepEqual(data,before);assert.deepEqual(result.data,before);
  }));
});
