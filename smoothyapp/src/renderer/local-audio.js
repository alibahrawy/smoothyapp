import { createLocalAudioPlayer } from './local-audio-player.js';

export function initLocalAudio() {
  const api=window.electronAPI,el=id=>document.getElementById(`local-audio-${id}`);
  let source=null,separated=null,enhanced=null,ready=null,busy=false,operation=null,canceling=false,actionId=0,timer,retry=false,retryMode='separate',stateFailure=null,measured=null;
  const tasks={pick:'Preparing original audio',setup:'Setting up audio engine',separate:'Separating speech and music',enhance:'Enhancing speech'};
  const playbackStatus=(text,error=false)=>{
    el('playback-status').textContent=text;el('playback-status').classList.toggle('hidden',!text);
    el('playback-status').classList.toggle('cleanup-playback-error',error);
    el('playback-status').setAttribute('role',error?'alert':'status');
  };
  const player=createLocalAudioPlayer(el('results'),{
    enhance:context=>enhance(context),preview:id=>api.localAudioPreview(id),error:text=>playbackStatus(text,true),
    save:async output=>{const result=await api.localAudioSave(output.id);if(!busy)playbackStatus(result.canceled?'Save canceled.':result.error || `${output.label} saved.`,Boolean(result.error));},
  });
  const status=(text,error=false)=>{
    measured=null;renderProgress();
    el('feedback').classList.toggle('hidden',!text&&!busy);
    el('feedback').classList.toggle('has-error',error);
    el('status').setAttribute('role',error?'alert':'status');
    el('status').setAttribute('aria-live',error?'assertive':'polite');
    el('status').textContent=text;
  };
  function renderProgress(){
    const bar=el('progress'),known=busy&&measured&&measured.total>0;
    bar.classList.toggle('hidden',!known);
    for(const attribute of ['aria-valuemin','aria-valuemax','aria-valuenow','aria-valuetext'])bar.removeAttribute(attribute);
    if(known){
      const completed=Math.min(measured.completed||0,measured.total),percent=Math.floor(completed/measured.total*100);
      bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(measured.total));bar.setAttribute('aria-valuenow',String(completed));
      const counts=measured.unit==='bytes'?`${(completed/1048576).toFixed(1)} / ${(measured.total/1048576).toFixed(1)} MB`:`${completed} / ${measured.total} ${measured.unit||'steps'}`;
      const text=`${counts} · ${percent}% of this stage`;
      bar.setAttribute('aria-valuetext',text);bar.querySelector('span').style.width=`${percent}%`;
      el('progress-hint').textContent=text;
    }else{
      bar.querySelector('span').style.width='0%';
      el('progress-hint').textContent=operation==='setup'?'Installing the local runtime and checking models. Progress appears when the download size is known.':operation==='pick'?'Decoding your recording.':'Loading or writing audio. Chunk progress appears when processing begins.';
    }
  }
  const sync=()=>{
    el('pick').disabled=busy;el('pick').textContent=source?'Change file':'Choose file';
    el('source').classList.toggle('is-empty',!source);
    el('setup-note').classList.toggle('hidden',ready!==false);
    el('cancel').classList.toggle('hidden',!busy);el('cancel').disabled=canceling;
    el('cancel').textContent=canceling?'Canceling…':'Cancel';
    el('retry').classList.toggle('hidden',busy||!retry||!source);
    el('retry').textContent=retryMode==='enhance'?'Retry enhancement':'Retry separation';
    el('setup').classList.toggle('hidden',busy||!retry||!source||!el('feedback').classList.contains('has-error'));
    el('feedback').classList.toggle('is-processing',busy);
    el('activity').classList.toggle('hidden',!busy);
    el('progress').setAttribute('aria-label',busy?tasks[operation]:'Audio processing in progress');
    el('progress-hint').classList.toggle('hidden',!busy);
    renderProgress();
    el('task').textContent=busy?(canceling?'Canceling audio operation':tasks[operation]):'';
    player.setBusy(busy);
  };
  const action=async(kind,work)=>{
    if(busy)return false;
    busy=true;operation=kind;canceling=false;retry=false;actionId++;player.pause();playbackStatus('');
    const started=performance.now();
    const elapsed=()=>{const seconds=Math.floor((performance.now()-started)/1000);el('elapsed').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} elapsed`;};
    elapsed();timer=setInterval(elapsed,1000);
    status(kind==='pick'?'Choose your recording…':'Starting audio processing…');sync();
    el('operation').scrollIntoView({block:'nearest'});
    try{return await work();}
    catch(error){retry=kind!=='pick';status(error.message||'Audio action failed.',true);return false;}
    finally{
      clearInterval(timer);busy=false;canceling=false;operation=null;sync();
      if(!el('status').textContent)el('feedback').classList.add('hidden');
      if(el('feedback').classList.contains('has-error'))el('operation').scrollIntoView({block:'nearest'});
    }
  };
  // First separation awaits this initial read, avoiding unnecessary setup when
  // a file is chosen before the ready-state response reaches the renderer.
  const state=api.localAudioState().then(result=>{
    if(result.success===false)throw Error(result.error||'Could not check the audio engine.');
    ready=result.ready===true;sync();return ready;
  }).catch(error=>{stateFailure=error;});
  api.onLocalAudioProgress(data=>{
    if(!busy||canceling||typeof data?.message!=='string')return;
    if(data.backend){el('device').textContent=data.message;return;}
    status(data.message);
    if(Number.isFinite(data.completed)&&data.completed>=0&&Number.isFinite(data.total)&&data.total>0){measured=data;renderProgress();}
  });
  el('pick').addEventListener('click',async()=>{const selected=await action('pick',async()=>{
    const result=await api.localAudioPick();
    if(result.source){
      source=result.source;separated=null;enhanced=null;el('source').textContent=source.name;el('source').title=source.name;
      player.load({source},{mode:'original'});
      status('Preparing separation…');return true;
    }
    if(result.error)throw Error(result.error);
    status(result.canceled&&canceling?'Canceled. Your previous audio is unchanged.':'');return false;
  });if(selected)void processAudio('separate');});
  const enhance=(context=player.getState())=>processAudio('enhance',context);
  async function processAudio(mode,context=player.getState(),repair=false){
    if(!source||busy)return;
    retryMode=mode;
    const completed=await action(mode,async()=>{
      await state;
      if(stateFailure){
        const result=await api.localAudioState();
        if(result.success===false)throw Error(result.error||'Could not check the audio engine.');
        ready=result.ready===true;stateFailure=null;
      }
      if(!ready||repair){
        operation='setup';sync();status('Downloading and preparing the local audio engine…');
        const result=await api.localAudioSetup();ready=result.ready===true;
        if(!result.success){retry=true;status(result.canceled?'Setup canceled. You can retry.':result.error||'Audio engine setup failed.',!result.canceled);return false;}
        if(!ready)throw Error('Audio engine setup did not finish. Try again.');
      }
      if(canceling){retry=true;status('Canceled. Your original audio is unchanged.');return false;}
      if(mode==='separate'||!separated){
        operation='separate';sync();status('Separating speech from music and noise…');
        const result=await api.localAudioRun({source:source.id,mode:'separate'});
        if(!result.success){retryMode='separate';retry=true;status(result.canceled?'Separation canceled. You can retry.':result.error||'Audio separation failed. Try again.',!result.canceled);return false;}
        separated=result.outputs;enhanced=null;
        player.load({source,separated},{mode:'original',time:context.time});
      }
      if(canceling){retry=true;status('Canceled. Your original audio is unchanged.');return false;}
      if(mode==='enhance'){
        operation='enhance';sync();status('Enhancing speech. Music and noise will be removed…');
        const result=await api.localAudioRun({source:source.id,mode:'enhance'});
        if(!result.success){retryMode='enhance';retry=true;status(result.canceled?'Enhancement canceled. Your separated audio is unchanged.':result.error||'Speech enhancement failed. Try again.',!result.canceled);return false;}
        const output=result.outputs?.find(item=>item.kind==='speech');
        if(!output)throw Error('The audio engine did not return the enhanced speech.');
        enhanced=output;
        player.load({source,separated,enhanced},{mode:'enhanced',time:context.time});
        status('Speech enhanced. Music and noise are removed.');
      }else status('Speech and Music are ready.');
      return true;
    });
    if(completed){
      el('results').scrollIntoView({block:'nearest'});
      if(context.resume&&document.getElementById('tab-local-audio').classList.contains('active'))void player.play();
    }
  }
  el('retry').addEventListener('click',()=>void processAudio(retryMode));
  el('setup').addEventListener('click',()=>void processAudio(retryMode,player.getState(),true));
  el('cancel').addEventListener('click',async()=>{
    if(!busy||canceling)return;
    const current=actionId;canceling=true;sync();status('Canceling… Waiting for the audio engine to stop.');
    try{const result=await api.localAudioCancel();if(result?.success===false)throw Error(result.error||'Could not cancel audio processing.');}
    catch(error){if(busy&&current===actionId){canceling=false;sync();status(error.message||'Could not cancel audio processing.',true);}}
  });
  sync();
}
