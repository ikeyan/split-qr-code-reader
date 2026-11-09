import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {accept, assemble, type Assembly, type Part} from '../src/assemble.ts';

type Model = {total: number | null; parity: number | null; parts: Map<number, number[]>};
type Real = {state: Assembly};
class Add implements fc.Command<Model, Real> {
  constructor(readonly part: Part) {}
  check() { return true; }
  run(m: Model, r: Real) {
    const p = this.part, before = m.parts.get(p.index);
    let expected: string;
    if (m.total !== null && (m.total !== p.total || m.parity !== p.parity)) expected = 'conflict';
    else if (before) expected = before.length === p.bytes.length && before.every((v,i)=>v===p.bytes[i]) ? 'duplicate' : 'conflict';
    else { expected='accepted'; m.total=p.total; m.parity=p.parity; m.parts.set(p.index, [...p.bytes]); }
    const outcome=accept(r.state,p); r.state=outcome.state;
    assert.equal(outcome.outcome,expected);
    assert.equal(r.state?.parts.size ?? 0,m.parts.size);
    for (const [index, bytes] of m.parts) assert.deepEqual([...r.state!.parts.get(index)!],bytes);
    const combined = [...m.parts.entries()].sort(([a],[b])=>a-b).flatMap(([,value])=>value);
    const expectedStatus = m.parts.size !== m.total ? 'incomplete' : combined.reduce((a,b)=>a^b,0) === m.parity ? 'complete' : 'checksum-error';
    assert.equal(assemble(r.state).status, expectedStatus);
  }
  toString() {return `add(${this.part.index}/${this.part.total})`;}
}
class Reset implements fc.Command<Model,Real> {
  check(){return true;}
  run(m: Model,r: Real){m.total=null;m.parity=null;m.parts.clear();r.state=null;assert.equal(assemble(r.state).status,'incomplete');}
  toString(){return 'reset';}
}
const part = fc.integer({min:2,max:16}).chain(total => fc.record({index:fc.integer({min:0,max:total-1}),total:fc.constant(total),parity:fc.integer({min:0,max:255}),bytes:fc.uint8Array({maxLength:25})}));
Deno.test('model: additions and resets preserve accepted parts and parity result',()=>{
  fc.assert(fc.property(fc.commands([part.map(p=>new Add(p)),fc.constant(new Reset())],{maxCommands:80}), commands=>{
    fc.modelRun(()=>({model:{total:null,parity:null,parts:new Map()},real:{state:null}}),commands);
  }),{numRuns:250});
});
Deno.test('valid parts assemble regardless of order',()=>{
  fc.assert(fc.property(fc.array(fc.uint8Array({minLength:1,maxLength:20}),{minLength:2,maxLength:16}),fc.integer(),(parts,seed)=>{
    const parity=parts.flatMap(p=>[...p]).reduce((a,b)=>a^b,0);
    const order=parts.map((bytes,index)=>({bytes,index,total:parts.length,parity})).sort((a,b)=>((a.index+seed)%parts.length)-((b.index+seed)%parts.length));
    let state: Assembly=null; for (const p of order) state=accept(state,p).state;
    const result=assemble(state); assert.equal(result.status,'complete');assert.deepEqual([...result.bytes!],parts.flatMap(p=>[...p]));
  }));
});
