import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const result = await build({entryPoints:[fileURLToPath(new URL('../src/main/local-audio-response.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {localAudioResponse} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const url='smoothy-local-audio://result/00000000-0000-0000-0000-000000000000';

test('real WAV delivery exposes length and exact seek ranges, including suffix/open end',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'smoothy-audio-response-'));
 const file=path.join(folder,'audio.wav'),bytes=Buffer.alloc(128*1024);
 for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 bytes.write('RIFF');bytes.write('WAVE',8);
 await fs.writeFile(file,bytes);
 try {
  let response=await localAudioResponse(file,new Request(url));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(bytes.length));
  assert.equal(response.headers.get('content-type'),'audio/wav');assert.equal(response.headers.get('accept-ranges'),'bytes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  for(const [range,start,end] of [['bytes=0-43',0,43],['bytes=65536-',65536,bytes.length-1],['bytes=-32',bytes.length-32,bytes.length-1],['bytes=131000-999999',131000,bytes.length-1]]){
   response=await localAudioResponse(file,new Request(url,{headers:{range}}));
   assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);
   assert.equal(response.headers.get('content-length'),String(end-start+1));
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
  }
  for(const range of ['bytes=131072-','bytes=7-2','bytes=-0','bytes=-','bytes=0-1,4-5','bytes=999999999999999999999-']){
   response=await localAudioResponse(file,new Request(url,{headers:{range}}));
   assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),`bytes */${bytes.length}`);assert.equal((await response.arrayBuffer()).byteLength,0);
  }
  response=await localAudioResponse(file,new Request(url,{method:'HEAD',headers:{range:'bytes=0-43'}}));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal((await response.arrayBuffer()).byteLength,0);
  assert.equal((await localAudioResponse(file,new Request(url,{method:'POST'}))).status,405);
  await assert.rejects(localAudioResponse(path.join(folder,'missing.wav'),new Request(url)));
  const controller=new AbortController();response=await localAudioResponse(file,new Request(url,{signal:controller.signal}));controller.abort();
  await assert.rejects(response.arrayBuffer());
 } finally {await fs.rm(folder,{recursive:true,force:true});}
});
