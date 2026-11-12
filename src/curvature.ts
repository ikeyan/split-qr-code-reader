import type {Raster} from './image-enhance.ts';
import type {ReadResult} from 'zxing-wasm/reader';
export type CurveAxis='horizontal'|'vertical';
export type Curve={axis:CurveAxis;strength:number;angle?:number};
export const curveVariants:Curve[]=(['horizontal','vertical'] as const).flatMap(axis=>[0.3,-0.3,0.45,-0.45].map(strength=>({axis,strength})));
/** Map a flattened normalized position to its position in the camera image. */
function curveMapper(curve:Curve):(x:number,y:number)=>{x:number;y:number}{
  const horizontal=curve.axis==='horizontal',cos=Math.cos(curve.angle??0),sin=Math.sin(curve.angle??0);
  return (x,y)=>{
    const u=x*2-1,v=y*2-1;
    const across=cos*u+sin*v,down=-sin*u+cos*v;
    const t=horizontal?across:down,cross=horizontal?down:across;
    const corrected=t+curve.strength*(t*t*t-t);
    const other=cross*(1-curve.strength*0.25*(1-t*t));
    const a=horizontal?corrected:other,b=horizontal?other:corrected;
    return {x:(cos*a-sin*b+1)/2,y:(sin*a+cos*b+1)/2};
  };
}
export function curvedPoint(x:number,y:number,curve:Curve):{x:number;y:number}{return curveMapper(curve)(x,y);}
export function flattenCurve(image:Raster,curve:Curve,maxDimension=1280):Raster {
  const scale=Math.min(1,maxDimension/Math.max(image.width,image.height));
  const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale));
  const data=new Uint8ClampedArray(width*height*4),map=curveMapper(curve);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const p=map((x+0.5)/width,(y+0.5)/height);
    const sx=Math.floor(p.x*image.width),sy=Math.floor(p.y*image.height),dst=(y*width+x)*4;
    if(sx<0||sy<0||sx>=image.width||sy>=image.height){data[dst]=data[dst+1]=data[dst+2]=data[dst+3]=255;continue;}
    const src=(sy*image.width+sx)*4;
    data[dst]=image.data[src];data[dst+1]=image.data[src+1];data[dst+2]=image.data[src+2];data[dst+3]=image.data[src+3];
  }
  return {width,height,data};
}
export function mapCurvePositions(codes:ReadResult[],curve:Curve,flattened:Raster,original:Raster):ReadResult[]{
  const map=curveMapper(curve);
  return codes.map(code=>{
    const point=(p:{x:number;y:number})=>{const mapped=map(p.x/flattened.width,p.y/flattened.height);return {x:mapped.x*original.width,y:mapped.y*original.height};};
    const p=code.position;
    return {...code,position:{topLeft:point(p.topLeft),topRight:point(p.topRight),bottomRight:point(p.bottomRight),bottomLeft:point(p.bottomLeft)}};
  });
}

export type Region={x:number;y:number;width:number;height:number;angle?:number};
export function candidateRegions(image:Raster,codes:ReadResult[]):Region[]{
  const result:Region[]=[];
  for(const code of codes){
    const p=Object.values(code.position),xs=p.map(point=>point.x),ys=p.map(point=>point.y);
    if(!xs.every(Number.isFinite)||!ys.every(Number.isFinite))continue;
    const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
    const size=Math.max(right-left,bottom-top);
    if(size<8)continue;
    const pad=Math.max(8,size*0.25);
    const x=Math.max(0,Math.floor(left-pad)),y=Math.max(0,Math.floor(top-pad));
    const x2=Math.min(image.width,Math.ceil(right+pad)),y2=Math.min(image.height,Math.ceil(bottom+pad));
    if(x2<=x||y2<=y)continue;
    const width=x2-x,height=y2-y;
    const angle=Math.atan2((code.position.topRight.y-code.position.topLeft.y)/height,(code.position.topRight.x-code.position.topLeft.x)/width);
    const region={x,y,width,height,angle};
    if(!result.some(old=>Math.abs((old.x+old.width/2)-(x+region.width/2))<size*.35&&Math.abs((old.y+old.height/2)-(y+region.height/2))<size*.35))result.push(region);
  }
  return result;
}
export function cropRaster(image:Raster,region:Region):Raster {
  const data=new Uint8ClampedArray(region.width*region.height*4);
  for(let y=0;y<region.height;y++){
    const start=((region.y+y)*image.width+region.x)*4;
    data.set(image.data.subarray(start,start+region.width*4),y*region.width*4);
  }
  return {width:region.width,height:region.height,data};
}
