import type {Point} from './geometry.ts';
export function videoFrame(box:{width:number;height:number},image:{width:number;height:number},fit:'contain'|'cover'='contain') {
  if(box.width<=0||box.height<=0||image.width<=0||image.height<=0)return null;
  const scale=(fit==='cover'?Math.max:Math.min)(box.width/image.width,box.height/image.height);
  const width=image.width*scale,height=image.height*scale;
  return {x:(box.width-width)/2,y:(box.height-height)/2,width,height,scale};
}
export function videoPoint(point:Point,box:{width:number;height:number},image:{width:number;height:number},fit:'contain'|'cover'='contain'):Point|null {
  const frame=videoFrame(box,image,fit);if(!frame)return null;
  const x=(point.x-frame.x)/frame.width,y=(point.y-frame.y)/frame.height;
  const tolerance=1e-12;
  return x>=-tolerance&&x<=1+tolerance&&y>=-tolerance&&y<=1+tolerance?{x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))}:null;
}
export type CameraSupported=MediaTrackSupportedConstraints & {focusMode?:boolean;exposureMode?:boolean;pointsOfInterest?:boolean;torch?:boolean};
export type CameraCapabilities=MediaTrackCapabilities & {focusMode?:string[];exposureMode?:string[];pointsOfInterest?:boolean;torch?:boolean[]};
type ImageConstraints=MediaTrackConstraintSet & {focusMode?:string;exposureMode?:string;pointsOfInterest?:Point[];torch?:boolean};
export function initialVideoConstraints(supported:CameraSupported):MediaTrackConstraints {
  const requested={facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}} as MediaTrackConstraints & {focusMode?:{ideal:string};exposureMode?:{ideal:string}};
  if(supported.focusMode)requested.focusMode={ideal:'continuous'};
  if(supported.exposureMode)requested.exposureMode={ideal:'continuous'};
  return requested;
}
export function cameraCapabilities(track:MediaStreamTrack):CameraCapabilities {
  try{return typeof track.getCapabilities==='function'?track.getCapabilities() as CameraCapabilities:{};}catch{return {};}
}
/** Update only specified camera controls while retaining other track constraints, including torch. */
async function applyCamera(track:MediaStreamTrack,updates:ImageConstraints[],keys:string[]):Promise<void>{
  const current=typeof track.getConstraints==='function'?track.getConstraints():{};
  const prior=(current.advanced??[]).map(entry=>Object.fromEntries(Object.entries(entry).filter(([key])=>!keys.includes(key))) as MediaTrackConstraintSet).filter(entry=>Object.keys(entry).length);
  await track.applyConstraints({...current,advanced:[...prior,...updates]});
}
/** Some devices expose controls on the track but omit them from supportedConstraints. */
export async function continuousCamera(track:MediaStreamTrack):Promise<boolean>{
  const caps=cameraCapabilities(track),updates:ImageConstraints[]=[];
  if(caps.focusMode?.includes('continuous'))updates.push({focusMode:'continuous'});
  if(caps.exposureMode?.includes('continuous'))updates.push({exposureMode:'continuous'});
  if(!updates.length)return false;
  try{await applyCamera(track,updates,['focusMode','exposureMode']);return true;}catch{return false;}
}
export async function focusAt(track:MediaStreamTrack,point:Point,supported:CameraSupported={}):Promise<boolean>{
  const caps=cameraCapabilities(track);
  const updates:ImageConstraints[]=[];
  const supportsPoint=caps.pointsOfInterest===true||(caps.pointsOfInterest===undefined&&supported.pointsOfInterest===true);
  if(supportsPoint)updates.push({pointsOfInterest:[point]});
  if(caps.focusMode?.includes('single-shot'))updates.push({focusMode:'single-shot'});
  else if(caps.focusMode?.includes('continuous'))updates.push({focusMode:'continuous'});
  else if(!caps.focusMode&&supported.focusMode)updates.push({focusMode:'single-shot'},{focusMode:'continuous'});
  if(caps.exposureMode?.includes('continuous'))updates.push({exposureMode:'continuous'});
  else if(caps.exposureMode?.includes('single-shot'))updates.push({exposureMode:'single-shot'});
  else if(!caps.exposureMode&&supported.exposureMode)updates.push({exposureMode:'continuous'});
  if(!updates.length)return false;
  try{await applyCamera(track,updates,['pointsOfInterest','focusMode','exposureMode']);return true;}
  catch{return false;}
}
export async function setTorch(track:MediaStreamTrack,on:boolean):Promise<void>{
  await applyCamera(track,[{torch:on}],['torch']);
}
