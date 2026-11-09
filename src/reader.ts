import type {ReadResult} from 'zxing-wasm/reader';
import {type InputPart,xorBytes} from './collection.ts';
export function asPart(code:ReadResult):InputPart {
  if(code.sequenceSize < 0) return {index:0,total:1,parity:xorBytes(code.bytes),bytes:code.bytes,text:code.text};
  return {index:code.sequenceIndex,total:code.sequenceSize,parity:Number(code.sequenceId),bytes:code.bytes};
}
