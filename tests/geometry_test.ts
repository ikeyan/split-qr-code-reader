import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {contains} from '../src/geometry.ts';
Deno.test('pointer hit testing follows translated rectangles',()=>{
  fc.assert(fc.property(fc.integer({min:-10000,max:10000}),fc.integer({min:-10000,max:10000}),fc.integer({min:2,max:1000}),fc.integer({min:2,max:1000}),(x,y,w,h)=>{
    const polygon=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
    assert.equal(contains(polygon,{x:x+w/2,y:y+h/2}),true);
    assert.equal(contains(polygon,{x:x-1,y:y+h/2}),false);
    assert.equal(contains(polygon,{x:x+w+1,y:y+h/2}),false);
  }));
});
