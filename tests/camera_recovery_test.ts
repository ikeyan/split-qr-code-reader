import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {CameraRecovery} from '../src/camera-recovery.ts';

type State={visible:boolean;active:boolean;ended:boolean;connections:number;restarts:number};
type System={state:State;recovery:CameraRecovery};

Deno.test('camera recovery follows visibility, camera and track state',async()=>{
  const set=(key:'visible'|'active'|'ended',value:boolean):fc.AsyncCommand<State,System>=>({
    check:()=>true,
    run:async(model,real)=>{model[key]=value;real.state[key]=value;},
    toString:()=>`${key}=${value}`,
  });
  const resume:fc.AsyncCommand<State,System>={
    check:()=>true,
    run:async(model,real)=>{
      if(model.visible&&model.active){if(model.ended)model.restarts++;else model.connections++;}
      await real.recovery.resume();
      assert.equal(real.state.connections,model.connections);assert.equal(real.state.restarts,model.restarts);
    },
    toString:()=>'resume',
  };
  await fc.assert(fc.asyncProperty(fc.commands([fc.constant(resume),...(['visible','active','ended'] as const).map(key=>fc.boolean().map(value=>set(key,value)))],{maxCommands:50}),async commands=>{
    const state:State={visible:true,active:false,ended:false,connections:0,restarts:0};
    const recovery=new CameraRecovery({eligible:()=>state.visible&&state.active,ended:()=>state.ended,reconnect:async()=>{state.connections++;},restart:async()=>{state.restarts++;}});
    await fc.asyncModelRun(()=>({model:{...state},real:{state,recovery}}),commands);
  }));
});

Deno.test('overlapping page events reconnect the stream once',async()=>{
  let finish!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{finish=resolve;});
  const recovery=new CameraRecovery({eligible:()=>true,ended:()=>false,restart:async()=>{},reconnect:async()=>{calls++;await waiting;}});
  const first=recovery.resume();await recovery.resume();assert.equal(calls,1);finish();await first;
  await recovery.resume();assert.equal(calls,2);
});
