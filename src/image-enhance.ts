export type Raster = {width:number;height:number;data:Uint8ClampedArray};

/** A small unsharp mask makes slightly blurred module edges easier to binarize. */
export function sharpen(image:Raster, radius=2, strength=1.8):Raster {
  const {width,height,data}=image;
  const size=width*height;
  const gray=new Uint8Array(size), horizontal=new Float32Array(size);
  const result=new Uint8ClampedArray(size*4);
  for(let i=0;i<size;i++){
    const j=i*4,alpha=data[j+3]/255;
    gray[i]=Math.round((data[j]*0.299+data[j+1]*0.587+data[j+2]*0.114)*alpha+255*(1-alpha));
  }
  const window=radius*2+1;
  for(let y=0;y<height;y++){
    const row=y*width;let sum=0;
    for(let dx=-radius;dx<=radius;dx++)sum+=gray[row+Math.max(0,Math.min(width-1,dx))];
    for(let x=0;x<width;x++){
      horizontal[row+x]=sum/window;
      sum+=gray[row+Math.min(width-1,x+radius+1)]-gray[row+Math.max(0,x-radius)];
    }
  }
  for(let x=0;x<width;x++){
    let sum=0;
    for(let dy=-radius;dy<=radius;dy++)sum+=horizontal[Math.max(0,Math.min(height-1,dy))*width+x];
    for(let y=0;y<height;y++){
      const i=y*width+x,j=i*4;
      const value=Math.round(gray[i]+strength*(gray[i]-sum/window));
      result[j]=result[j+1]=result[j+2]=value;result[j+3]=255;
      sum+=horizontal[Math.min(height-1,y+radius+1)*width+x]-horizontal[Math.max(0,y-radius)*width+x];
    }
  }
  return {width,height,data:result};
}
/** Bilinear resampling keeps small camera modules usable for local thresholds. */
export function resizeRaster(image:Raster,width:number,height:number):Raster {
  if(width===image.width&&height===image.height)return image;
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=Math.max(0,Math.min(image.width-1,(x+.5)*image.width/width-.5)),sy=Math.max(0,Math.min(image.height-1,(y+.5)*image.height/height-.5));
    const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;
    const a=(iy*image.width+ix)*4,b=(iy*image.width+Math.min(ix+1,image.width-1))*4,c=(Math.min(iy+1,image.height-1)*image.width+ix)*4,d=(Math.min(iy+1,image.height-1)*image.width+Math.min(ix+1,image.width-1))*4;
    for(let k=0;k<4;k++)data[(y*width+x)*4+k]=image.data[a+k]*(1-fx)*(1-fy)+image.data[b+k]*fx*(1-fy)+image.data[c+k]*(1-fx)*fy+image.data[d+k]*fx*fy;
  }
  return {width,height,data};
}
