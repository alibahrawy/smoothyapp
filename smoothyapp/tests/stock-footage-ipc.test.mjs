import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const fixture = { handlers: new Map(), events: [] };
globalThis.__stockIpcFixture = fixture;
const output = await build({ entryPoints: [new URL('../src/main/stock-footage-ipc.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'stock-fixture', setup(builder) {
  builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`const f=globalThis.__stockIpcFixture;export const ipcMain={handle:(name,handler)=>f.handlers.set(name,handler)};export const app={getPath:()=>f.folder,on(){}};export const dialog={showOpenDialog:async()=>({canceled:true})};`}));
  builder.onLoad({filter:/stock-footage\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('private convert = convertStockVideo','private convert = async (a: string, b: string) => fs.copyFile(a, b)'),loader:'ts'}));
 } }] });
const { registerStockFootage } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const bytes=Buffer.concat([Buffer.from('1a45dfa3','hex'),Buffer.alloc(80)]);
async function withFixture(action){
 const folder=await mkdtemp(path.join(os.tmpdir(),'smoothy-stock-ipc-'));const original=globalThis.fetch;const values=new Map([['stockFootageFolder',folder]]);let connected=true,importsSucceed=true;const imports=[];
 fixture.folder=folder;
 globalThis.fetch=async url=>url.includes('/w/api.php')?Response.json({batchcomplete:true,query:{pages:[{pageid:100,videoinfo:[{width:1920,height:1080,duration:10,descriptionurl:'https://commons.wikimedia.org/wiki/File:Ocean.webm',thumburl:'https://thumb.wikimedia.org/ocean.jpg',extmetadata:{LicenseShortName:{value:'Public domain'},AttributionRequired:{value:'false'}},derivatives:[{width:1920,height:1080,type:'video/webm',src:'https://upload.wikimedia.org/ocean.webm'}]}]}]}}):new Response(bytes);
 fixture.handlers.clear();fixture.events=[];
 registerStockFootage({store:{get:key=>values.get(key),set:(key,value)=>values.set(key,value),delete:key=>values.delete(key)},window:()=>({webContents:{send:(type,data)=>fixture.events.push({type,data})}}),connected:()=>connected,importToPremiere:async filePath=>{imports.push(filePath);return {success:importsSucceed,error:'Premiere rejected MP4'};}});
 const invoke=(name,input)=>fixture.handlers.get('stock-'+name)(null,input);
 try{await action({folder,invoke,imports,values,disconnect:()=>{connected=false;},rejectImport:()=>{importsSucceed=false;}});}finally{globalThis.fetch=original;await rm(folder,{recursive:true,force:true});}
}
test('stock IPC searches without a key and settings report configuration without credentials',async()=>withFixture(async f=>{assert.deepEqual(f.invoke('get-settings'),{folder:f.folder,pixabayEnabled:false});assert.equal((await f.invoke('search',{query:'ocean'})).videos[0].license,'Public domain');}));
test('stock import rejects unknown IDs/disconnected Premiere and uses only the saved MP4',async()=>withFixture(async f=>{
 await f.invoke('search',{query:'ocean'});assert.equal((await f.invoke('download',{videoId:999,fileId:1})).success,false);assert.equal(f.imports.length,0);
 const result=await f.invoke('download',{videoId:100,fileId:1,premiere:true});assert.equal(result.imported,true);assert.deepEqual(f.imports,[result.path]);assert.deepEqual(await readFile(result.path),bytes);assert.equal(fixture.events.some(event=>event.data.phase==='converting'),true);
 f.disconnect();assert.match((await f.invoke('download',{videoId:100,fileId:1,premiere:true})).error,/Connect Premiere/);
}));
test('failed Premiere import retains the permanent MP4 and its source record',async()=>withFixture(async f=>{await f.invoke('search',{query:'ocean'});f.rejectImport();const result=await f.invoke('download',{videoId:100,fileId:1,premiere:true});assert.equal(result.success,false);assert.deepEqual(await readFile(result.path),bytes);assert.equal((await readdir(f.folder)).length,2);}));
test('desktop IPC exposes no provider key setter, remover or credential settings',async()=>withFixture(async f=>{
 assert.equal(fixture.handlers.has('stock-save-pixabay-key'),false);
 assert.equal(fixture.handlers.has('stock-remove-pixabay-key'),false);
 assert.deepEqual(f.invoke('get-settings'),{folder:f.folder,pixabayEnabled:false});
 assert.match((await f.invoke('search',{query:'ocean',provider:'pixabay'})).error,/unavailable in this build/);
}));
