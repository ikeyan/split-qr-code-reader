import type {Raster} from './image-enhance.ts';
/** Local thresholds computed with summed-area tables. */
export function correctIllumination(image:Raster,method:'sauvola'|'mean'='sauvola'):Raster {
  const {width,height,data}=image,stride=width+1;
  const sum=new Float64Array((width+1)*(height+1)),squared=method==='sauvola'?new Float64Array(sum.length):null,gray=new Uint8Array(width*height);
  for(let y=0;y<height;y++){
    let row=0,rowSquared=0;
    for(let x=0;x<width;x++){
      const index=y*width+x,j=index*4,alpha=data[j+3]/255;
      const value=Math.round((data[j]*0.299+data[j+1]*0.587+data[j+2]*0.114)*alpha+255*(1-alpha));
      gray[index]=value;row+=value;if(squared)rowSquared+=value*value;
      const cell=(y+1)*stride+x+1;
      sum[cell]=sum[cell-stride]+row;if(squared)squared[cell]=squared[cell-stride]+rowSquared;
    }
  }
  const radius=Math.max(8,Math.min(40,Math.round(Math.min(width,height)/10))),out=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const left=Math.max(0,x-radius),right=Math.min(width,x+radius+1),top=Math.max(0,y-radius),bottom=Math.min(height,y+radius+1);
    const a=top*stride+left,b=top*stride+right,c=bottom*stride+left,d=bottom*stride+right,count=(right-left)*(bottom-top);
    const mean=(sum[d]-sum[b]-sum[c]+sum[a])/count;
    const variance=squared?Math.max(0,(squared[d]-squared[b]-squared[c]+squared[a])/count-mean*mean):0;
    const threshold=method==='mean'?mean-15:mean*(1+0.1*(Math.sqrt(variance)/128-1));
    const index=y*width+x,j=index*4,value=gray[index]<threshold?0:255;
    out[j]=out[j+1]=out[j+2]=value;out[j+3]=255;
  }
  return {width,height,data:out};
}
/** Bound the extra memory needed by summed-area tables. */
export function limitRaster(image:Raster,maxDimension=1280):Raster {
  const scale=Math.min(1,maxDimension/Math.max(image.width,image.height));
  if(scale===1)return image;
  const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale));
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=Math.min(image.width-1,Math.floor((x+0.5)*image.width/width)),sy=Math.min(image.height-1,Math.floor((y+0.5)*image.height/height));
    const source=(sy*image.width+sx)*4,target=(y*width+x)*4;
    data[target]=image.data[source];data[target+1]=image.data[source+1];data[target+2]=image.data[source+2];data[target+3]=image.data[source+3];
  }
  return {width,height,data};
}
