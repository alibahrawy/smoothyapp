import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AUDIO_WORKER } from './local-audio-worker';
import { AUDIO_RUNTIME_VERSION, audioPackages, type AudioBackend } from './local-audio-runtime';
import { validateCaptionMediaPath } from './captions/media-input';

export type AudioMode = 'separate' | 'enhance';
export type AudioOutput = { id: string; label: string; kind: 'speech' | 'music' | 'original'; file: string; previewed?: boolean };
export type AudioProgress = string | { message: string; stage: string; completed?: number; total?: number; unit?: string; backend?: string };
type Progress = (data: AudioProgress) => void;
const canceled = () => new Error('Canceled');
export function runAudioCommand(command: string, args: string[], signal: AbortSignal, progress: Progress, env = process.env): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());
      } else child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    // Keep stdout/stderr lines separate: a partial engine log must not swallow a status message.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-6000); });
      createInterface({input:stream,crlfDelay:Infinity}).on('line',line=>{
        if (line.startsWith('SMOOTHY_PROGRESS:')) progress(line.slice(17));
        else if (args[0] === '-m' && args[1] === 'pip' && /^Progress \d+ of \d+$/.test(line)) {
          const [,completed,total] = line.match(/^Progress (\d+) of (\d+)$/)!;
          progress({message:'Downloading audio runtime…',stage:'runtime-download',completed:Number(completed),total:Number(total),unit:'bytes'});
        }
        else if (args[0] === '-m' && args[1] === 'pip' && line.startsWith('Installing collected packages:')) progress('Installing downloaded audio packages…');
        else if (line.startsWith('SMOOTHY_AUDIO_EVENT:')) {
          try {
            const data = JSON.parse(line.slice(20));
            if (typeof data.message !== 'string' || typeof data.stage !== 'string') return;
            const value: Exclude<AudioProgress,string> = {message:data.message.slice(0,300),stage:data.stage.slice(0,60)};
            if (Number.isFinite(data.completed) && data.completed >= 0) value.completed = data.completed;
            if (Number.isFinite(data.total) && data.total > 0) value.total = data.total;
            if (typeof data.unit === 'string') value.unit = data.unit.slice(0,20);
            if (['cpu','cuda','directml','mps'].includes(data.backend)) value.backend = data.backend;
            progress(value);
          } catch { /* A malformed engine line cannot break processing. */ }
        }
      });
    }
    const cleanup = () => { signal.removeEventListener('abort', stop); if (killTimer) clearTimeout(killTimer); };
    child.once('error', error => { cleanup(); reject(signal.aborted ? canceled() : error); });
    child.once('close', code => { cleanup(); signal.aborted ? reject(canceled()) : code === 0 ? resolve(tail) : reject(new Error(`Audio engine failed (${code}). ${tail.slice(-1800)}`)); });
    if (signal.aborted) stop();
  });
}

export class LocalAudioService {
  private active?: AbortController;
  private outputs = new Map<string, AudioOutput>();
  private sources = new Map<string, AudioOutput>();
  private separated = new Map<string, AudioOutput[]>();
  private session?: string;
  private ready = false;
  private comparison?: AudioOutput;
  private backend: AudioBackend = 'cpu';
  private target?: Promise<AudioBackend>;
  private located = false;
  constructor(private deps: { root: string; ffmpeg: string; track: (id: string) => void; run?: typeof runAudioCommand; backend?: () => Promise<AudioBackend> }) {}
  private get python() { return path.join(this.deps.root, 'runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  private get worker() { return path.join(this.deps.root, 'worker.py'); }
  private get models() { return path.join(this.deps.root, 'models'); }
  private get env() { const env: NodeJS.ProcessEnv = { ...process.env, SMOOTHY_AUDIO_BACKEND: this.backend, PYTORCH_ENABLE_MPS_FALLBACK:'1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PATH: `${path.dirname(this.deps.ffmpeg)}${path.delimiter}${process.env.PATH || ''}` }; delete env.AUDIO_SEPARATOR_MODEL_DIR; return env; }
  private async run(command: string, args: string[], signal: AbortSignal, progress: Progress) {
    try { return await (this.deps.run || runAudioCommand)(command, args, signal, progress, this.env); }
    catch (error: any) {
      if (error?.code === 'ENOENT' && command === this.deps.ffmpeg) throw new Error('The audio decoder (FFmpeg) is missing. Reinstall SmoothyEdit to restore it, then try again.');
      if (error?.code === 'ENOENT' && command === this.python) throw new Error('The local audio engine is missing. Use Repair audio engine, then try again.');
      throw error;
    }
  }
  private track(id: string) { try { this.deps.track(id); } catch {} }
  private async exclusive<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Wait for the current audio operation to finish.');
    const controller = new AbortController(); this.active = controller;
    try { return await action(controller.signal); } finally { if (this.active === controller) this.active = undefined; }
  }
  cancel() { this.active?.abort(); }
  private desiredBackend() { return this.target ||= (this.deps.backend?.() || Promise.resolve('cpu' as AudioBackend)).catch(() => 'cpu' as AudioBackend); }
  private async locateRuntime(signal = new AbortController().signal, progress: Progress = () => {}) {
    if (this.located || process.platform !== 'win32') return;
    try { await fs.access(this.python); } catch { return; }
    // Resolve the executable itself: MSIX may virtualize files while leaving
    // their parent-directory names unchanged. Use the same root after restart.
    const resolved = (await this.run(this.python,['-c','from pathlib import Path; import sys; print("SMOOTHY_AUDIO_ROOT:" + str(Path(sys.executable).resolve().parents[2]))'],signal,progress)).split(/\r?\n/).find(line=>line.startsWith('SMOOTHY_AUDIO_ROOT:'))?.slice(19).trim();
    if (resolved && path.isAbsolute(resolved)) {
      await fs.access(path.join(resolved,'runtime','Scripts','python.exe'));
      this.deps.root = resolved;
    }
    this.located = true;
  }
  async state() {
    await this.locateRuntime();
    const desired = await this.desiredBackend();
    try {
      const marker = JSON.parse(await fs.readFile(path.join(this.deps.root, 'ready-v2'),'utf8'));
      this.ready = marker.version === AUDIO_RUNTIME_VERSION && marker.backend === desired;
      if (this.ready) this.backend = marker.backend;
    } catch { this.ready = false; }
    return { ready: this.ready, busy: Boolean(this.active), backend: this.ready ? this.backend : desired };
  }
  private async folder(prefix: string) {
    if (!this.session) this.session = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'smoothy-local-audio-')));
    const folder = await fs.realpath(await fs.mkdtemp(path.join(this.session, prefix)));
    const relative = path.relative(this.session, folder);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid audio workspace.');
    return folder;
  }
  private async validateWav(file: string) {
    const info = await fs.stat(file), handle = await fs.open(file,'r'), head = Buffer.alloc(12);
    try { await handle.read(head,0,12,0); } finally { await handle.close(); }
    if (!info.isFile() || info.size <= 44 || head.toString('ascii',0,4) !== 'RIFF' || head.toString('ascii',8,12) !== 'WAVE') throw new Error('Audio engine returned an empty or invalid WAV.');
  }
  async select(file: unknown, progress: Progress = () => {}) {
    return this.exclusive(async signal => {
      const validated = await validateCaptionMediaPath(file);
      const folder = await this.folder('source-');
      try {
        progress('Preparing your original audio…');
        const wav = path.join(folder,'original.wav');
        await this.run(this.deps.ffmpeg, ['-nostdin','-v','error','-i',validated,'-map','0:a:0','-vn','-ac','2','-ar','44100','-c:a','pcm_s16le',wav],signal,progress);
        signal.throwIfAborted(); await this.validateWav(wav); signal.throwIfAborted();
        const source: AudioOutput = {id:randomUUID(),label:'Original',kind:'original',file:wav};
        // Publish only after decoding succeeds. A failed/canceled replacement keeps
        // the previous selection, outputs and comparison usable.
        this.sources.clear(); this.separated.clear(); this.sources.set(source.id,source); this.outputs.set(source.id,source);
        return {...this.publicOutput(source),name:path.basename(validated)};
      } catch (error) { await fs.rm(folder,{recursive:true,force:true}).catch(()=>{}); throw error; }
    });
  }
  async setup(progress: Progress) {
    return this.exclusive(async signal => {
      this.ready = false;
      this.backend = await this.desiredBackend();
      await fs.mkdir(this.models, { recursive: true });
      // Windows Store filesystem redirection can make pip's resource containment
      // check reject its own wheels unless the interpreter uses the real path.
      this.deps.root = await fs.realpath(this.deps.root);
      await fs.rm(path.join(this.deps.root, 'ready-v2'), { force: true });
      progress('Preparing local audio engine. GPU runtimes can download several GB…');
      try { await fs.access(this.python); } catch {
        const candidates = [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'), 'uv'];
        let created = false;
        for (const command of candidates) {
          try { await this.run(command, ['venv', '--python', '3.12', '--seed', path.join(this.deps.root, 'runtime')], signal, progress); created = true; break; }
          catch (error: any) { if (signal.aborted) throw canceled(); if (error.code !== 'ENOENT') throw error; }
        }
        if (!created) {
          try { await this.run(process.platform === 'win32' ? 'py' : 'python3.12', process.platform === 'win32' ? ['-3.12', '-m', 'venv', path.join(this.deps.root, 'runtime')] : ['-m','venv',path.join(this.deps.root,'runtime')], signal, progress); }
          catch { if (signal.aborted) throw canceled(); throw new Error('Install Python 3.12 or uv, then retry audio engine setup.'); }
        }
      }
      await this.locateRuntime(signal,progress);
      const packages = audioPackages(this.backend,process.platform);
      const pipVersion = await this.run(this.python,['-c','import pip; print(pip.__version__)'],signal,progress);
      const pipProgress = Number.parseInt(pipVersion.trim(),10) >= 26 ? ['--progress-bar','raw'] : [];
      progress(`Installing ${this.backend === 'cuda' ? 'NVIDIA CUDA' : this.backend === 'directml' ? 'Windows DirectML' : this.backend === 'mps' ? 'Apple Metal' : 'CPU'} audio runtime…`);
      if (this.backend !== 'directml') await this.run(this.python,['-m','pip','uninstall','-y','torch-directml'],signal,progress);
      await this.run(this.python, ['-m','pip','install','--disable-pip-version-check',...pipProgress,...packages.torch, ...(packages.index ? ['--index-url',packages.index] : [])], signal, progress);
      // ORT variants share the same Python namespace. Remove old variants before
      // installing one, so switching GPU/CPU cannot leave mixed native binaries.
      await this.run(this.python,['-m','pip','uninstall','-y','onnxruntime','onnxruntime-gpu','onnxruntime-directml'],signal,progress);
      await this.run(this.python, ['-m','pip','install','--disable-pip-version-check',...pipProgress,'audio-separator==0.30.2',...packages.torch,packages.onnx,...packages.extra,'librosa==0.10.2.post1'], signal, progress);
      await fs.writeFile(this.worker, AUDIO_WORKER);
      const staging = await fs.mkdtemp(path.join(this.deps.root,'preparing-models-'));
      try {
        // Reuse previously downloaded models during the CPU→GPU migration.
        await fs.cp(this.models,staging,{recursive:true});
        await this.run(this.python, [this.worker,'prepare','',staging,staging], signal, progress);
        signal.throwIfAborted();
        await fs.rm(this.models,{recursive:true,force:true});
        await fs.rename(staging,this.models);
        await fs.writeFile(path.join(this.deps.root, 'ready-v2'), JSON.stringify({version:AUDIO_RUNTIME_VERSION,backend:this.backend})); this.ready = true;
      } finally { await fs.rm(staging,{recursive:true,force:true}).catch(()=>{}); }
      return { ready: true, backend:this.backend };
    });
  }
  async process(input: { source: string; mode: AudioMode }, progress: Progress) {
    return this.exclusive(async signal => {
      if (!['separate','enhance'].includes(input?.mode)) throw new Error('Choose speech separation or enhancement.');
      const source = this.sources.get(input?.source); if (!source) throw new Error('Choose an audio or video file first.');
      if (!(await this.state()).ready) throw new Error('Set up the audio engine first.');
      const voice = this.separated.get(source.id)?.find(output=>output.kind==='speech');
      if (input.mode === 'enhance' && !voice) throw new Error('Separate the recording before enhancing speech.');
      await this.validateWav(source.file); signal.throwIfAborted();
      if (input.mode === 'enhance') await this.validateWav(voice!.file);
      const folder = await this.folder('job-');
      try {
        const wav = source.file;
        await fs.writeFile(this.worker, AUDIO_WORKER);
        progress('Starting local audio engine…');
        await this.run(this.python,[this.worker,input.mode,wav,folder,this.models,...(input.mode === 'enhance' ? [voice!.file] : [])],signal,progress);
        signal.throwIfAborted();
        progress('Checking output tracks…');
        const results = JSON.parse(await fs.readFile(path.join(folder,'result.json'),'utf8'));
        // Separation is always exactly two tracks: voice, and everything else
        // (music plus room/noise). Enhancement publishes the cleaned voice only.
        const expected = input.mode === 'separate' ? ['speech','music'] : ['speech'];
        if (!Array.isArray(results) || results.length !== expected.length || expected.some(kind=>results.filter(result=>result.kind===kind).length!==1)) throw new Error('Audio engine returned incomplete results.');
        const outputs: AudioOutput[] = [];
        for (const result of results) {
          if (typeof result.path !== 'string' || typeof result.label !== 'string') throw new Error('Invalid audio result.');
          const file = await fs.realpath(result.path), relative = path.relative(folder,file);
          if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(file) !== '.wav') throw new Error('Invalid audio result location.');
          await this.validateWav(file);
          outputs.push({ id: randomUUID(), label: result.label.slice(0,60), kind:result.kind, file });
        }
        signal.throwIfAborted();
        outputs.forEach(output => this.outputs.set(output.id,output));
        if (input.mode === 'separate') this.separated.set(source.id,outputs);
        this.comparison = source;
        if (input.mode === 'enhance') this.track('audio_noise_remove');
        else this.track('audio_music_separate');
        return outputs.map(output=>this.publicOutput(output));
      } catch (error) { await fs.rm(folder,{recursive:true,force:true}).catch(()=>{}); throw error; }
    });
  }
  private publicOutput({id,label,kind}:AudioOutput) {return {id,label,kind,url:`smoothy-local-audio://result/${id}`};}
  original() {if(!this.comparison)throw new Error('Process audio first.');return this.publicOutput(this.comparison);}
  output(id: string) { const output = this.outputs.get(id); if (!output) throw new Error('Run the audio tool again to create this result.'); return output; }
  preview(id: string) { const output = this.output(id); if (!output.previewed) { output.previewed = true; this.track('audio_tools_preview'); } }
  async save(id: string, destination: string) {
    const output = this.output(id); const temporary = path.join(path.dirname(destination),`.smoothy-audio-${randomUUID()}.tmp`);
    try { await fs.copyFile(output.file,temporary); await fs.rename(temporary,destination); this.track('audio_tools_save'); }
    finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
  }
  async dispose() { this.cancel(); if (this.session) await fs.rm(this.session,{recursive:true,force:true}).catch(()=>{}); }
}
