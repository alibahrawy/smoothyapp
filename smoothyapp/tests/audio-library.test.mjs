import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const output=await build({entryPoints:[new URL('../src/main/audio-library.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {AudioLibrary}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const bytes=Buffer.alloc(512,1);
async function fixture(action){const dir=await mkdtemp(path.join(os.tmpdir(),'smoothy-audio-'));const downloads=path.join(dir,'downloads');await mkdir(downloads);let now=0;const library=new AudioLibrary(path.join(dir,'library'),async()=>{},()=>now);await library.load();try{await action({library,downloads,dir,tick:()=>{now+=4000;}});}finally{await rm(dir,{recursive:true,force:true});}}
test('download sessions ignore existing, partial, changing, nonMP3 and symlink files',async()=>fixture(async f=>{
 await writeFile(path.join(f.downloads,'existing.mp3'),bytes);await f.library.start(f.downloads);
 await writeFile(path.join(f.downloads,'new.mp3'),bytes);await writeFile(path.join(f.downloads,'new.mp3.crdownload'),bytes);await writeFile(path.join(f.downloads,'other.txt'),bytes);await symlink(path.join(f.downloads,'existing.mp3'),path.join(f.downloads,'link.mp3'));
 await f.library.poll();f.tick();await f.library.poll();assert.equal(f.library.snapshot().candidates.length,0);
 await rm(path.join(f.downloads,'new.mp3.crdownload'));await f.library.poll();f.tick();assert.equal(await f.library.poll(),true);assert.deepEqual(f.library.snapshot().candidates.map(x=>x.name),['new.mp3']);
 assert.equal(JSON.stringify(f.library.snapshot().candidates).includes(f.downloads),false);
 f.library.stop();await writeFile(path.join(f.downloads,'late.mp3'),bytes);f.tick();await f.library.poll();assert.equal(f.library.snapshot().candidates.length,1);
}));
test('keeping a track validates a stable MP3 and copies it permanently with editable credits',async()=>fixture(async f=>{
 const file=path.join(f.downloads,'Song - Artist.mp3');await writeFile(file,bytes);await f.library.offer([file]);const candidate=f.library.snapshot().candidates[0];
 const track=await f.library.keep(candidate.id,{title:'Song',artist:'Artist',license:'cc-by',credit:'Song by Artist — CC BY 4.0'});assert.equal(f.library.snapshot().candidates.length,0);assert.equal(f.library.snapshot().tracks.length,1);
 await rm(file);assert.deepEqual(await readFile(await f.library.file(track.id)),bytes);assert.match(f.library.snapshot().tracks[0].previewUrl,/smoothy-audio:\/\/library\//);
 await f.library.update(track.id,{title:'New title',artist:'Artist',license:'youtube-standard',credit:'Track notes'});
 const reloaded=new AudioLibrary(f.library.folder,async()=>{});await reloaded.load();assert.equal(reloaded.snapshot().tracks[0].title,'New title');assert.equal(reloaded.snapshot().tracks[0].credit,'Track notes');
 await assert.rejects(f.library.file('../../secrets'),/saved audio/);
}));
test('attribution-required audio cannot be kept without the credit; arbitrary licenses stay unverified',async()=>fixture(async f=>{
 const file=path.join(f.downloads,'song.mp3');await writeFile(file,bytes);await f.library.offer([file]);const id=f.library.snapshot().candidates[0].id;
 await assert.rejects(f.library.keep(id,{title:'Song',license:'cc-by'}),/attribution/);assert.equal(f.library.snapshot().tracks.length,0);
 const kept=await f.library.keep(id,{title:'Song',license:'free-for-everything'});assert.equal(kept.license,'unverified');
}));
test('changed candidates and invalid MP3s leave no copied media or catalog entries',async()=>fixture(async f=>{
 const file=path.join(f.downloads,'song.mp3');await writeFile(file,bytes);await f.library.offer([file]);const id=f.library.snapshot().candidates[0].id;await writeFile(file,Buffer.alloc(700));await assert.rejects(f.library.keep(id,{title:'Song'}),/changed/);assert.deepEqual(await readdir(f.library.folder),[]);
 const bad=new AudioLibrary(path.join(f.dir,'bad'),async()=>{throw Error('not MP3');});await bad.load();await bad.offer([file]);await assert.rejects(bad.keep(bad.snapshot().candidates[0].id,{title:'Song'}),/not MP3/);assert.deepEqual(await readdir(bad.folder),[]);
}));
test('manual add excludes symlinks and dismissing a candidate never deletes the download',async()=>fixture(async f=>{
 const file=path.join(f.downloads,'song.mp3');await writeFile(file,bytes);const link=path.join(f.downloads,'link.mp3');await symlink(file,link);await assert.rejects(f.library.offer([link]),/complete MP3/);await f.library.offer([file]);f.library.dismiss(f.library.snapshot().candidates[0].id);assert.deepEqual(await readFile(file),bytes);
}));
