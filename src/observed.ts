import type {ReadResult} from 'zxing-wasm/reader';
export type Observation={key:string;text:string;part:string;url:string|null};
export function httpLink(text:string):string|null {
  const candidate=text.trim();
  try{const url=new URL(candidate);return url.protocol==='https:'||url.protocol==='http:'?url.href:null;}catch{return null;}
}
export function observation(code:ReadResult):Observation {
  const text=code.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'�');
  const part=code.sequenceSize>1?`${code.sequenceIndex+1}/${code.sequenceSize}`:'';
  return {key:JSON.stringify([code.sequenceSize,code.sequenceIndex,code.sequenceId,text,Array.from(code.bytes)]),text,part,url:httpLink(text)};
}
/** Hold recent detections briefly so a momentary lost frame doesn't interrupt link interaction. */
export class Observations {
  private entries=new Map<string,{item:Observation;seen:number}>();
  constructor(private readonly lifetime=1600){}
  update(codes:ReadResult[],now:number):Observation[]{
    for(const code of codes){const item=observation(code);this.entries.set(item.key,{item,seen:now});}
    for(const [key,value] of this.entries)if(now-value.seen>this.lifetime)this.entries.delete(key);
    return [...this.entries.values()].map(entry=>entry.item);
  }
  clear(){this.entries.clear();}
}
