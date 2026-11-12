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
