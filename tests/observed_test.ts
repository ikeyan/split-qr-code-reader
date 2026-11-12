import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import type {ReadResult} from 'zxing-wasm/reader';
import {httpLink,observation,Observations} from '../src/observed.ts';
function code(text:string,index=-1,total=-1):ReadResult{return {text,sequenceSize:total,sequenceIndex:index,sequenceId:'',bytes:new TextEncoder().encode(text)} as ReadResult;}
Deno.test('only complete HTTP and HTTPS QR contents become links',()=>{
  fc.assert(fc.property(fc.domain(),fc.constantFrom('http','https'),(domain,protocol)=>{
    const value=`${protocol}://${domain}/`;
    assert.equal(httpLink(value),value);
    assert.equal(observation(code(value)).url,value);
    assert.equal(observation(code(value,0,2)).url,value);
  }));
  for(const unsafe of ['javascript:alert(1)','data:text/html,hi','file:///tmp/a','https://','ordinary text'])assert.equal(httpLink(unsafe),null);
});
Deno.test('observed contents remain briefly then disappear; clearing drops all',()=>{
  fc.assert(fc.property(fc.array(fc.string({minLength:1,maxLength:20}),{minLength:1,maxLength:10}),fc.integer({min:1,max:1000}),(texts,lifetime)=>{
    const tracker=new Observations(lifetime),codes=texts.map(text=>code(text));
    const initial=tracker.update(codes,0);
    assert.deepEqual(tracker.update([],lifetime),initial);
    assert.deepEqual(tracker.update([],lifetime+1),[]);
    tracker.update(codes,lifetime+2);tracker.clear();assert.deepEqual(tracker.update([],lifetime+2),[]);
  }));
});
