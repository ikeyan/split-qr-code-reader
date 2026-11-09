import {batch, createSignal, onCleanup} from 'solid-js';
import {render} from 'solid-js/web';
import h from 'solid-js/h';
import type {ReadResult} from 'zxing-wasm/reader';
import {decode} from './decoder.ts';
import {addPart, deleteSuite, emptyCollection, hasPart, type Suite} from './collection.ts';
import {asPart} from './reader.ts';
import {type Point} from './geometry.ts';
import {Pointers} from './pointers.ts';
import {enqueuePreviews,dismissPreview,retainPreviews} from './previews.ts';

function App() {
  const [collection,setCollection]=createSignal(emptyCollection());
  const [message,setMessage]=createSignal('');
  const [active,setActive]=createSignal(false);
  const [detected,setDetected]=createSignal<ReadResult[]>([]);
  const [viewSize,setViewSize]=createSignal({width:1,height:1});
  const [previews,setPreviews]=createSignal<string[]>([]);
  let video!:HTMLVideoElement,camera!:HTMLDivElement;
  let stream:MediaStream|undefined;
  let generation=0, previewStartX=0;
  let previewSwiped=false;
  const pointers=new Pointers();
  const drafts=new Map<string,string>();
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d',{willReadFrequently:true})!;

  function stop() {
    generation++;
    const current=stream; stream=undefined;
    current?.getTracks().forEach(track=>track.stop());
    pointers.clear();
    batch(()=>{setActive(false);setDetected([]);setPreviews([]);});
    video.srcObject=null;
  }
  onCleanup(stop);
  function add(code:ReadResult, fromCamera=false) {
    const update=addPart(collection(),asPart(code));
    if(update.outcome==='invalid'){setMessage('分割 QR の情報を読み取れませんでした。');return;}
    if(update.outcome==='duplicate') return;
    batch(()=>{
      setCollection(update.collection);
      if(fromCamera && update.added.length) setPreviews(current=>enqueuePreviews(current,update.added.map(s=>s.id)));
      setMessage(update.added.length?'新しい結果ができました。':'QR コードを読み取りました。');
    });
  }
  function geometry(code:ReadResult):Point[] {
    const {width,height}=viewSize();
    const scale=Math.min(width/video.videoWidth,height/video.videoHeight);
    const x=(width-video.videoWidth*scale)/2,y=(height-video.videoHeight*scale)/2;
    const p=code.position;
    return [p.topLeft,p.topRight,p.bottomRight,p.bottomLeft].map(p=>({x:x+p.x*scale,y:y+p.y*scale}));
  }
  function takeAtPointers(codes:ReadResult[]){for(const code of pointers.select(codes,geometry)) add(code,true);}
  function pointer(event:PointerEvent){const rect=camera.getBoundingClientRect();pointers.update(event.pointerId,{x:event.clientX-rect.left,y:event.clientY-rect.top});takeAtPointers(detected());}
  async function start(){
    if(active())return;
    const current=++generation;
    try {
      const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      if(current!==generation){newStream.getTracks().forEach(track=>track.stop());return;}
      stream=newStream;video.srcObject=stream;await video.play();
      if(current!==generation)return;
      setActive(true);setMessage('枠をタッチして QR を読み取ります。');
      async function scan(){
        if(current!==generation||!active())return;
        try {
          const width=video.videoWidth,height=video.videoHeight;
          if(width&&height){
            canvas.width=width;canvas.height=height;context.drawImage(video,0,0,width,height);
            const codes=await decode(context.getImageData(0,0,width,height));
            if(current!==generation)return;
            setViewSize({width:camera.clientWidth,height:camera.clientHeight});
            setDetected(codes);takeAtPointers(codes);
          }
        } catch {setMessage('カメラ画像を読み取れませんでした。');}
        if(current===generation&&active())setTimeout(scan,120);
      }
      scan();
    }catch{if(current===generation){stop();setMessage('カメラを利用できません。ブラウザーの許可設定を確認してください。');}}
  }
  async function files(event:Event){
    const input=event.currentTarget as HTMLInputElement;
    for(const file of Array.from(input.files??[])){
      try {const codes=await decode(file);if(!codes.length)setMessage('画像内に QR コードが見つかりませんでした。');for(const code of codes)add(code);}
      catch{setMessage('画像を読み取れませんでした。');}
    }
    input.value='';
  }
  function reset(){drafts.clear();batch(()=>{setCollection(emptyCollection());setPreviews([]);setMessage('');});}
  function remove(id:string){
    const next=deleteSuite(collection(),id);
    for(const key of drafts.keys()) if(!next.suites.some(suite=>suite.id===key)) drafts.delete(key);
    batch(()=>{setCollection(next);setPreviews(ids=>retainPreviews(ids,new Set(next.suites.map(s=>s.id))));setMessage('結果と、その結果を構成する QR を削除しました。');});
  }
  async function copy(textarea:HTMLTextAreaElement){try{await navigator.clipboard.writeText(textarea.value);setMessage('コピーしました。');}catch{textarea.focus();textarea.select();setMessage('結果を選択しました。コピーしてください。');}}
  async function share(textarea:HTMLTextAreaElement){if(navigator.share){try{await navigator.share({text:textarea.value});}catch{/* cancelled */}}else await copy(textarea);}
  function dismiss(){setPreviews(dismissPreview);}
  function openPreview(id:string){
    if(previewSwiped){previewSwiped=false;return;}
    stop();
    requestAnimationFrame(()=>{const target=document.getElementById(`result-${id}`);target?.scrollIntoView({behavior:'smooth',block:'center'});target?.focus({preventScroll:true});});
  }
  function preview():Suite|undefined {return collection().suites.find(s=>s.id===previews()[0]);}
  function resultCard(suite:Suite,index:number){
    let textarea!:HTMLTextAreaElement;
    return h('article',{class:'result-card',id:`result-${suite.id}`,tabindex:-1},
      h('div',{class:'result-title'},h('h3',`結果 ${index+1}`),h('button',{type:'button',class:'delete-button','aria-label':`結果 ${index+1} と対応する QR を削除`,onClick:()=>remove(suite.id)},
        h('svg',{viewBox:'0 0 24 24','aria-hidden':'true'},h('path',{d:'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'})))),
      h('textarea',{ref:(element:HTMLTextAreaElement)=>{textarea=element;},'aria-label':`結果 ${index+1}`,value:drafts.get(suite.id)??suite.text??'テキストとして表示できないデータです。',readonly:suite.text===null,onInput:(event:InputEvent)=>drafts.set(suite.id,(event.currentTarget as HTMLTextAreaElement).value)}),
      h('div',{class:'buttons'},h('button',{type:'button',onClick:()=>copy(textarea),disabled:suite.text===null},'コピー'),h('button',{type:'button',class:'secondary',onClick:()=>share(textarea),disabled:suite.text===null},'共有'))
    )();
  }
  return h('main',
    h('header',h('strong','つなぐ QR'),h('span',{class:'muted'},'端末内で処理')),
    h('p',{class:'eyebrow'},'STRUCTURED APPEND READER'),
    h('h1','バラバラの QR を、',h('br'),h('span','ひとつの答えに。')),
    h('p',{class:'lead'},'写真やカメラから、複数の QR コードをまとめて読み取ります。'),
    h('section',{class:'panel'},h('h2','01　QR コードを読み込む'),
      h('div',{class:'buttons'},h('label',{class:'file-label'},'写真を選ぶ',h('input',{type:'file',accept:'image/*',multiple:true,onChange:files})),
        h('button',{type:'button',class:'secondary',onClick:()=>active()?stop():start()},()=>active()?'カメラを停止':'カメラで読む')),
      h('div',{class:()=>`camera ${active()?'':'hidden'}`,ref:(el:HTMLDivElement)=>{camera=el;},onPointerDown:(e:PointerEvent)=>{e.preventDefault();camera.setPointerCapture(e.pointerId);pointer(e);},onPointerMove:(e:PointerEvent)=>{if(pointers.has(e.pointerId))pointer(e);},onPointerUp:(e:PointerEvent)=>pointers.remove(e.pointerId),onPointerCancel:(e:PointerEvent)=>pointers.remove(e.pointerId),onLostPointerCapture:(e:PointerEvent)=>pointers.remove(e.pointerId)},
        h('video',{ref:(el:HTMLVideoElement)=>{video=el;},autoplay:true,muted:true,playsinline:true}),
        h('svg',{viewBox:()=>`0 0 ${viewSize().width} ${viewSize().height}`,preserveAspectRatio:'none','aria-hidden':'true'},()=>detected().map(code=>{const points=geometry(code),status=hasPart(collection(),asPart(code))?'done':'new',x=points[0].x,y=Math.max(16,points[0].y-14);return h('g',{class:`qr-marker ${status}`},h('polygon',{points:points.map(p=>`${p.x},${p.y}`).join(' ')}),h('rect',{x,y:y-14,width:code.sequenceSize>0?48:30,height:26,rx:13}),h('text',{x:x+7,y:y+5},`${code.sequenceSize>0?code.sequenceIndex+1+' ':''}${status==='done'?'✓':'+'}`))();}))),
      h('p',{class:'muted'},()=>active()?'枠をタッチして読み取り　＋ 未読　✓ 読取済':'写真は複数枚選べます。1 枚の中の複数 QR にも対応しています。'),
      h('p',{class:'status',role:'status'},message)),
    h('section',{class:'panel'},h('div',{class:'section-title'},h('h2','02　読み込み状況'),h('button',{type:'button',class:'secondary',onClick:reset},'すべてリセット')),
      ()=>collection().groups.length?collection().groups.map((group,index)=>h('div',{class:'group'},h('span',{class:'group-label'},`グループ ${index+1}`),h('div',{class:'parts'},...group.slots.map((slot,i)=>h('span',{class:slot.length?'part done':'part','aria-label':`${i+1}番 ${slot.length?`${slot.length}種類読み込み済み`:'未読み込み'}`},String(i+1),slot.length>1?h('span',{class:'part-count','aria-hidden':'true'},String(slot.length)):null))))()):h('p',{class:'muted'},'QR を読み込むと番号が表示されます。')()),
    h('section',{class:'panel results-section'},h('h2','03　読み取り結果'),()=>collection().suites.length?collection().suites.map(resultCard):h('p',{class:'muted'},'揃った結果がここに表示されます。')()),
    ()=>active()&&preview()?h('aside',{class:'preview',role:'status',onPointerDown:(e:PointerEvent)=>{previewStartX=e.clientX;previewSwiped=false;(e.target as Element).closest('button')?.setPointerCapture(e.pointerId);},onPointerUp:(e:PointerEvent)=>{if(Math.abs(e.clientX-previewStartX)>45){previewSwiped=true;dismiss();}}},
      h('button',{type:'button',class:'preview-open',onClick:()=>{const item=preview();if(item)openPreview(item.id);}},h('span',{class:'preview-label'},'✓ 読み取り結果'),h('span',{class:'preview-text'},preview()!.text??'テキストとして表示できないデータ'),h('span',{class:'preview-hint'},'タップして表示　↗')),
      h('button',{type:'button',class:'preview-dismiss','aria-label':'プレビューを閉じる',onClick:()=>{if(previewSwiped){previewSwiped=false;return;}dismiss();}},'×'))():null,
    h('footer','読み取りデータはこの端末内で処理されます。'));
}
render(()=>App()() as Element,document.getElementById('app')!);
