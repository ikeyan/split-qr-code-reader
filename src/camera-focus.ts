import type {Point} from './geometry.ts';
/** Convert an overlay coordinate to the normalized video image, excluding letterboxing. */
export function videoPoint(point:Point,box:{width:number;height:number},image:{width:number;height:number}):Point|null {
  if(box.width<=0||box.height<=0||image.width<=0||image.height<=0)return null;
  const scale=Math.min(box.width/image.width,box.height/image.height);
  const width=image.width*scale,height=image.height*scale;
  const x=(point.x-(box.width-width)/2)/width,y=(point.y-(box.height-height)/2)/height;
  return x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;
}
type CameraCapabilities=MediaTrackCapabilities & {focusMode?:string[];exposureMode?:string[];pointsOfInterest?:boolean};
type ImageConstraints=MediaTrackConstraintSet & {focusMode?:string;exposureMode?:string;pointsOfInterest?:Point[]};
/** Request a tap position when supported, and otherwise retain automatic modes if available. */
export async function focusAt(track:MediaStreamTrack,point:Point):Promise<boolean>{
  if(typeof track.getCapabilities!=='function')return false;
  let caps:CameraCapabilities;
  try{caps=track.getCapabilities() as CameraCapabilities;}catch{return false;}
  const constraint:ImageConstraints={};
  if(caps.pointsOfInterest)constraint.pointsOfInterest=[point];
  if(caps.focusMode?.includes('continuous'))constraint.focusMode='continuous';
  else if(caps.focusMode?.includes('single-shot'))constraint.focusMode='single-shot';
  if(caps.exposureMode?.includes('continuous'))constraint.exposureMode='continuous';
  else if(caps.exposureMode?.includes('single-shot'))constraint.exposureMode='single-shot';
  if(!Object.keys(constraint).length)return false;
  try{await track.applyConstraints({advanced:[constraint]});return !!constraint.pointsOfInterest;}
  catch{return false;}
}
