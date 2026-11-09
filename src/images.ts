/** Recognize HEIF containers even when the source supplies no MIME type. */
export async function isHeif(blob:Blob):Promise<boolean>{
  const data=new Uint8Array(await blob.slice(0,128).arrayBuffer());
  if(data.length<12||String.fromCharCode(...data.slice(4,8))!=='ftyp')return false;
  const declared=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0);
  const limit=declared===0?data.length:Math.min(data.length,declared);
  const tags:string[]=[];
  for(let i=8;i+4<=limit;i+=4){if(i===12)continue;tags.push(String.fromCharCode(...data.slice(i,i+4)));}
  if(tags.some(tag=>tag==='avif'||tag==='avis'))return false;
  return tags.some(tag=>['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1'].includes(tag));
}
type Converter=(options:{blob:Blob;type:'image/png'})=>Promise<Blob>;
declare global {interface Window {HeicTo?:Converter;}}
export async function prepareImage(blob:Blob,convert:Converter|undefined=window.HeicTo):Promise<Blob|null>{
  const heif=await isHeif(blob);
  if(heif){if(!convert)throw new Error('HEIC converter unavailable');return await convert({blob,type:'image/png'});}
  if(blob.type.startsWith('image/'))return blob;
  return null;
}
