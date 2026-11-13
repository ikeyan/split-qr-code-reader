import fc from 'fast-check';
import {strict as assert} from 'node:assert';
import {focusAt,videoFrame,videoPoint,initialVideoConstraints,continuousCamera,setTorch} from '../src/camera-focus.ts';
 Deno.test('cover maps visible coordinates to the same source pixels as the overlay',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.double({min:0,max:1,noNaN:true}),fc.double({min:0,max:1,noNaN:true}),(bw,bh,iw,ih,x,y)=>{
    const box={width:bw,height:bh},image={width:iw,height:ih};
    const frame=videoFrame(box,image,'cover')!;
    assert.ok(frame.width>=bw-1e-9&&frame.height>=bh-1e-9);
    const screen={x:x*bw,y:y*bh};
    const point=videoPoint(screen,box,image,'cover')!;
    assert.ok(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1);
    assert.ok(Math.abs(frame.x+point.x*frame.width-screen.x)<1e-8);
    assert.ok(Math.abs(frame.y+point.y*frame.height-screen.y)<1e-8);
  }));
});
Deno.test('video coordinates account for letterboxing',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.integer({min:1,max:4000}),fc.double({min:0.01,max:0.99,noNaN:true}),fc.double({min:0.01,max:0.99,noNaN:true}),(bw,bh,iw,ih,x,y)=>{
    const scale=Math.min(bw/iw,bh/ih),w=iw*scale,h=ih*scale;
    const point=videoPoint({x:(bw-w)/2+x*w,y:(bh-h)/2+y*h},{width:bw,height:bh},{width:iw,height:ih});
    assert.ok(point);
    const pixelTolerance=Number.EPSILON*Math.max(bw,bh)*8;
    assert.ok(Math.abs(point.x-x)*w<=pixelTolerance);assert.ok(Math.abs(point.y-y)*h<=pixelTolerance);
  }));
});
Deno.test('camera focus uses supported capabilities and tolerates rejection',async()=>{
  await fc.assert(fc.asyncProperty(fc.double({min:0,max:1,noNaN:true}),fc.double({min:0,max:1,noNaN:true}),fc.boolean(),async(x,y,reject)=>{
    const calls:MediaTrackConstraints[]=[];
    const track={getCapabilities:()=>({pointsOfInterest:true,focusMode:['continuous'],exposureMode:['continuous']}),applyConstraints:(constraints:MediaTrackConstraints)=>{calls.push(constraints);return reject?Promise.reject(new Error('unsupported')):Promise.resolve();}} as unknown as MediaStreamTrack;
    assert.equal(await focusAt(track,{x,y}),!reject);
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].advanced,[{pointsOfInterest:[{x,y}]},{focusMode:'continuous'},{exposureMode:'continuous'}]);
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

Deno.test('supported constraints are requested at start and provide fallback when capabilities are missing',async()=>{
  const supported={focusMode:true,exposureMode:true,pointsOfInterest:true};
  assert.deepEqual(initialVideoConstraints(supported),{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},focusMode:{ideal:'continuous'},exposureMode:{ideal:'continuous'}});
  const calls:MediaTrackConstraints[]=[];
  const track={getCapabilities:()=>({}),getConstraints:()=>({advanced:[{torch:true}]}),applyConstraints:(value:MediaTrackConstraints)=>{calls.push(value);return Promise.resolve();}} as unknown as MediaStreamTrack;
  assert.equal(await focusAt(track,{x:0.25,y:0.75},supported),true);
  assert.deepEqual(calls[0].advanced,[{torch:true},{pointsOfInterest:[{x:0.25,y:0.75}]},{focusMode:'single-shot'},{focusMode:'continuous'},{exposureMode:'continuous'}]);
});
Deno.test('torch update preserves focus and replaces the previous torch value',async()=>{
  const calls:MediaTrackConstraints[]=[];
  const track={getConstraints:()=>({advanced:[{torch:true,focusMode:'continuous'}]}),applyConstraints:(value:MediaTrackConstraints)=>{calls.push(value);return Promise.resolve();}} as unknown as MediaStreamTrack;
  await setTorch(track,false);
  assert.deepEqual(calls[0].advanced,[{focusMode:'continuous'},{torch:false}]);
});
Deno.test('letterboxing remains accurate with a subpixel-wide image',()=>{
  const box={width:1025,height:1},image={width:1,height:2135},expected={x:0.013685357558257387,y:0.01};
  const scale=Math.min(box.width/image.width,box.height/image.height),width=image.width*scale,height=image.height*scale;
  const point=videoPoint({x:(box.width-width)/2+expected.x*width,y:(box.height-height)/2+expected.y*height},box,image);
  assert.ok(point);
  const pixelTolerance=Number.EPSILON*Math.max(box.width,box.height)*8;
  assert.ok(Math.abs(point.x-expected.x)*width<=pixelTolerance);
  assert.ok(Math.abs(point.y-expected.y)*height<=pixelTolerance);
});
 Deno.test('continuous camera controls use track capabilities and retain existing constraints',async()=>{
  const applied:MediaTrackConstraints[]=[];
  const track={getCapabilities:()=>({focusMode:['continuous'],exposureMode:['continuous']}),getConstraints:()=>({width:{ideal:1920},advanced:[{torch:true}]}),applyConstraints:(value:MediaTrackConstraints)=>{applied.push(value);return Promise.resolve();}} as unknown as MediaStreamTrack;
  assert.equal(await continuousCamera(track),true);
  assert.deepEqual(applied,[{width:{ideal:1920},advanced:[{torch:true},{focusMode:'continuous'},{exposureMode:'continuous'}]}]);
 });
 Deno.test('unsupported or rejected continuous focus keeps the camera usable',async()=>{
  let calls=0;
  const unsupported={getCapabilities:()=>({}),applyConstraints:()=>{calls++;return Promise.resolve();}} as unknown as MediaStreamTrack;
  assert.equal(await continuousCamera(unsupported),false);assert.equal(calls,0);
  const rejected={getCapabilities:()=>({focusMode:['continuous']}),applyConstraints:()=>Promise.reject(new Error('unsupported'))} as unknown as MediaStreamTrack;
  assert.equal(await continuousCamera(rejected),false);
 });
