import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {addPart,deleteSuite,emptyCollection,type Collection,type InputPart} from '../src/collection.ts';

type Model={parts:InputPart[]};
type Real={collection:Collection};
function equal(a:InputPart,b:InputPart){return a.total===b.total&&a.parity===b.parity&&a.index===b.index&&a.bytes.length===b.bytes.length&&a.bytes.every((n,i)=>n===b.bytes[i]);}
function signature(parts:InputPart[]){return `${parts[0].total}/${parts[0].parity}/`+parts.map(part=>Array.from(part.bytes).join(',')).join('|');}
function expected(parts:InputPart[]):string[]{
  const groups=new Map<string,InputPart[]>();
  for(const part of parts){const key=`${part.total}/${part.parity}`;groups.set(key,[...(groups.get(key)??[]),part]);}
  const result:string[]=[];
  for(const group of groups.values()){
    const slots=Array.from({length:group[0].total},(_,i)=>group.filter(p=>p.index===i));
    const products=slots.reduce<InputPart[][]>((all,slot)=>all.flatMap(a=>slot.map(p=>[...a,p])),[[]]);
    for(const product of products)if(product.flatMap(part=>[...part.bytes]).reduce((a,b)=>a^b,0)===group[0].parity)result.push(signature(product));
  }
  return result.sort();
}
function check(m:Model,r:Real){
  assert.deepEqual(r.collection.suites.map(s=>signature(s.parts)).sort(),expected(m.parts));
  assert.equal(r.collection.groups.flatMap(g=>g.slots.flat()).length,m.parts.length);
}
class Add implements fc.Command<Model,Real>{
  constructor(readonly p:InputPart){}
  check(){return true;}
  run(m:Model,r:Real){const duplicate=m.parts.some(p=>equal(p,this.p));const result=addPart(r.collection,this.p);assert.equal(result.outcome,duplicate?'duplicate':'accepted');if(!duplicate)m.parts.push(this.p);r.collection=result.collection;check(m,r);}
  toString(){return `add(${this.p.index}/${this.p.total},${this.p.parity},${this.p.bytes})`;}
}
class Delete implements fc.Command<Model,Real>{
  constructor(readonly choice:number){}
  check(_m:Model){return true;}
  run(m:Model,r:Real){if(r.collection.suites.length){const suite=r.collection.suites[this.choice%r.collection.suites.length];m.parts=m.parts.filter(p=>!suite.parts.some(part=>equal(p,part)));r.collection=deleteSuite(r.collection,suite.id);}check(m,r);}
  toString(){return `delete(${this.choice})`;}
}
class Reset implements fc.Command<Model,Real>{check(){return true;}run(m:Model,r:Real){m.parts=[];r.collection=emptyCollection();check(m,r);}toString(){return 'reset';}}
const part=fc.integer({min:1,max:3}).chain(total=>fc.record({total:fc.constant(total),index:fc.integer({min:0,max:total-1}),parity:fc.integer({min:0,max:3}),bytes:fc.array(fc.integer({min:0,max:3}),{minLength:1,maxLength:2}).map(a=>new Uint8Array(a))}));
Deno.test('model: multiple groups, variants, checksum combinations, deletion and reset',()=>{
  fc.assert(fc.property(fc.commands([part.map(p=>new Add(p)),fc.nat(10).map(n=>new Delete(n)),fc.constant(new Reset())],{maxCommands:100}),commands=>fc.modelRun(()=>({model:{parts:[]},real:{collection:emptyCollection()}}),commands)),{numRuns:350});
});
Deno.test('every checksum-valid combination appears once, and shared parts are removed with a suite',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:255}),fc.integer({min:1,max:255}),(a,b)=>{
    fc.pre(a!==b);
    let state=emptyCollection();const parity=0;
    for(const [index,value] of [[0,a],[1,a],[0,b],[1,b]])state=addPart(state,{index,total:2,parity,bytes:Uint8Array.of(value)}).collection;
    assert.equal(state.suites.length,2);
    state=deleteSuite(state,state.suites[0].id);
    assert.equal(state.suites.length,1);
    assert.equal(state.groups[0].slots[0].length,1);
  }));
});
Deno.test('deleting a result removes other results which share one of its QR parts',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:255}),fc.integer({min:1,max:255}),(byte,extra)=>{
    let state=emptyCollection();
    for(const [index,bytes] of [[0,Uint8Array.of(byte)],[0,Uint8Array.of(byte^extra,extra)],[1,Uint8Array.of(byte)]] as const){
      state=addPart(state,{index,total:2,parity:0,bytes}).collection;
    }
    assert.equal(state.suites.length,2);
    state=deleteSuite(state,state.suites[0].id);
    assert.equal(state.suites.length,0);
    assert.equal(state.groups[0].slots[0].length,1);
    assert.equal(state.groups[0].slots[1].length,0);
  }));
});
