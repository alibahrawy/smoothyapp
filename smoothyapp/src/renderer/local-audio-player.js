const paths={
  play:'<path d="m9 5 11 7-11 7Z"/>',
  pause:'<path d="M9 5v14M16 5v14"/>',
  volume:'<path d="m11 5-6 4H2v6h3l6 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted:'<path d="m11 5-6 4H2v6h3l6 4ZM16 9l6 6m0-6-6 6"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const formatTime=value=>{const seconds=Math.max(0,Math.floor(value||0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const descriptions={
  originalSpeech:'The voice from your recording, unchanged.',
  originalMusic:'Music, room and noise outside the speech, unchanged.',
  enhancedSpeech:'The cleaned voice. Music and noise are gone.',
  waiting:'Waiting for separation…',
};

// One transport drives both versions. Original plays the exact Speech + Music
// split (which reconstructs the source), while Enhanced plays only the cleaned
// speech. Playback is streamed, never buffered as complete recordings.
export function createLocalAudioPlayer(host,{preview,save,error,enhance}) {
  host.innerHTML=`
    <div class="cleanup-transport">
      <button type="button" class="cleanup-play" aria-label="Play audio">${icon('play')}</button>
      <span class="cleanup-current">0:00</span>
      <input class="cleanup-seek" type="range" min="0" max="0" step="0.01" value="0" aria-label="Playback position" disabled>
      <span class="cleanup-duration">0:00</span>
    </div>
    <div class="cleanup-mixer">
      <div class="cleanup-comparison"><button type="button" class="cleanup-original-label" aria-pressed="true">Original</button><button type="button" class="cleanup-compare" role="switch" aria-label="Enhanced audio" aria-checked="false"><span></span></button><button type="button" class="cleanup-enhanced-label" aria-pressed="false">Enhanced</button></div>
      <p class="cleanup-enhance-note"></p>
      <div class="cleanup-tracks"></div>
    </div>
    <p class="cleanup-preview-note"></p>
    <div class="cleanup-media" hidden></div>`;
  const $=selector=>host.querySelector(selector);
  const playButton=$('.cleanup-play'),seek=$('.cleanup-seek'),compare=$('.cleanup-compare');
  const rows=new Map(),all=[],previewed=new Set();
  let source=null,separated=[],enhanced=null,mode='original',solo=null,playing=false,starting=false,busy=false,time=0,duration=0,version=0,frame=0,lastSync=0;
  const stem=kind=>separated.find(track=>track.output.kind===kind);
  const active=()=>mode==='enhanced'?(enhanced?[enhanced]:[]):(separated.length?separated:(source?[source]:[]));
  const clock=()=>active()[0]?.media;
  const audit=track=>track.audible && !track.media.muted && track.media.volume>0;
  const report=track=>{
    if(track.reported || track.media.paused || !audit(track))return;
    track.reported=true;previewed.add(track.output.id);Promise.resolve().then(()=>preview(track.output.id)).catch(()=>{});
  };
  function refreshDuration() {
    const durations=active().map(track=>track.media.duration).filter(value=>Number.isFinite(value)&&value>0);
    duration=durations.length?Math.min(...durations):0;
    if(duration)time=Math.min(time,duration);
    renderTransport();
  }
  function renderTransport() {
    playButton.innerHTML=icon(playing||starting?'pause':'play');
    playButton.setAttribute('aria-label',playing||starting?'Pause audio':'Play audio');
    playButton.setAttribute('aria-busy',String(starting));
    playButton.disabled=!active().length||busy;
    seek.max=String(duration);seek.value=String(Math.min(time,duration));seek.disabled=!duration||busy;
    seek.style.setProperty('--position',`${duration?time/duration*100:0}%`);
    seek.setAttribute('aria-valuetext',`${formatTime(time)} of ${formatTime(duration)}`);
    $('.cleanup-current').textContent=formatTime(time);$('.cleanup-duration').textContent=formatTime(duration);
  }
  function renderRows() {
    for(const [kind,row] of rows){
      const track=mode==='enhanced'?(kind==='speech'?enhanced:null):stem(kind);
      const shown=mode==='original'||kind==='speech';
      row.hidden=!shown;
      const adjustable=mode==='enhanced'&&kind==='speech';
      const muted=!track||track.muted||(adjustable&&track.level===0)||(mode==='original'&&solo&&solo!==kind);
      row.classList.toggle('is-muted',muted);row.classList.toggle('is-unavailable',!track);
      const slider=row.querySelector('input');
      slider.disabled=!adjustable||!track||busy;
      slider.value=String(adjustable&&track?track.level:100);
      row.style.setProperty('--level',`${adjustable&&track?track.level:100}%`);
      const output=row.querySelector('output');
      output.hidden=!adjustable;output.textContent=adjustable?(track?`${track.level}%`:'—'):'';
      const mute=row.querySelector('.cleanup-mute');
      mute.hidden=false;mute.disabled=!track||busy;
      mute.innerHTML=icon(muted?'muted':'volume');
      mute.setAttribute('aria-pressed',String(muted));
      mute.setAttribute('aria-label',`${muted?'Unmute':'Mute'} ${row.dataset.label.toLowerCase()}`);
      const soloButton=row.querySelector('.cleanup-solo');
      soloButton.hidden=mode==='enhanced';soloButton.disabled=!track||busy;
      soloButton.setAttribute('aria-pressed',String(solo===kind));
      soloButton.setAttribute('aria-label',solo===kind?'Listen to both tracks':`Listen to ${row.dataset.label.toLowerCase()} only`);
      const tag=row.querySelector('.cleanup-track-tag');tag.hidden=!adjustable;
      row.querySelector('.cleanup-exact span:last-child').textContent=kind==='speech'?'Exact · unchanged':'Exact · noise stays here';
      const saveButton=row.querySelector('.cleanup-save');
      saveButton.disabled=!track||busy;
      saveButton.title=adjustable?'Save enhanced speech WAV':`Save ${row.dataset.label.toLowerCase()} WAV`;
      saveButton.setAttribute('aria-label',saveButton.title);
      row.querySelector('.cleanup-track-caption').textContent=!track?descriptions.waiting:adjustable?descriptions.enhancedSpeech:kind==='speech'?descriptions.originalSpeech:descriptions.originalMusic;
      const help=!track?'Separation has not finished yet.':adjustable?'Enhanced speech with music and noise removed.':'Exact separation, unchanged. Noise stays with the music.';
      const info=row.querySelector('.cleanup-info');info.title=help;info.setAttribute('aria-label',help);
      if(track){
        track.media.volume=adjustable?track.level/100:1;
        track.media.muted=Boolean(muted);
        if(playing)report(track);
      }
    }
    compare.setAttribute('aria-checked',String(mode==='enhanced'));compare.disabled=!source||busy;
    compare.setAttribute('aria-busy',String(busy));
    for(const [selector,selected] of [['.cleanup-original-label',mode==='original'],['.cleanup-enhanced-label',mode==='enhanced']]){const button=$(selector);button.disabled=!source||busy;button.setAttribute('aria-pressed',String(selected));}
    $('.cleanup-enhance-note').textContent=mode==='enhanced'?(enhanced?'Only the enhanced speech plays. Music and noise are removed.':'Enhancing speech…'):(separated.length?'Use Solo to listen to Speech or Music on its own. Mute either track while listening.':'Preparing your exact split…');
    $('.cleanup-preview-note').textContent=mode==='enhanced'?'Less / More changes this preview only. The saved WAV is the enhanced speech.':'Downloads are the exact Speech and Music WAVs.';
    host.classList.toggle('is-original',mode==='original');
    host.dataset.mode=mode;
  }
  function render(){renderRows();renderTransport();}
  function tick(now) {
    if(!playing)return;
    const leader=clock();if(leader)time=Math.min(leader.currentTime,duration);
    if(now-lastSync>350){
      for(const track of active())if(track.media!==leader && Math.abs(track.media.currentTime-time)>.12)track.media.currentTime=time;
      lastSync=now;
    }
    renderTransport();frame=requestAnimationFrame(tick);
  }
  function pause() {
    if(playing&&clock())time=clock().currentTime;
    version++;playing=false;starting=false;cancelAnimationFrame(frame);
    all.forEach(track=>track.media.pause());renderTransport();
  }
  async function play() {
    if(!active().length||busy)return;
    const current=++version;
    if(duration && time>=duration-.02)time=0;
    const tracks=active();starting=true;renderTransport();renderRows();
    try {
      tracks.forEach(track=>{track.media.currentTime=time;});
      await Promise.all(tracks.map(track=>track.media.play()));
      if(current!==version)return;
      starting=false;playing=true;tracks.forEach(report);renderTransport();frame=requestAnimationFrame(tick);
    } catch(cause){
      if(current!==version)return;
      pause();error('Could not play the audio preview. Try again or save the WAV to listen.');
    }
  }
  playButton.addEventListener('click',()=>playing||starting?pause():void play());
  seek.addEventListener('input',()=>{
    time=Number(seek.value);
    active().forEach(track=>{track.media.currentTime=time;});renderTransport();
  });
  function chooseVersion(next){
    if(busy||!source||next===mode)return;
    const context=getState();pause();
    if(next==='enhanced'&&!enhanced){
      Promise.resolve().then(()=>enhance?.(context)).catch(cause=>error(cause.message||'Could not enhance this recording.'));
      return;
    }
    mode=next;refreshDuration();render();if(context.resume)void play();
  }
  compare.addEventListener('click',()=>chooseVersion(mode==='enhanced'?'original':'enhanced'));
  $('.cleanup-original-label').addEventListener('click',()=>chooseVersion('original'));
  $('.cleanup-enhanced-label').addEventListener('click',()=>chooseVersion('enhanced'));
  for(const [kind,label] of [['speech','Speech'],['music','Music']]){
    const row=document.createElement('section');row.className=`cleanup-track cleanup-track-${kind}`;row.dataset.kind=kind;row.dataset.label=label;
    row.innerHTML=`<div class="cleanup-track-heading"><h3>${label}<span class="cleanup-track-tag" hidden>Enhanced</span></h3><span class="cleanup-info" role="img">${icon('info')}</span><div class="cleanup-track-actions"><button type="button" class="cleanup-solo">Solo</button><button type="button" class="cleanup-mute"></button><button type="button" class="cleanup-save" aria-label="Save ${label.toLowerCase()} WAV">${icon('download')}</button><output aria-live="off" hidden></output></div></div><p class="cleanup-track-caption"></p><div class="cleanup-exact"><span class="cleanup-exact-dot" aria-hidden="true"></span><span>Exact · no level changes</span></div><input type="range" min="0" max="100" step="1" value="100" aria-label="${label} volume"><div class="cleanup-range-labels"><span>Less</span><span>More</span></div>`;
    const slider=row.querySelector('input');
    slider.addEventListener('input',event=>{
      const track=enhanced;if(mode!=='enhanced'||kind!=='speech'||!track||busy)return;
      track.level=Number(event.target.value);if(track.level)track.lastLevel=track.level;track.muted=false;renderRows();
    });
    row.querySelector('.cleanup-mute').addEventListener('click',()=>{
      const track=mode==='enhanced'?(kind==='speech'?enhanced:null):stem(kind);if(!track||busy)return;
      if(mode==='original'&&solo&&solo!==kind){solo=null;track.muted=false;renderRows();return;}
      if(track.muted||track.level===0){if(!track.level)track.level=track.lastLevel||100;track.muted=false;}else track.muted=true;
      renderRows();
    });
    row.querySelector('.cleanup-solo').addEventListener('click',()=>{
      if(mode!=='original'||!stem(kind)||busy)return;
      solo=solo===kind?null:kind;
      if(solo)stem(kind).muted=false;
      renderRows();if(!playing&&!starting)void play();
    });
    row.querySelector('.cleanup-save').addEventListener('click',async event=>{
      const track=mode==='enhanced'?(kind==='speech'?enhanced:null):stem(kind);if(!track)return;
      const button=event.currentTarget;button.disabled=true;
      try {await save(track.output);}catch(cause){error(cause.message||'Could not save this track.');}finally{button.disabled=busy||!track;}
    });
    rows.set(kind,row);$('.cleanup-tracks').append(row);
  }
  new MutationObserver(()=>{if(!host.closest('.tab-content')?.classList.contains('active'))pause();}).observe(host.closest('.tab-content'),{attributes:true,attributeFilter:['class']});
  function load(data={},options={}) {
    const controls=new Map(all.map(track=>[track.output.id,{level:track.level,lastLevel:track.lastLevel,muted:track.muted}]));
    if(source?.output.id!==data.source?.id)solo=null;
    pause();all.splice(0).forEach(track=>{track.media.removeAttribute('src');track.media.load();});$('.cleanup-media').replaceChildren();
    time=Number.isFinite(options.time)?Math.max(0,options.time):0;duration=0;source=null;separated=[];enhanced=null;lastSync=0;
    mode=options.mode==='enhanced'&&data.enhanced?'enhanced':'original';
    const entries=[...(data.source?[{output:data.source,variant:'source'}]:[]),...(data.separated||[]).map(output=>({output,variant:'separated'})),...(data.enhanced?[{output:data.enhanced,variant:'enhanced'}]:[])];
    for(const {output,variant} of entries.filter(item=>item.output)){
      const media=document.createElement('audio');media.preload='metadata';media.src=output.url;media.dataset.kind=output.kind;media.dataset.variant=variant;media.setAttribute('aria-hidden','true');
      const track={output,variant,media,level:100,lastLevel:100,muted:false,...controls.get(output.id),reported:previewed.has(output.id),audible:variant!=='source'?variant==='separated'||variant==='enhanced':true};
      all.push(track);
      if(variant==='source')source=track;
      else if(variant==='enhanced')enhanced=track;
      else separated.push(track);
      media.addEventListener('loadedmetadata',()=>{
        if(!all.includes(track))return;
        if(active().includes(track))refreshDuration();else renderTransport();
      });
      media.addEventListener('playing',()=>{if(active().includes(track))report(track);});
      media.addEventListener('ended',()=>{if(media===clock()){pause();time=duration;renderTransport();}});
      $('.cleanup-media').append(media);
    }
    host.classList.remove('hidden');refreshDuration();render();
  }
  function getState(){return {time:playing&&clock()?clock().currentTime:time,resume:playing||starting,mode};}
  function setBusy(value){if(busy===value)return;if(value)pause();busy=value;host.setAttribute('aria-busy',String(busy));render();}
  return {load,pause,play,getState,setBusy};
}
