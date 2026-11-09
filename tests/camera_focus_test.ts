import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {focusAt,videoPoint} from '../src/camera-focus.ts';
Deno.test('video coordinates account for letterboxing',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.double({min:0.01,max:0.99,noNaN:true}),fc.double({min:0.01,max:0.99,noNaN:true}),(bw,bh,iw,ih,x,y)=>{
    const scale=Math.min(bw/iw,bh/ih),w=iw*scale,h=ih*scale;
    const point=videoPoint({x:(bw-w)/2+x*w,y:(bh-h)/2+y*h},{width:bw,height:bh},{width:iw,height:ih});
    assert.ok(point);assert.ok(Math.abs(point.x-x)<1e-10);assert.ok(Math.abs(point.y-y)<1e-10);
  }));
});
Deno.test('camera focus uses supported capabilities and tolerates rejection',async()=>{
  await fc.assert(fc.asyncProperty(fc.double({min:0,max:1,noNaN:true}),fc.double({min:0,max:1,noNaN:true}),fc.boolean(),async(x,y,reject)=>{
    const calls:MediaTrackConstraints[]=[];
    const track={getCapabilities:()=>({pointsOfInterest:true,focusMode:['continuous'],exposureMode:['continuous']}),applyConstraints:(constraints:MediaTrackConstraints)=>{calls.push(constraints);return reject?Promise.reject(new Error('unsupported')):Promise.resolve();}} as unknown as MediaStreamTrack;
    assert.equal(await focusAt(track,{x,y}),!reject);
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].advanced?.[0],{pointsOfInterest:[{x,y}],focusMode:'continuous',exposureMode:'continuous'});
  }));
});
Deno.test('unsupported focus does not call applyConstraints',async()=>{
  let called=false;
  const track={getCapabilities:()=>({}),applyConstraints:()=>{called=true;return Promise.resolve();}} as unknown as MediaStreamTrack;
  assert.equal(await focusAt(track,{x:0.5,y:0.5}),false);assert.equal(called,false);
});
Deno.test('camera capability errors do not interrupt scanning',async()=>{
  const track={getCapabilities:()=>{throw new Error('capabilities unavailable');}} as unknown as MediaStreamTrack;
  assert.equal(await focusAt(track,{x:0.5,y:0.5}),false);
});
