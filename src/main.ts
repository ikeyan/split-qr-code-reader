import {batch,createSignal,onCleanup} from 'solid-js';
import {render} from 'solid-js/web';
import h from 'solid-js/h';
import type {ReadResult} from 'zxing-wasm/reader';
import {decode} from './decoder.ts';
import {addPart,deleteSuite,emptyCollection,hasPart,type Suite} from './collection.ts';
import {asPart} from './reader.ts';
import {contains,type Point} from './geometry.ts';
import {Pointers} from './pointers.ts';
import {enqueuePreviews,dismissPreview,retainPreviews} from './previews.ts';
import {clipboardImages,readClipboardImages} from './clipboard.ts';
import {focusAt,videoFrame,videoPoint,initialVideoConstraints,cameraCapabilities,continuousCamera,setTorch,type CameraSupported} from './camera-focus.ts';
import {prepareImage} from './images.ts';
import {icon} from './icons.ts';
import {Observations,type Observation} from './observed.ts';
import type {ScanMode} from './scan.ts';
import {CameraRecovery} from './camera-recovery.ts';
import {CameraRecording,createCameraRecorder,recordingFilename,type RecordingPhase} from './camera-recording.ts';
import {CameraDecoder} from './camera-decoder.ts';

const revision=document.querySelector<HTMLMetaElement>('meta[name="build-commit"]')?.content??'';
const buildCommit=/^[0-9a-f]{40}$/.test(revision)?revision:'開発版';

function App(){
  const [collection,setCollection]=createSignal(emptyCollection());
  const [message,setMessage]=createSignal('');
  const [active,setActive]=createSignal(false);
  const [detected,setDetected]=createSignal<ReadResult[]>([]);
  const [observed,setObserved]=createSignal<Observation[]>([]);
  const [scanMode,setScanMode]=createSignal<ScanMode>('auto');
  const [viewSize,setViewSize]=createSignal({width:1,height:1});
  const [previews,setPreviews]=createSignal<string[]>([]);
  const [dragging,setDragging]=createSignal(false);
  const [expanded,setExpanded]=createSignal<string|null>(null);
  const [focusPoint,setFocusPoint]=createSignal<Point|null>(null);
  const [torchAvailable,setTorchAvailable]=createSignal(false);
  const [torchOn,setTorchOn]=createSignal(false);
  const [torchBusy,setTorchBusy]=createSignal(false);
  const [recordingPhase,setRecordingPhase]=createSignal<RecordingPhase>('idle');
  const [recordingSeconds,setRecordingSeconds]=createSignal(0);
  const recordingSupported=typeof MediaRecorder!=='undefined';
  let recordingTimer:ReturnType<typeof setInterval>|undefined;
  const recording=new CameraRecording({
    create:createCameraRecorder,
    state:phase=>{
      clearInterval(recordingTimer);setRecordingPhase(phase);
      if(phase==='recording'){
        const started=Date.now();setRecordingSeconds(0);
        recordingTimer=setInterval(()=>setRecordingSeconds(Math.floor((Date.now()-started)/1000)),1000);
      }
    },
    save:blob=>{
      const name=recordingFilename(blob.type,buildCommit==='開発版'?'dev':buildCommit);
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),60000);setMessage('録画を保存しました。');
    },
    error:()=>setMessage('録画できませんでした。ブラウザーの対応状況や空き容量を確認してください。'),
  });
  let video!:HTMLVideoElement,camera!:HTMLDivElement,fullDialog!:HTMLDialogElement;
  let stream:MediaStream|undefined;
  let supported:CameraSupported={};
  let cameraJobs:Promise<void>=Promise.resolve();
  function cameraTask<T>(task:()=>Promise<T>):Promise<T>{const next=cameraJobs.then(task);cameraJobs=next.then(()=>{},()=>{});return next;}
  let generation=0,previewStartX=0,dragDepth=0;
  let focusTimer:ReturnType<typeof setTimeout>|undefined;
  let previewSwiped=false;
  const pointers=new Pointers();
  const observations=new Observations();
  const cameraDecoder=new CameraDecoder();
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d',{willReadFrequently:true})!;

  function stop(){
    generation++;
    recording.stop();
    const current=stream;stream=undefined;
    current?.getTracks().forEach(track=>track.stop());
    pointers.clear();observations.clear();
    batch(()=>{setActive(false);setDetected([]);setObserved([]);setPreviews([]);setFocusPoint(null);setTorchAvailable(false);setTorchOn(false);setTorchBusy(false);});
    video.srcObject=null;
  }
  function add(code:ReadResult,fromCamera=false){
    const update=addPart(collection(),asPart(code));
    if(update.outcome==='invalid'){setMessage('QR コードを読み取れませんでした。');return;}
    if(update.outcome==='duplicate')return;
    batch(()=>{
      setCollection(update.collection);
      if(fromCamera&&update.added.length)setPreviews(current=>enqueuePreviews(current,update.added.map(s=>s.id)));
      setMessage('');
    });
  }
  function geometry(code:ReadResult):Point[]{
    const frame=videoFrame(viewSize(),{width:video.videoWidth,height:video.videoHeight},'cover'),p=code.position;
    if(!frame)return [];
    return [p.topLeft,p.topRight,p.bottomRight,p.bottomLeft].map(p=>({x:frame.x+p.x*frame.scale,y:frame.y+p.y*frame.scale}));
  }
  function takeAtPointers(codes:ReadResult[]){for(const code of pointers.select(codes,geometry))add(code,true);}
  function pointer(event:PointerEvent){const rect=camera.getBoundingClientRect();pointers.update(event.pointerId,{x:event.clientX-rect.left,y:event.clientY-rect.top});takeAtPointers(detected());}
  async function focusPointer(event:PointerEvent){
    const track=stream?.getVideoTracks()[0];
    if(!track)return;
    const rect=camera.getBoundingClientRect();
    const point={x:event.clientX-rect.left,y:event.clientY-rect.top};
    if(detected().some(code=>contains(geometry(code),point)))return;
    const normalized=videoPoint(point,{width:rect.width,height:rect.height},{width:video.videoWidth,height:video.videoHeight},'cover');
    if(normalized&&await cameraTask(()=>focusAt(track,normalized,supported))&&active()&&stream?.getVideoTracks()[0]===track){
      setFocusPoint(point);clearTimeout(focusTimer);focusTimer=setTimeout(()=>setFocusPoint(null),900);
    }
  }
  async function start(){
    if(active())return;
    const current=++generation;
    try{
      supported=typeof navigator.mediaDevices.getSupportedConstraints==='function'?navigator.mediaDevices.getSupportedConstraints() as CameraSupported:{};
      const newStream=await navigator.mediaDevices.getUserMedia({video:initialVideoConstraints(supported),audio:false});
      await continuousCamera(newStream.getVideoTracks()[0]);
      if(current!==generation){newStream.getTracks().forEach(track=>track.stop());return;}
      stream=newStream;video.srcObject=stream;const torch=cameraCapabilities(newStream.getVideoTracks()[0]).torch;setTorchAvailable(Array.isArray(torch)?torch.includes(true):(torch as unknown)===true);setActive(true);setMessage('');
      await video.play();
      if(current!==generation)return;
      await cameraDecoder.reset();
      if(current!==generation)return;
      async function scan(){
        if(current!==generation||!active())return;
        if(document.hidden){setTimeout(scan,250);return;}
        try{
          const width=video.videoWidth,height=video.videoHeight;
          if(width&&height){canvas.width=width;canvas.height=height;context.drawImage(video,0,0,width,height);
            const codes=await cameraDecoder.scan(context.getImageData(0,0,width,height),scanMode());
            if(current!==generation)return;
            setViewSize({width:camera.clientWidth,height:camera.clientHeight});setDetected(codes);
            const next=observations.update(codes,Date.now());
            if(next.map(item=>item.key).join('\0')!==observed().map(item=>item.key).join('\0'))setObserved(next);
            takeAtPointers(codes);
          }
        }catch{setMessage('カメラ画像を読み取れませんでした。');}
        if(current===generation&&active())setTimeout(scan,120);
      }
      scan();
    }catch{if(current===generation){stop();setMessage('カメラを利用できません。ブラウザーの許可設定を確認してください。');}}
  }
  const recovery=new CameraRecovery({
    eligible:()=>!document.hidden&&active()&&!!stream,
    ended:()=>stream!.getVideoTracks().every(track=>track.readyState==='ended'),
    restart:async()=>{stop();await start();},
    reconnect:async()=>{
      const current=generation,previous=stream!;
      try{
      // Reattach the live stream so Safari rebuilds its video layer after a background interruption.
      video.srcObject=null;video.srcObject=previous;
      await video.play();
      if(current===generation)setViewSize({width:camera.clientWidth,height:camera.clientHeight});
      }catch{if(current===generation)setMessage('カメラを再開できませんでした。');}
    },
  });
  async function toggleTorch(){
    const track=stream?.getVideoTracks()[0];if(!track||torchBusy())return;
    const desired=!torchOn();setTorchBusy(true);
    try{await cameraTask(()=>setTorch(track,desired));if(stream?.getVideoTracks()[0]===track)setTorchOn(desired);}
    catch{setMessage('ライトを切り替えできませんでした。');}
    finally{setTorchBusy(false);}
  }
  function toggleRecording(){
    if(recordingPhase()==='recording')recording.stop();
    else if(recordingPhase()==='idle'&&stream){setMessage('');recording.start(stream);}
  }
  async function readImages(images:Iterable<Blob>){
    let seen=false,found=false,failed=false;
    for(const image of images){
      try{const prepared=await prepareImage(image);if(!prepared)continue;seen=true;const codes=await decode(prepared,scanMode());if(codes.length)found=true;for(const code of codes)add(code);}
      catch{seen=true;failed=true;}
    }
    if(!seen)setMessage('画像が見つかりませんでした。');
    else if(!found)setMessage(failed?'画像を読み取れませんでした。':'QR コードが見つかりませんでした。');
    else if(failed)setMessage('一部の画像を読み取れませんでした。');
  }
  function files(event:Event){const input=event.currentTarget as HTMLInputElement;void readImages(Array.from(input.files??[]));input.value='';}
  async function pasteButton(){
    try{if(!navigator.clipboard)throw new Error('unavailable');await readImages(await readClipboardImages(navigator.clipboard));}
    catch{setMessage('画像を貼り付けできませんでした。ブラウザーの設定を確認してください。');}
  }
  const onPaste=(event:ClipboardEvent)=>{const images=clipboardImages(event.clipboardData);if(images.length){event.preventDefault();void readImages(images);}};
  const isFiles=(event:DragEvent)=>Array.from(event.dataTransfer?.types??[]).includes('Files');
  const dragEnter=(event:DragEvent)=>{if(isFiles(event)){event.preventDefault();dragDepth++;setDragging(true);}};
  const dragOver=(event:DragEvent)=>{if(isFiles(event)){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';}};
  const dragLeave=(event:DragEvent)=>{if(isFiles(event)){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)setDragging(false);}};
  const onDrop=(event:DragEvent)=>{if(isFiles(event)){event.preventDefault();dragDepth=0;setDragging(false);void readImages(Array.from(event.dataTransfer?.files??[]));}};
  const onVisibility=()=>{if(!document.hidden)void recovery.resume();};
  const onPageShow=()=>{void recovery.resume();};
  document.addEventListener('visibilitychange',onVisibility);window.addEventListener('pageshow',onPageShow);
  document.addEventListener('paste',onPaste);document.addEventListener('dragenter',dragEnter);document.addEventListener('dragover',dragOver);document.addEventListener('dragleave',dragLeave);document.addEventListener('drop',onDrop);
  onCleanup(()=>{stop();cameraDecoder.dispose();clearTimeout(focusTimer);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pageshow',onPageShow);document.removeEventListener('paste',onPaste);document.removeEventListener('dragenter',dragEnter);document.removeEventListener('dragover',dragOver);document.removeEventListener('dragleave',dragLeave);document.removeEventListener('drop',onDrop);});
  function reset(){if(fullDialog.open)fullDialog.close();batch(()=>{setExpanded(null);setCollection(emptyCollection());setPreviews([]);setMessage('');});}
  function remove(id:string){
    if(expanded()===id&&fullDialog.open)fullDialog.close();
    const next=deleteSuite(collection(),id);
    batch(()=>{setExpanded(null);setCollection(next);setPreviews(ids=>retainPreviews(ids,new Set(next.suites.map(s=>s.id))));setMessage('');});
  }
  async function copy(textarea:HTMLTextAreaElement,onSuccess:()=>void){
    try{await navigator.clipboard.writeText(textarea.value);onSuccess();}
    catch{textarea.focus();textarea.select();setMessage('選択した内容をコピーしてください。');}
  }
  async function share(textarea:HTMLTextAreaElement){if(navigator.share){try{await navigator.share({text:textarea.value});}catch{/* cancelled */}}else await copy(textarea,()=>{});}
  function download(suite:Suite){if(suite.text===null)return;const url=URL.createObjectURL(new Blob([suite.text],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='qr-result.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function dismiss(){setPreviews(dismissPreview);}
  function openPreview(id:string){if(previewSwiped){previewSwiped=false;return;}stop();requestAnimationFrame(()=>{const target=document.getElementById(`result-${id}`);target?.scrollIntoView({behavior:'smooth',block:'center'});target?.focus({preventScroll:true});});}
  function preview():Suite|undefined{return collection().suites.find(s=>s.id===previews()[0]);}
  function openFull(id:string){setExpanded(id);fullDialog.showModal();}
  function expandedSuite(){return collection().suites.find(s=>s.id===expanded());}
  function modeSelect(className:string){return h('select',{class:className,'aria-label':'読み取り方法',value:scanMode,onChange:(event:Event)=>setScanMode((event.currentTarget as HTMLSelectElement).value as ScanMode)},h('option',{value:'auto'},'自動'),h('option',{value:'standard'},'標準'),h('option',{value:'sharpen'},'輪郭補正'),h('option',{value:'curve'},'曲面補正'),h('option',{value:'shadow'},'影補正'));}
  function resultCard(suite:Suite){
    let textarea!:HTMLTextAreaElement;
    const [copied,setCopied]=createSignal(false);
    return h('article',{class:'result-card',id:`result-${suite.id}`,tabindex:-1},
      h('div',{class:'textarea-wrap'},h('textarea',{ref:(element:HTMLTextAreaElement)=>{textarea=element;},'aria-label':'読み取り結果',value:suite.text??'テキストとして表示できないデータです。',readonly:true}),
        h('button',{type:'button',class:'icon-button expand-button','aria-label':'結果を全画面表示',title:'全画面表示',onClick:()=>openFull(suite.id)},icon('expand'))),
      h('div',{class:'result-actions'},
        h('button',{type:'button',class:()=>`icon-button ${copied()?'copied':''}`,'aria-label':'コピー',title:'コピー',onClick:()=>copy(textarea,()=>{setCopied(true);setTimeout(()=>setCopied(false),1400);}),disabled:suite.text===null},()=>icon(copied()?'check':'copy')()),
        h('button',{type:'button',class:'icon-button','aria-label':'共有',title:'共有',onClick:()=>share(textarea),disabled:suite.text===null},icon('share')),
        h('button',{type:'button',class:'icon-button','aria-label':'ダウンロード',title:'ダウンロード',onClick:()=>download(suite),disabled:suite.text===null},icon('download')),
        h('button',{type:'button',class:'icon-button danger delete-result','aria-label':'結果と対応する QR を削除',title:'削除',onClick:()=>remove(suite.id)},icon('delete'))))();
  }
  return h('main',
    h('h1','QRコード一括リーダー'),
    h('div',{class:'toolbar'},
      h('button',{type:'button',class:'icon-button primary','aria-label':'カメラで読む',title:'カメラで読む',onClick:start},icon('camera')),
      h('label',{class:'icon-button upload-button',title:'写真を選ぶ'},icon('image'),h('input',{type:'file',accept:'image/*,.heic,.heif',multiple:true,'aria-label':'写真を選ぶ',onChange:files})),
      h('button',{type:'button',class:'icon-button','aria-label':'画像を貼り付け',title:'画像を貼り付け',onClick:pasteButton},icon('paste')),
      modeSelect('scan-mode toolbar-mode'),
      h('button',{type:'button',class:'icon-button danger reset-button','aria-label':'すべてリセット',title:'すべてリセット',onClick:reset},icon('reset'))),
    h('p',{class:'status',role:'status'},message),
    h('section',{'aria-label':'読み取り結果',class:'groups'},
      ()=>collection().groups.length?collection().groups.map(group=>{
        const suites=collection().suites.filter(s=>s.parts[0].total===group.total&&s.parts[0].parity===group.parity);
        return h('div',{class:'group'},group.total>1?h('div',{class:'parts'},...group.slots.map((slot,i)=>h('span',{class:slot.length?'part done':'part','aria-label':`${i+1}番 ${slot.length?`${slot.length}種類読み込み済み`:'未読み込み'}`},String(i+1),slot.length>1?h('span',{class:'part-count','aria-hidden':'true'},String(slot.length)):null))):null,...suites.map(resultCard))();
      }):h('p',{class:'empty'},'QRコードを読ませてください')()),
    h('footer',h('span','読み取りデータはこの端末内で処理されます。'),h('span',{class:'build-commit'},'コミット: ',h('code',buildCommit))),
    h('div',{class:()=>`camera-stage ${active()?'':'hidden'}`},
      h('div',{class:'camera',ref:(el:HTMLDivElement)=>{camera=el;},onPointerDown:(e:PointerEvent)=>{e.preventDefault();camera.setPointerCapture(e.pointerId);pointer(e);void focusPointer(e);},onPointerMove:(e:PointerEvent)=>{if(pointers.has(e.pointerId))pointer(e);},onPointerUp:(e:PointerEvent)=>pointers.remove(e.pointerId),onPointerCancel:(e:PointerEvent)=>pointers.remove(e.pointerId),onLostPointerCapture:(e:PointerEvent)=>pointers.remove(e.pointerId)},
        h('video',{ref:(el:HTMLVideoElement)=>{video=el;},autoplay:true,muted:true,playsinline:true}),
        h('svg',{viewBox:()=>`0 0 ${viewSize().width} ${viewSize().height}`,preserveAspectRatio:'none','aria-hidden':'true'},()=>detected().map(code=>{const points=geometry(code),status=hasPart(collection(),asPart(code))?'done':'new',x=points[0].x,y=Math.max(16,points[0].y-14);return h('g',{class:`qr-marker ${status}`},h('polygon',{points:points.map(p=>`${p.x},${p.y}`).join(' ')}),h('rect',{x,y:y-14,width:code.sequenceSize>0?48:30,height:26,rx:13}),h('text',{x:x+7,y:y+5},`${code.sequenceSize>0?code.sequenceIndex+1+' ':''}${status==='done'?'✓':'+'}`))();})),
        ()=>focusPoint()?h('span',{class:'focus-ring',style:{left:`${focusPoint()!.x}px`,top:`${focusPoint()!.y}px`},'aria-hidden':'true'})():null),
      ()=>torchAvailable()?h('button',{type:'button',class:()=>`icon-button camera-torch ${torchOn()?'on':''}`,'aria-label':()=>torchOn()?'ライトを消す':'ライトを点ける','aria-pressed':()=>String(torchOn()),title:'ライト',disabled:torchBusy,onClick:toggleTorch},icon('torch'))():null,
      modeSelect('scan-mode camera-mode'),
      h('button',{type:'button',class:'icon-button camera-close','aria-label':'カメラを停止',title:'カメラを停止',onClick:stop},icon('close')),
      h('button',{type:'button',class:()=>`icon-button camera-record ${recordingPhase()==='recording'?'recording':''}`,'aria-label':()=>recordingPhase()==='recording'?'録画を停止して保存':'録画を開始','aria-pressed':()=>String(recordingPhase()==='recording'),title:recordingSupported?'カメラ映像を録画して保存':'このブラウザーは録画に対応していません',disabled:()=>!recordingSupported||recordingPhase()==='stopping',onClick:toggleRecording},()=>recordingPhase()==='recording'?icon('stop')():icon('record')()),
      ()=>recordingPhase()!=='idle'?h('span',{class:'recording-status',role:'status'},()=>recordingPhase()==='stopping'?'録画を保存中…':`録画中 ${Math.floor(recordingSeconds()/60)}:${String(recordingSeconds()%60).padStart(2,'0')}`)():null,
      h('p',{class:'camera-error',role:'status'},message)),
    ()=>active()&&observed().length?h('aside',{class:()=>`observed ${preview()?'raised':''}`,'aria-label':'認識中の QR コード'},...observed().map(item=>h('div',{class:'observed-item'},item.part?h('span',{class:'observed-part'},item.part):null,item.url?h('a',{href:item.url,target:'_blank',rel:'noopener noreferrer',class:'observed-text',title:item.url},item.text):h('span',{class:'observed-text'},item.text||'QR'))))():null,
    ()=>active()&&preview()?h('aside',{class:'preview',role:'status',onPointerDown:(e:PointerEvent)=>{previewStartX=e.clientX;previewSwiped=false;(e.target as Element).closest('button')?.setPointerCapture(e.pointerId);},onPointerUp:(e:PointerEvent)=>{if(Math.abs(e.clientX-previewStartX)>45){previewSwiped=true;dismiss();}}},
      h('button',{type:'button',class:'preview-open',onClick:()=>{const item=preview();if(item)openPreview(item.id);}},h('span',{class:'preview-text'},preview()!.text??'テキストとして表示できないデータ'),h('span',{'aria-hidden':'true',class:'preview-arrow'},'↗')),
      h('button',{type:'button',class:'preview-dismiss','aria-label':'プレビューを閉じる',onClick:()=>{if(previewSwiped){previewSwiped=false;return;}dismiss();}},icon('close')))():null,
    h('dialog',{class:'full-result',ref:(el:HTMLDialogElement)=>{fullDialog=el;},'aria-label':'読み取り結果の全画面表示',onClose:()=>setExpanded(null)},
      ()=>expandedSuite()?h('div',{class:'full-content'},h('button',{type:'button',class:'icon-button full-close','aria-label':'全画面を閉じる',title:'閉じる',onClick:()=>fullDialog.close()},icon('collapse')),
        h('textarea',{'aria-label':'読み取り結果',readonly:true,value:expandedSuite()!.text??'テキストとして表示できないデータです。'}),
        h('button',{type:'button',class:'icon-button danger full-delete','aria-label':'結果と対応する QR を削除',title:'削除',onClick:()=>{const id=expanded();if(id)remove(id);}},icon('delete')))():null),
    ()=>dragging()?h('div',{class:'drop-indicator','aria-hidden':'true'},icon('image'))():null);
}
render(()=>App()() as Element,document.getElementById('app')!);
