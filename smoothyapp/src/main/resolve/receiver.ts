import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { luaString } from './handoff';
import { createResolveConnector } from './connector';

const SIGNATURE = '-- SmoothyEdit Receive from Smoothy v1';
export type ReceiveJob = { id: string; kind: 'media' | 'timeline' | 'markers' | 'clear-markers' | 'source'; file?: string; timelineName?: string; nativeId?:string; markers?: { start: number; duration: number; name: string; note: string }[] };
export function receiveScript(job: ReceiveJob) {
  const markers = (job.markers || []).map(m => `{start=${m.start},duration=${m.duration},name=${luaString(m.name)},note=${luaString(m.note)}}`).join(',');
  return `${SIGNATURE}
local id = ${luaString(job.id)}
local function attempt(fn) local ok,value=pcall(fn);if ok then return value end end
local host=resolve
local manager=attempt(function() return host:GetProjectManager() end)
if not manager then host=attempt(function() return Resolve() end);manager=attempt(function() return host:GetProjectManager() end) end
if not manager then host=attempt(function() return (fusion or fu):GetResolve() end);manager=attempt(function() return host:GetProjectManager() end) end
local prefs=fusion or fu or attempt(function() return host:Fusion() end) or attempt(function() return Fusion() end)
if not prefs then if print then print('[Smoothy] Resolve preferences unavailable; nothing imported.') end;return end
local previous=attempt(function() return prefs:GetPrefs('Global.SmoothyEditReceiveV1') end)
if type(previous)=='string' and previous:sub(1,#id+1)==id..'|' then if print then print('[Smoothy] This request was already attempted. Check Smoothy for its result.') end;return end
local function report(phase)
  prefs:SetPrefs('Global.SmoothyEditReceiveV1', id..'|'..phase)
  prefs:SavePrefs()
  if print then print('[Smoothy] Receive: '..phase) end
end
local ok,detail=pcall(function()
  if not manager then report('noResolve');return end
  local project=manager:GetCurrentProject()
  if not project then report('noProject');return end
  local pool=project:GetMediaPool()
  if not pool then report('noPool');return end
  report('started')
  local kind=${luaString(job.kind)}
  local file=${luaString((job.file || '').replace(/\\/g, '/'))}
  if kind=='media' then
    local imported=pool:ImportMedia({file})
    if type(imported)~='table' or #imported<1 then report('rejected');return end
  elseif kind=='timeline' then
    -- The source is already in this project. Resolve's default reimport can
    -- fail to conform FCP7 source snapshots, especially outside the current bin.
    local folders={}
    local function visit(folder)
      if not folder or #folders>=256 then error('Media Pool folder limit exceeded') end
      folders[#folders+1]=folder
      for _,sub in ipairs(folder:GetSubFolderList() or {}) do visit(sub) end
    end
    visit(pool:GetRootFolder())
    local before=project:GetTimelineCount()
    local timeline=pool:ImportTimelineFromFile(file,{importSourceClips=false,sourceClipsFolders=folders,timelineName=${luaString((job.timelineName || 'Smoothy timeline')+' - '+job.id.slice(0,8))}})
    if not timeline then report('rejected');return end
    if project:GetTimelineCount()<=before or timeline:GetName()~=${luaString((job.timelineName || 'Smoothy timeline')+' - '+job.id.slice(0,8))} then report('rejected');return end
    -- Resolve can return an actual timeline containing offline placeholders.
    local clips=0
    for _,kind in ipairs({'video','audio'}) do
      for index=1,timeline:GetTrackCount(kind) do
        for _,item in ipairs(timeline:GetItemListInTrack(kind,index) or {}) do
          clips=clips+1
          if not item:GetMediaPoolItem() then
            local removed=attempt(function()return pool:DeleteTimelines({timeline})end)
            report(removed and 'offlineRemoved' or 'offline');return
          end
        end
      end
    end
    if clips==0 then attempt(function()return pool:DeleteTimelines({timeline})end);report('rejected');return end
    attempt(function()project:SetCurrentTimeline(timeline)end)
  else
    local timeline=project:GetCurrentTimeline()
    if not timeline or timeline:GetUniqueId()~=${luaString(job.nativeId || '')} or timeline:GetName()~=${luaString(job.timelineName || '')} then report('wrongTimeline');return end
    if kind=='clear-markers' then
      local existing=timeline:GetMarkers() or {}
      for frame,marker in pairs(existing) do
        if type(marker.customData)=='string' and marker.customData:sub(1,12)=='SmoothyEdit:' then
          if not timeline:DeleteMarkerAtFrame(frame) then report('partial');return end
        end
      end
    else
      local fps=tonumber(timeline:GetSetting('timelineFrameRate'))
      if not fps or fps<=0 then report('rejected');return end
      local markers={${markers}}
      local existing=timeline:GetMarkers() or {}
      -- Preflight collisions so an existing user marker is never overwritten.
      for _,m in ipairs(markers) do if existing[math.floor(m.start*fps+0.5)] then report('markerCollision');return end end
      local added={}
      for _,m in ipairs(markers) do
        local frame=math.floor(m.start*fps+0.5)
        if not timeline:AddMarker(frame,'Blue',m.name,m.note,math.max(1,math.floor(m.duration*fps+0.5)),'SmoothyEdit:'..id) then
          for _,prior in ipairs(added) do timeline:DeleteMarkerAtFrame(prior) end
          report('rejected');return
        end
        table.insert(added,frame)
      end
    end
  end
  report('done')
end)
if not ok then if print then print('[Smoothy] Receive API error: '..tostring(detail)) end;attempt(function() report('apiError') end) end
`;
}

export function readReceiveReceipt(profiles: string, id: string): string | null {
  try {
    let receipt: {time:number;phase:string} | null=null;
    for(const entry of fs.readdirSync(profiles,{withFileTypes:true})) {
      if(!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const file=path.join(profiles,entry.name,'Fusion.prefs'), stat=fs.lstatSync(file);
        if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2*1024*1024) continue;
        const match=fs.readFileSync(file,'utf8').match(/\bSmoothyEditReceiveV1\s*=\s*"([0-9a-f-]{36})\|([A-Za-z]+)"/);
        if(match?.[1]===id && (!receipt || stat.mtimeMs>receipt.time)) receipt={time:stat.mtimeMs,phase:match[2]};
      } catch {}
    }
    return receipt?.phase || null;
  } catch { return null; }
}
const errors: Record<string,string>={offline:'Resolve created a timeline with offline clips. It was not counted as a successful import. Check its media before retrying.',offlineRemoved:'Resolve could not link every source clip. The incomplete new timeline was removed; reload your source timeline and generate again.',noResolve:'Resolve did not provide its internal API.',noProject:'Open a Resolve project before receiving.',noPool:'Resolve did not provide its Media Pool.',rejected:'Resolve refused this import. Use the file shown by Smoothy for manual import.',apiError:'Resolve encountered an API error. Read its Lua Console; use manual import if needed.',wrongTimeline:'Open the loaded source timeline in Resolve, then send again.',markerCollision:'A marker already exists at one of these times. Nothing was overwritten.',partial:'Some Smoothy markers could not be removed. Review the timeline.'};
export function createResolveReceiver(deps:{scriptDirectory:string;profiles:string;changed:(value:any)=>void;sourceScript?:()=>string;interval?:number;timeout?:number;receipt?:(id:string)=>string|null}) {
  let active: {job:ReceiveJob;finish:(result:any)=>void;timer:ReturnType<typeof setInterval>;deadline:number;phase:string} | null=null;
  const publish=(value:any)=>{try{deps.changed(value);}catch{}};
  const connector=deps.sourceScript ? createResolveConnector(deps.scriptDirectory) : null;
  let lastFile='',lastResult:any={};
  const script=path.join(deps.scriptDirectory,'Receive from Smoothy.lua');
  function write(code:string) {
    fs.mkdirSync(deps.scriptDirectory,{recursive:true});
    if(fs.existsSync(script) && (!fs.lstatSync(script).isFile() || fs.lstatSync(script).isSymbolicLink() || !fs.readFileSync(script,'utf8').startsWith(SIGNATURE))) throw new Error('A different Receive from Smoothy script already exists; it was not replaced.');
    const temp=script+'.'+randomUUID()+'.tmp';
    try {fs.writeFileSync(temp,code,{flag:'wx'});fs.renameSync(temp,script);} finally {fs.rmSync(temp,{force:true});}
  }
  const shape=()=>({...lastResult,active:!!active,phase:active?.phase || 'idle',scriptPath:script,connectorPath:connector?.script,menu:connector?'Workspace → Scripts → Smoothy Connector':'Workspace → Scripts → Receive from Smoothy',file:active?.job.file || lastFile});
  function complete(result:any) {if(!active)return;const finish=active.finish;clearInterval(active.timer);lastFile=active.job.file || '';active=null;lastResult=result;publish(shape());finish(result);}
  function poll() {
    if(!active)return;
    const phase=(deps.receipt || (id=>readReceiveReceipt(deps.profiles,id)))(active.job.id);
    if(phase==='done') {complete({success:true,nle:'resolve',imported:true});return;}
    if(phase && phase!=='started') {complete({success:false,nle:'resolve',error:errors[phase] || 'Resolve could not confirm this request.'});return;}
    if(phase==='started' && active.phase!=='started'){active.phase='started';publish(shape());}
    if(Date.now()>active.deadline){if(active.phase==='waiting'){connector?.revoke();write(SIGNATURE+'\nif print then print("[Smoothy] This request expired. Send it again from Smoothy.") end\n');}complete({success:false,nle:'resolve',error:'Resolve has not confirmed the request. Start Workspace → Scripts → Smoothy Connector once in Resolve per session. If it already ran, check its Console and the Media Pool before retrying.'});}
  }
  function safePoll(){try{poll();}catch{complete({success:false,nle:'resolve',error:'Resolve handoff status could not be read or updated. Check the file and Console before retrying.'});}}
  return {
    isBusy:()=>!!active,snapshot:shape,install:()=>{if(active)throw new Error('Finish or cancel the pending Resolve request first.');connector?.install();},
    async send(input:Omit<ReceiveJob,'id'>) {
      if(active)return {success:false,error:'Finish the pending Resolve handoff first.'};
      if(input.file && (!path.isAbsolute(input.file) || !fs.statSync(input.file).isFile()))throw new Error('The media file is unavailable.');
      if(input.kind==='markers' && (!input.nativeId || !input.markers?.length || input.markers.length>1000 || input.markers.some(m=>![m.start,m.duration].every(Number.isFinite)||m.start<0||m.duration<0||m.name.length>2000||m.note.length>10000)))throw new Error('Load a fresh native Resolve snapshot and use valid marker ranges.');
      if(input.kind==='clear-markers' && !input.nativeId)throw new Error('Send the timeline again using the updated Send to Smoothy helper before editing markers.');
      const job={...input,id:randomUUID(),...(input.kind==='timeline'?{timelineName:input.timelineName || path.basename(input.file || 'Smoothy timeline','.xml')}:{})};
      const deadline=Date.now()+(deps.timeout || 180000);
      const code=input.kind==='source' && deps.sourceScript ? SIGNATURE+'\n'+`local p=fusion or fu or resolve:Fusion();p:SetPrefs('Global.SmoothyEditReceiveV1',${luaString(job.id+'|started')});p:SavePrefs()\n`+'local function captureSource()\n'+deps.sourceScript()+`\nend\ncaptureSource()\np:SetPrefs('Global.SmoothyEditReceiveV1',${luaString(job.id+'|done')});p:SavePrefs()\n` : receiveScript(job);
      write(code);connector?.queue(job.id,code,deadline);lastFile=input.file || '';lastResult={};
      return new Promise<any>(finish=>{active={job,finish,timer:setInterval(safePoll,deps.interval || 400),deadline,phase:'waiting'};active.timer.unref?.();publish(shape());});
    },
    cancel() {
      if(!active)return {success:true};
      safePoll();if(!active)return {success:true};
      if(active.phase==='started')return {success:false,error:'Resolve is already applying this request. Wait for its result.'};
      try{connector?.revoke();write(SIGNATURE+'\nif print then print("[Smoothy] Request canceled. Send a new request from Smoothy.") end\n');}catch{return {success:false,error:'Could not cancel the queued script. Wait for its result or check the Resolve Console.'};}
      complete({success:false,canceled:true,nle:'resolve',error:'Resolve handoff canceled. A script already running inside Resolve cannot be interrupted.'});return {success:true};
    },
    close(){if(active){if(active.phase==='waiting'){try{connector?.revoke();write(SIGNATURE+'\n-- Request expired when Smoothy closed.\n');}catch{}}clearInterval(active.timer);active.finish({success:false,canceled:true,error:'App closed.'});active=null;}}
  };
}
