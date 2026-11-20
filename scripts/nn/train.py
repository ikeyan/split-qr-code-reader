"""Train both QR geometry networks from procedural data. No photographs are read.
Run with Python 3, numpy and torch (see requirements.txt). CPU training supported.
"""
import argparse, json, math
from pathlib import Path
import numpy as np
import torch
from torch import nn

torch.set_num_threads(4)


def surface_data(count, seed):
    rng = np.random.default_rng(seed)
    inputs, targets = [], []
    while len(inputs) < count:
        n = min(4096, count - len(inputs))
        size = rng.choice(np.arange(21, 178, 4), n)
        angle = rng.uniform(-1.25, 1.25, n)
        angle[np.abs(angle) < .02] = .02
        offset = rng.uniform(-.18, .18, n)
        yaw, pitch = rng.uniform(-.85, .85, (2, n))
        distance = rng.uniform(3.5, 6.5, n)
        vertical = rng.random(n) < .5
        def project(x, y):
            u, v = (x / size[:, None] * 2 - 1), (y / size[:, None] * 2 - 1)
            t = np.where(vertical[:, None], v, u)
            cross = np.where(vertical[:, None], u, v)
            bend = (np.sin(angle[:, None] * (t + offset[:, None])) - np.sin(angle * offset)[:, None]) / angle[:, None]
            z = (np.cos(angle * offset)[:, None] - np.cos(angle[:, None] * (t + offset[:, None]))) / angle[:, None]
            x = np.where(vertical[:, None], cross, bend)
            y = np.where(vertical[:, None], bend, cross)
            xx = np.cos(yaw)[:, None] * x + np.sin(yaw)[:, None] * z
            zz = -np.sin(yaw)[:, None] * x + np.cos(yaw)[:, None] * z
            yy = np.cos(pitch)[:, None] * y - np.sin(pitch)[:, None] * zz
            depth = distance[:, None] + np.sin(pitch)[:, None] * y + np.cos(pitch)[:, None] * zz
            return np.stack([xx / depth, yy / depth], -1)
        centers_x = np.stack([np.full(n, 3.5), size-3.5, np.full(n,3.5)],1)
        centers_y = np.stack([np.full(n, 3.5), np.full(n,3.5), size-3.5],1)
        centers = project(centers_x, centers_y)
        dx = (project(centers_x+.05, centers_y)-project(centers_x-.05, centers_y))/.1
        dy = (project(centers_x, centers_y+.05)-project(centers_x, centers_y-.05))/.1
        matrix = np.stack([centers[:,1]-centers[:,0],centers[:,2]-centers[:,0]],-1)
        inv = np.linalg.inv(matrix)
        tangents = np.stack([dx,dy],-1)
        features = np.einsum('nij,nkjl->nkil', inv, tangents)*(size-7)[:,None,None,None]
        axis = np.linspace(0,1,9)
        gx, gy = np.meshgrid(axis,axis)
        points = project(size[:,None]*gx.ravel(),size[:,None]*gy.ravel())
        coords = np.einsum('nij,nkj->nki',inv,points-centers[:,0,None,:])
        # Exclude folded or nearly invisible patches. Those are not invertible.
        grid = coords.reshape(n,9,9,2)
        du, dv = np.diff(grid,axis=2)[:,:-1],np.diff(grid,axis=1)[:,:,:-1]
        det = du[:,:,:,0]*dv[:,:,:,1]-du[:,:,:,1]*dv[:,:,:,0]
        good = (det.min((1,2)) > .0007) & (np.abs(coords).max((1,2)) < 2.5)
        f = np.concatenate([features.reshape(n,12), (7/size)[:,None]],1)
        # Identity grid residuals keep the target well scaled for learning.
        base = np.stack([gx.ravel(),gy.ravel()],-1)
        inputs.extend(f[good]); targets.extend((coords-base)[good].reshape(-1,162))
    return np.array(inputs[:count],np.float32),np.array(targets[:count],np.float32)


def marker_data(count, seed):
    rng = np.random.default_rng(seed)
    axis = (np.arange(32)+.5)/32*11-5.5
    x,y=np.meshgrid(axis,axis)
    coords=np.stack([x.ravel(),y.ravel()],0)[None]
    inputs,targets=[],[]
    for start in range(0,count,2048):
        n=min(2048,count-start)
        a=np.zeros((n,2,2));a[:,0,0]=rng.uniform(.28,1.6,n);a[:,1,1]=rng.uniform(.28,1.6,n)
        a[:,0,1]=rng.uniform(-.5,.5,n);a[:,1,0]=rng.uniform(-.5,.5,n)
        bad=np.linalg.det(a)<.12
        a[bad,0,1]=0;a[bad,1,0]=0
        shift=rng.uniform(-.85,.85,(n,2))
        uv=np.einsum('nij,njk->nik',np.linalg.inv(a),coords-shift[:,:,None])
        ix,iy=np.floor(uv[:,0]+3.5).astype(int),np.floor(uv[:,1]+3.5).astype(int)
        positive=rng.random(n)<.72
        modules=rng.integers(0,2,(n,19,19)).astype(np.float32)
        # White separator, then a standard public finder. Negatives include
        # alignment rings, stripes and unmodified random module patterns.
        for i in range(n):
            if positive[i]:
                modules[i,5:14,5:14]=0
                for yy in range(7):
                    for xx in range(7):
                        d=max(abs(xx-3),abs(yy-3))
                        modules[i,6+yy,6+xx]=d==3 or d<=1
            elif i%3==0:
                modules[i,7:12,7:12]=np.array([[1,1,1,1,1],[1,0,0,0,1],[1,0,1,0,1],[1,0,0,0,1],[1,1,1,1,1]])
        dark=np.zeros((n,1024),np.float32)
        for dx,dy in [(-.12,-.12),(-.12,.12),(.12,-.12),(.12,.12)]:
            ix=np.floor(uv[:,0]+3.5+dx).astype(int);iy=np.floor(uv[:,1]+3.5+dy).astype(int)
            dark+=modules[np.arange(n)[:,None],np.clip(iy+6,0,18),np.clip(ix+6,0,18)]/4
        pixel=1-dark
        pixel=pixel*rng.uniform(.35,1,(n,1))+rng.uniform(-.15,.15,(n,1))
        pixel+=rng.uniform(-.09,.09,(n,1))*x.ravel()+rng.uniform(-.09,.09,(n,1))*y.ravel()
        pixel+=rng.normal(0,.08,pixel.shape)
        pixel=(pixel-pixel.mean(1,keepdims=True))/(pixel.std(1,keepdims=True)+.1)
        target=np.concatenate([shift,a.reshape(n,4),positive[:,None]],1).astype(np.float32)
        inputs.append(pixel.astype(np.float32));targets.append(target)
    return np.concatenate(inputs),np.concatenate(targets)


def train(name, maker, sizes, steps, out):
    torch.manual_seed(172938)
    x,y=maker(65536,182739 if name=='surface' else 431827)
    vx,vy=maker(4096,765491 if name=='surface' else 916753)
    tx,ty=torch.from_numpy(x),torch.from_numpy(y)
    model=nn.Sequential(nn.Linear(sizes[0],sizes[1]),nn.ReLU(),nn.Linear(sizes[1],sizes[2]),nn.ReLU(),nn.Linear(sizes[2],sizes[3]))
    optimizer=torch.optim.Adam(model.parameters(),lr=.001)
    rng=np.random.default_rng(81273)
    for step in range(steps):
        idx=rng.integers(0,len(x),1024)
        pred=model(tx[idx])
        if name=='marker':
            good=ty[idx,6]>.5
            loss=nn.functional.binary_cross_entropy_with_logits(pred[:,6],ty[idx,6])+4*nn.functional.mse_loss(pred[good,:6],ty[idx][good,:6])
        else:
            loss=nn.functional.mse_loss(pred,ty[idx])
        if name=='marker' and step>steps*.75:
            for group in optimizer.param_groups:group["lr"]=.0002
        optimizer.zero_grad();loss.backward();optimizer.step()
        if (step+1)%500==0:
            with torch.no_grad():
                p=model(torch.from_numpy(vx))
                error=((p[:,:6]-torch.from_numpy(vy[:,:6]))**2)[torch.from_numpy(vy[:,6]>.5)].mean().sqrt().item() if name=='marker' else ((p-torch.from_numpy(vy))**2).mean().sqrt().item()
                print(name,step+1,'loss',round(loss.item(),7),'validation rmse',round(error,6),flush=True)
    layers=[]
    for layer in model:
        if isinstance(layer,nn.Linear):
            layers.append({'input':layer.in_features,'output':layer.out_features,'weights':layer.weight.detach().numpy().ravel().tolist(),'bias':layer.bias.detach().numpy().tolist()})
    out.mkdir(parents=True,exist_ok=True)
    (out/(name+'.json')).write_text(json.dumps({'layers':layers},separators=(',',':')))
    with torch.no_grad():
        p=model(torch.from_numpy(vx)).numpy()
    (out/(name+'-validation.json')).write_text(json.dumps({'input':vx[:4].tolist(),'output':p[:4].tolist(),'rmse':float(np.sqrt(np.mean((p-vy)**2))) if name=='surface' else float(np.mean((p[:,6]>0)==(vy[:,6]>.5)))}))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=Path('/tmp/qr-nn-trained'))
    parser.add_argument('--surface-steps',type=int,default=6000)
    parser.add_argument('--marker-steps',type=int,default=8000)
    parser.add_argument('--deploy',type=Path)
    args=parser.parse_args()
    train('surface',surface_data,[13,128,128,162],args.surface_steps,args.output)
    train('marker',marker_data,[1024,128,64,7],args.marker_steps,args.output)
    if args.deploy:
        import base64
        result={'format':'f32le-base64'}
        for name in ['marker','surface']:
            model=json.loads((args.output/(name+'.json')).read_text())
            for layer in model['layers']:
                for key in ['weights','bias']:
                    layer[key]=base64.b64encode(np.array(layer[key],dtype='<f4').tobytes()).decode()
            result[name]=model
        args.deploy.write_text(json.dumps(result,separators=(',',':')))
