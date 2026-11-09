import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {type Assembly, assemble} from '../src/assemble.ts';
import {takePart} from '../src/session.ts';

Deno.test('completing a valid set stops the camera once and retains every part', () => {
  fc.assert(fc.property(fc.array(fc.uint8Array({minLength:1,maxLength:20}),{minLength:2,maxLength:16}), parts => {
    const parity = parts.flatMap(p => [...p]).reduce((a,b)=>a^b,0);
    let state: Assembly = null, stops = 0;
    for (const [index,bytes] of parts.entries()) {
      const update = takePart(state, {index,total:parts.length,parity,bytes}, () => stops++);
      state = update.state;
      assert.equal(stops, index === parts.length - 1 ? 1 : 0);
      assert.equal(state!.parts.size,index+1);
    }
    assert.equal(assemble(state).status,'complete');
    assert.equal(state!.parts.size,parts.length);
    const repeated = takePart(state,{index:0,total:parts.length,parity,bytes:parts[0]},()=>stops++);
    assert.equal(repeated.outcome,'duplicate');
    assert.equal(stops,1);
  }));
});

Deno.test('checksum failures do not stop the camera or discard parts', () => {
  fc.assert(fc.property(fc.array(fc.uint8Array({minLength:1,maxLength:20}),{minLength:2,maxLength:16}), parts => {
    const parity = parts.flatMap(p => [...p]).reduce((a,b)=>a^b,0) ^ 1;
    let state: Assembly = null, stops = 0;
    for (const [index,bytes] of parts.entries()) state = takePart(state,{index,total:parts.length,parity,bytes},()=>stops++).state;
    assert.equal(stops,0);
    assert.equal(assemble(state).status,'checksum-error');
    assert.equal(state!.parts.size,parts.length);
  }));
});
