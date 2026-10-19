import { app, ipcMain, dialog, protocol, type BrowserWindow } from 'electron';
import path from 'node:path';
import { getFFmpegPath } from './ffmpeg-path';
import { LocalAudioService, type AudioProgress } from './local-audio-service';
import { audioBackend } from './local-audio-runtime';
import { localAudioResponse } from './local-audio-response';
import { trackTool } from './telemetry';
import { CAPTION_AUDIO_EXTENSIONS, CAPTION_VIDEO_EXTENSIONS } from './captions/media-input';

protocol.registerSchemesAsPrivileged([{scheme:'smoothy-local-audio',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
export function registerLocalAudio(window: () => BrowserWindow | null) {
  const root = path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || app.getPath('userData') : app.getPath('userData'),'SmoothyEdit','audio-engine');
  const service = new LocalAudioService({root,ffmpeg:getFFmpegPath(),track:trackTool,backend:async()=>{
    const info = await app.getGPUInfo('basic');
    return audioBackend(process.platform,process.arch,(info as any).gpuDevice || []);
  }});
  const result = async (action: () => Promise<any>) => {
    try { return {success:true,...await action()}; }
    catch (error: any) { return error?.name === 'AbortError' || error?.message === 'Canceled' ? {success:false,canceled:true} : {success:false,error:error?.message || 'Audio processing failed.'}; }
  };
  const progress = (data: AudioProgress) => { const target=window(); if(target && !target.isDestroyed()) target.webContents.send('local-audio-progress',typeof data === 'string' ? {message:data} : data); };
  const operation = async (event: any, action: () => Promise<any>) => {
    const cancel = () => service.cancel(); event.sender.once('destroyed',cancel);
    try { return await result(action); } finally { event.sender.removeListener('destroyed',cancel); }
  };
  ipcMain.handle('local-audio-state',()=>result(()=>service.state()));
  ipcMain.handle('local-audio-pick',(event)=>operation(event,async()=>{
    const target=window(); if(!target)return {canceled:true};
    const choice=await dialog.showOpenDialog(target,{properties:['openFile'],filters:[{name:'Audio or video',extensions:[...CAPTION_AUDIO_EXTENSIONS,...CAPTION_VIDEO_EXTENSIONS]}]});
    if(choice.canceled || !choice.filePaths[0])return {canceled:true};
    return {source:await service.select(choice.filePaths[0],progress)};
  }));
  ipcMain.handle('local-audio-setup',(event)=>operation(event,()=>service.setup(progress)));
  ipcMain.handle('local-audio-run',(event,input)=>operation(event,async()=>{
    const outputs=await service.process(input,progress);
    return {outputs,original:service.original()};
  }));
  ipcMain.handle('local-audio-cancel',()=>{service.cancel();return {success:true};});
  ipcMain.handle('local-audio-preview',(_,id)=>result(async()=>{service.preview(id);return {};}));
  ipcMain.handle('local-audio-save',(_,id)=>result(async()=>{
    const output=service.output(id), target=window(); if(!target)return {canceled:true};
    const choice=await dialog.showSaveDialog(target,{defaultPath:path.join(app.getPath('downloads'),`${output.label.replace(/[^a-z0-9 -]/gi,'') || 'Audio'}.wav`),filters:[{name:'WAV audio',extensions:['wav']}]});
    if(choice.canceled || !choice.filePath)return {canceled:true};
    await service.save(id,choice.filePath); return {};
  }));
  protocol.handle('smoothy-local-audio',async request=>{
    try { const url=new URL(request.url); if(url.hostname!=='result' || !/^\/[0-9a-f-]{36}$/.test(url.pathname))throw Error();
      return await localAudioResponse(service.output(url.pathname.slice(1)).file, request);
    } catch {return new Response('',{status:404});}
  });
  app.on('before-quit',()=>{void service.dispose();});
  return service;
}
