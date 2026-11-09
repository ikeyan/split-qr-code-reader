/** HEIC files may be supplied without an image MIME type. */
export function isImageFile(file:File):boolean{return file.type.startsWith('image/')||/\.(?:heic|heif)$/i.test(file.name);}
/** Extract local image files without accessing their contents over the network. */
export function clipboardImages(data:DataTransfer|null):File[]{
  if(!data)return [];
  const items=Array.from(data.items??[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>file!==null&&isImageFile(file));
  return items.length?items:Array.from(data.files??[]).filter(isImageFile);
}
export async function readClipboardImages(clipboard:Clipboard):Promise<Blob[]>{
  if(typeof clipboard.read!=='function')return [];
  const result:Blob[]=[];
  for(const item of await clipboard.read()){
    const type=item.types.find(type=>type.startsWith('image/'));
    if(type)result.push(await item.getType(type));
  }
  return result;
}
