import {batch, createSignal, onCleanup} from 'solid-js';
import {render} from 'solid-js/web';
import h from 'solid-js/h';
import type {ReadResult} from 'zxing-wasm/reader';
import {decode} from './decoder.ts';
import {assemble, type Assembly} from './assemble.ts';
import {takePart} from './session.ts';
import {type Point} from './geometry.ts';
import {Pointers} from './pointers.ts';

function App() {
  const [state, setState] = createSignal<Assembly>(null);
  const [message, setMessage] = createSignal('');
  const [result, setResult] = createSignal('');
  const [plain, setPlain] = createSignal<string[]>([]);
  const [active, setActive] = createSignal(false);
  const [detected, setDetected] = createSignal<ReadResult[]>([]);
  const [viewSize, setViewSize] = createSignal({width:1,height:1});
  let video!: HTMLVideoElement, camera!: HTMLDivElement;
  let stream: MediaStream | undefined;
  let generation = 0;
  const pointers = new Pointers();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {willReadFrequently:true})!;
  let output!: HTMLTextAreaElement;

  function stop() {
    generation++;
    const currentStream = stream;
    stream = undefined;
    // Stop hardware before triggering any reactive rendering.
    currentStream?.getTracks().forEach(track => track.stop());
    pointers.clear();
    batch(() => {
      setActive(false);
      setDetected([]);
    });
    video.srcObject = null;
  }
  onCleanup(stop);
  function add(code: ReadResult) {
    if (code.sequenceSize < 0) {
      if (state()) { setMessage('分割 QR の読み取り中です。この QR は追加できません。'); return; }
      if (!plain().includes(code.text)) { const next = [...plain(), code.text]; setPlain(next); setResult(next.join('\n')); }
      setMessage('QR コードを読み取りました。'); return;
    }
    if (plain().length) { setMessage('通常の QR が読み取り済みです。リセットしてから分割 QR を読み取ってください。'); return; }
    const update = takePart(state(), {index:code.sequenceIndex, total:code.sequenceSize, parity:Number(code.sequenceId), bytes:code.bytes}, stop);
    if (update.outcome === 'conflict') { setMessage('別の分割 QR または同じ番号の異なるデータです。リセットしてから読み直してください。'); return; }
    if (update.outcome === 'invalid') { setMessage('分割 QR の情報を読み取れませんでした。'); return; }
    if (update.outcome === 'duplicate') return;
    let text: string | undefined;
    let completionMessage = 'すべての QR を読み取りました。';
    if (update.status === 'complete') {
      try {
        try { text = new TextDecoder('utf-8', {fatal:true}).decode(update.bytes); }
        catch { text = new TextDecoder('shift_jis', {fatal:true}).decode(update.bytes); }
      } catch { text = ''; completionMessage = '読み取りデータをテキストとして表示できません。'; }
    }
    batch(() => {
      setState(update.state);
      if (update.status === 'complete') { setResult(text!); setMessage(completionMessage); }
      else if (update.status === 'checksum-error') { setResult(''); setMessage('チェックサムが一致しません。リセットして読み直してください。'); }
      else setMessage(`${code.sequenceIndex + 1} 番を読み取りました。`);
    });
  }
  function codeStatus(code: ReadResult): 'new' | 'done' | 'conflict' {
    if (code.sequenceSize < 0) return plain().includes(code.text) ? 'done' : state() ? 'conflict' : 'new';
    if (plain().length) return 'conflict';
    const current = state();
    if (!current) return 'new';
    const saved = current.parts.get(code.sequenceIndex);
    if (current.total !== code.sequenceSize || current.parity !== Number(code.sequenceId) || (saved && (saved.length !== code.bytes.length || !saved.every((b, i) => b === code.bytes[i])))) return 'conflict';
    return saved ? 'done' : 'new';
  }
  function geometry(code: ReadResult): Point[] {
    const {width,height} = viewSize();
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const x = (width - video.videoWidth * scale) / 2, y = (height - video.videoHeight * scale) / 2;
    const p = code.position;
    return [p.topLeft,p.topRight,p.bottomRight,p.bottomLeft].map(p => ({x:x+p.x*scale,y:y+p.y*scale}));
  }
  function takeAtPointers(codes: ReadResult[]) {
    for (const code of pointers.select(codes, geometry)) {
      add(code);
      if (!active()) break;
    }
  }
  function pointer(event: PointerEvent) {
    const rect = camera.getBoundingClientRect();
    pointers.update(event.pointerId, {x:event.clientX-rect.left,y:event.clientY-rect.top});
    takeAtPointers(detected());
  }
  async function start() {
    if (active()) return;
    if (assemble(state()).status === 'complete') { setMessage('読み取り済みです。新しく始めるにはリセットしてください。'); return; }
    const current = ++generation;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      if (current !== generation) { newStream.getTracks().forEach(track=>track.stop()); return; }
      stream = newStream; video.srcObject = stream; await video.play();
      if (current !== generation) return;
      setActive(true); setMessage('枠をタッチして QR を採択してください。');
      async function scan() {
        if (current !== generation || !active()) return;
        try {
          const width = video.videoWidth, height = video.videoHeight;
          if (width && height) {
            canvas.width = width; canvas.height = height;
            context.drawImage(video,0,0,width,height);
            const codes = await decode(context.getImageData(0,0,width,height));
            if (current !== generation) return;
            setViewSize({width:camera.clientWidth,height:camera.clientHeight});
            setDetected(codes);
            takeAtPointers(codes);
          }
        } catch { setMessage('カメラ画像を読み取れませんでした。'); }
        if (current === generation && active()) setTimeout(scan, 120);
      }
      scan();
    } catch { if (current === generation) { stop(); setMessage('カメラを利用できません。ブラウザーの許可設定を確認してください。'); } }
  }
  async function files(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    for (const file of Array.from(input.files ?? [])) {
      try { const codes = await decode(file); if (!codes.length) setMessage('画像内に QR コードが見つかりませんでした。'); for (const code of codes) add(code); }
      catch { setMessage('画像を読み取れませんでした。'); }
    }
    input.value = '';
  }
  function reset() { setState(null); setPlain([]); setResult(''); setMessage(''); }
  async function copy() { try { await navigator.clipboard.writeText(output.value); setMessage('コピーしました。'); } catch { output.select(); setMessage('結果を選択しました。コピーしてください。'); } }
  async function share() { if (navigator.share) { try { await navigator.share({text:output.value}); } catch { /* cancelled */ } } else await copy(); }
  return h('main',
    h('header', h('strong','つなぐ QR'),h('span',{class:'muted'},'端末内で処理')),
    h('p',{class:'eyebrow'},'STRUCTURED APPEND READER'),
    h('h1','バラバラの QR を、',h('br'),h('span','ひとつの答えに。')),
    h('p',{class:'lead'},'写真またはカメラから、分割 QR コードを読み取ります。'),
    h('section',{class:'panel'},h('h2','01　QR コードを読み込む'),
      h('div',{class:'buttons'},h('label',{class:'file-label'},'写真を選ぶ',h('input',{type:'file',accept:'image/*',multiple:true,onChange:files})),
      h('button',{type:'button',class:'secondary',onClick:()=>active()?stop():start()},()=>active()?'カメラを停止':'カメラで読む')),
      h('div',{class:()=>`camera ${active()?'':'hidden'}`,ref:(el:HTMLDivElement)=>{camera=el;},onPointerDown:(e:PointerEvent)=>{e.preventDefault();camera.setPointerCapture(e.pointerId);pointer(e);},onPointerMove:(e:PointerEvent)=>{if(pointers.has(e.pointerId)) pointer(e);},onPointerUp:(e:PointerEvent)=>pointers.remove(e.pointerId),onPointerCancel:(e:PointerEvent)=>pointers.remove(e.pointerId),onLostPointerCapture:(e:PointerEvent)=>pointers.remove(e.pointerId)},
        h('video',{ref:(el:HTMLVideoElement)=>{video=el;},autoplay:true,muted:true,playsinline:true}),
        h('svg',{viewBox:()=>`0 0 ${viewSize().width} ${viewSize().height}`,preserveAspectRatio:'none','aria-hidden':'true'},()=>detected().map(code=>{const points=geometry(code), status=codeStatus(code), x=points[0].x, y=Math.max(16,points[0].y-14); return h('g',{class:`qr-marker ${status}`},h('polygon',{points:points.map(p=>`${p.x},${p.y}`).join(' ')}),h('rect',{x,y:y-14,width:code.sequenceSize>0?48:30,height:26,rx:13}),h('text',{x:x+7,y:y+5},`${code.sequenceSize>0 ? code.sequenceIndex+1+' ' : ''}${status==='done'?'✓':status==='conflict'?'!':'+'}`))();}))),
      h('p',{class:'muted'},()=>active()?'枠をタッチして読み取り　＋ 未読　✓ 読取済　！ 不一致':'写真は複数枚選べます。1 枚の中の複数 QR にも対応しています。'),
      h('p',{class:'status',role:'status'},message)),
    h('section',{class:'panel'},h('div',{class:'buttons'},h('h2','02　読み込み状況'),h('button',{class:'secondary',onClick:reset},'リセット')),
      h('div',{class:'parts'},()=>state()?Array.from({length:state()!.total},(_,i)=>h('span',{class:state()!.parts.has(i)?'part done':'part','aria-label':`${i+1}番 ${state()!.parts.has(i)?'読み込み済み':'未読み込み'}`},String(i+1))()):h('span',{class:'muted'},'分割 QR を読み込むと番号が表示されます。')),
      h('p',{class:()=>assemble(state()).status==='complete'?'completion':'muted','aria-live':'polite'},()=>state()?(assemble(state()).status==='complete'?`✓ すべて揃いました　${state()!.parts.size} / ${state()!.total}`:`${state()!.parts.size} / ${state()!.total} 読み込み済み`):'')),
    h('section',{class:'panel'},h('h2','03　読み取り結果'),h('textarea',{ref:(el:HTMLTextAreaElement)=>{output=el;},'aria-label':'読み取り結果',placeholder:'読み取った内容がここに表示されます',value:result,onInput:(e:InputEvent)=>setResult((e.currentTarget as HTMLTextAreaElement).value)}),
      h('div',{class:'buttons'},h('button',{onClick:copy,disabled:()=>!result()},'コピー'),h('button',{class:'secondary',onClick:share,disabled:()=>!result()},'共有'))),
    h('footer','読み取りデータはこの端末内で処理されます。'));
}
render(() => App()() as Element, document.getElementById('app')!);
