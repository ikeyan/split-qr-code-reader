import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {dismissPreview,enqueuePreviews,retainPreviews} from '../src/previews.ts';
type Model={queue:string[];results:Set<string>};
type Real={queue:string[];results:Set<string>};
class Complete implements fc.Command<Model,Real>{
  constructor(readonly id:string){} check(){return true;}
  run(m:Model,r:Real){m.results.add(this.id);r.results.add(this.id);if(!m.queue.includes(this.id))m.queue.push(this.id);r.queue=enqueuePreviews(r.queue,[this.id]);assert.deepEqual(r.queue,m.queue);}
  toString(){return `complete(${this.id})`;}
}
class Dismiss implements fc.Command<Model,Real>{
  check(){return true;}
  run(m:Model,r:Real){m.queue.shift();r.queue=dismissPreview(r.queue);assert.deepEqual(r.queue,m.queue);assert.deepEqual(r.results,m.results);}
  toString(){return 'dismiss';}
}
class Remove implements fc.Command<Model,Real>{
  constructor(readonly id:string){} check(){return true;}
  run(m:Model,r:Real){m.results.delete(this.id);r.results.delete(this.id);m.queue=m.queue.filter(id=>id!==this.id);r.queue=retainPreviews(r.queue,r.results);assert.deepEqual(r.queue,m.queue);}
  toString(){return `remove(${this.id})`;}
}
Deno.test('model: previews queue completed results, dismiss without deleting, and drop deleted results',()=>{
  const id=fc.integer({min:0,max:8}).map(String);
  fc.assert(fc.property(fc.commands([id.map(x=>new Complete(x)),fc.constant(new Dismiss()),id.map(x=>new Remove(x))],{maxCommands:80}),commands=>fc.modelRun(()=>({model:{queue:[],results:new Set<string>()},real:{queue:[],results:new Set<string>()}}),commands)),{numRuns:200});
});
