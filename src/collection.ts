/** A QR is stored once for each distinct payload at a position. */
export type InputPart = { index:number; total:number; parity:number; bytes:Uint8Array; text?:string };
export type Part = InputPart & {id:number};
export type Group = { total:number; parity:number; slots:Part[][] };
export type Suite = {id:string; parts:Part[]; text:string | null};
export type Collection = {groups:Group[]; suites:Suite[]; nextId:number};
export const emptyCollection = (): Collection => ({groups:[],suites:[],nextId:1});
export const xorBytes = (bytes:Uint8Array) => bytes.reduce((sum, byte) => sum ^ byte,0);
const sameBytes = (a:Uint8Array,b:Uint8Array) => a.length===b.length && a.every((byte,i)=>byte===b[i]);
export function hasPart(collection:Collection, part:InputPart):boolean {
  const group = collection.groups.find(g=>g.total===part.total && g.parity===part.parity);
  return !!group?.slots[part.index]?.some(p=>sameBytes(p.bytes,part.bytes) && (part.total!==1 || p.text===part.text));
}
function decodeText(parts:Part[]):string | null {
  if (parts.length===1 && parts[0].text!==undefined) return parts[0].text;
  const bytes = new Uint8Array(parts.reduce((n,part)=>n+part.bytes.length,0));
  let offset=0;
  for(const part of parts){bytes.set(part.bytes,offset);offset+=part.bytes.length;}
  try {return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch {try {return new TextDecoder('shift_jis',{fatal:true}).decode(bytes);} catch {return null;}}
}
export function addPart(collection:Collection, input:InputPart):{collection:Collection; added:Suite[]; outcome:'accepted'|'duplicate'|'invalid'} {
  const {total,index,parity}=input;
  if(!Number.isInteger(total)||total<1||total>16||!Number.isInteger(index)||index<0||index>=total||!Number.isInteger(parity)||parity<0||parity>255) return {collection,added:[],outcome:'invalid'};
  if(hasPart(collection,input)) return {collection,added:[],outcome:'duplicate'};
  const part:Part={...input,bytes:input.bytes.slice(),id:collection.nextId};
  const existing=collection.groups.find(g=>g.total===total&&g.parity===parity);
  const slots=existing?existing.slots.map(slot=>slot.slice()):Array.from({length:total},()=>[] as Part[]);
  slots[index].push(part);
  const group:Group={total,parity,slots};
  const groups=existing?collection.groups.map(g=>g===existing?group:g):[...collection.groups,group];
  const added:Suite[]=[];
  if(slots.every(slot=>slot.length)) {
    const chosen:Part[]=new Array(total);
    const candidates=slots.map((slot,i)=>i===index?[part]:slot);
    // Prune prefixes that cannot possibly reach the required XOR parity.
    const reachable=Array.from({length:total+1},()=>new Uint8Array(256));
    reachable[total][0]=1;
    for(let position=total-1;position>=0;position--){
      for(const candidate of candidates[position]){
        const value=xorBytes(candidate.bytes);
        for(let suffix=0;suffix<256;suffix++)if(reachable[position+1][suffix])reachable[position][value^suffix]=1;
      }
    }
    const visit=(position:number, checksum:number) => {
      if(!reachable[position][parity^checksum]) return;
      if(position===total){const parts=chosen.slice();added.push({id:parts.map(p=>p.id).join('-'),parts,text:decodeText(parts)});return;}
      for(const candidate of candidates[position]){chosen[position]=candidate;visit(position+1,checksum^xorBytes(candidate.bytes));}
    };
    visit(0,0);
  }
  return {collection:{groups,suites:[...collection.suites,...added],nextId:collection.nextId+1},added,outcome:'accepted'};
}
export function deleteSuite(collection:Collection,id:string):Collection {
  const suite=collection.suites.find(item=>item.id===id);
  if(!suite) return collection;
  const removed=new Set(suite.parts.map(part=>part.id));
  const groups=collection.groups.map(group=>({...group,slots:group.slots.map(slot=>slot.filter(part=>!removed.has(part.id)))})).filter(group=>group.slots.some(slot=>slot.length));
  const suites=collection.suites.filter(item=>!item.parts.some(part=>removed.has(part.id)));
  return {...collection,groups,suites};
}
