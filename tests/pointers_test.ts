import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {Pointers} from '../src/pointers.ts';
type Point={x:number;y:number};
type Model={positions:Map<number,Point>};
type Real={pointers:Pointers};
class Move implements fc.Command<Model,Real>{
  constructor(readonly id:number,readonly x:number,readonly y:number){}
  check(){return true;}
  run(m:Model,r:Real){m.positions.set(this.id,{x:this.x,y:this.y});r.pointers.update(this.id,{x:this.x,y:this.y});}
  toString(){return `move(${this.id},${this.x},${this.y})`;}
}
class Release implements fc.Command<Model,Real>{
  constructor(readonly id:number){}
  check(){return true;}
  run(m:Model,r:Real){m.positions.delete(this.id);r.pointers.remove(this.id);}
  toString(){return `release(${this.id})`;}
}
class Frame implements fc.Command<Model,Real>{
  constructor(readonly x:number,readonly y:number,readonly size:number){}
  check(){return true;}
  run(m:Model,r:Real){
    const {x,y,size}=this;
    const poly=[{x,y},{x:x+size,y},{x:x+size,y:y+size},{x,y:y+size}];
    const expected=[...m.positions.values()].filter(p=>p.x>=x&&p.x<x+size&&p.y>=y&&p.y<y+size).length;
    assert.equal(r.pointers.select([poly],p=>p).length,expected);
  }
  toString(){return `frame(${this.x},${this.y},${this.size})`;}
}
const coordinate=fc.integer({min:-10,max:10}),id=fc.integer({min:0,max:3});
Deno.test('model: held pointers select whichever QR moves beneath them',()=>{
  fc.assert(fc.property(fc.commands([
    fc.tuple(id,coordinate,coordinate).map(([i,x,y])=>new Move(i,x,y)),
    id.map(i=>new Release(i)),
    fc.tuple(coordinate,coordinate,fc.integer({min:1,max:10})).map(([x,y,n])=>new Frame(x,y,n)),
  ],{maxCommands:100}),commands=>fc.modelRun(()=>({model:{positions:new Map()},real:{pointers:new Pointers()}}),commands)),{numRuns:250});
});
