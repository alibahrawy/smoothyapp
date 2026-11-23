// Runs in an isolated Python environment; never sends user media to a server.
export const AUDIO_WORKER = String.raw`
import os, sys, json, logging, shutil, time, inspect, math
def message(text):
    print('SMOOTHY_PROGRESS:' + text, flush=True)

message('Starting local audio engine…')
os.environ['OMP_NUM_THREADS'] = '4'
import torch
torch.set_num_threads(4)
from audio_separator.separator import Separator
import onnxruntime as ort

def event(text, stage, completed=None, total=None, unit=None, backend=None):
    data = {'message':text, 'stage':stage}
    if completed is not None: data['completed'] = completed
    if total is not None and total > 0: data['total'] = total
    if unit: data['unit'] = unit
    if backend: data['backend'] = backend
    print('SMOOTHY_AUDIO_EVENT:' + json.dumps(data), flush=True)

# The pinned separator exposes its work loops through module-local tqdm calls.
# Count a unit only AFTER its loop body finishes. These are per-stage fractions,
# not a duration estimate or a weighted guess at overall completion.
class WorkProgress:
    def __init__(self, iterable=None, total=None, unit=None, **kwargs):
        self.iterable, self.n, self.last = iterable, 0, 0
        self.total = total if total is not None else len(iterable)
        frame = inspect.currentframe().f_back
        name = frame.f_code.co_name
        if iterable is None:
            self.text, self.stage, self.unit = 'Downloading audio model…', 'model-download', 'bytes'
        elif name == 'demix':
            match = frame.f_locals.get('is_match_mix', False)
            self.text = 'Reconstructing the recording…' if match else 'Separating voice and music…'
            self.stage, self.unit = ('reconstruct' if match else 'separate'), 'chunks'
        elif name == '_execute':
            inference = 'mask' in frame.f_locals
            self.text = 'Removing background noise…' if inference else 'Preparing audio windows…'
            self.stage, self.unit = ('denoise' if inference else 'windows'), 'windows'
        else:
            self.text, self.stage, self.unit = 'Reading audio frequency bands…', 'bands', 'bands'
        self.send(True)
    def send(self, force=False):
        now = time.monotonic()
        if force or now-self.last >= .15:
            event(self.text,self.stage,self.n,self.total,self.unit)
            self.last = now
    def __iter__(self):
        for item in self.iterable:
            yield item
            self.update(1)
        self.send(True)
    def update(self, count=1):
        self.n += count
        self.send(self.n == self.total)
    def close(self): self.send(True)

import audio_separator.separator.separator as separator_module
from audio_separator.separator.architectures import mdx_separator, vr_separator
separator_module.tqdm = mdx_separator.tqdm = vr_separator.tqdm = WorkProgress

requested = os.environ.get('SMOOTHY_AUDIO_BACKEND','cpu')
class AcceleratedSeparator(Separator):
    def __init__(self, *args, backend='cpu', music=False, **kwargs):
        self.requested, self.music, self.backend = backend, music, 'cpu'
        super().__init__(*args, **kwargs)
    def setup_torch_device(self, system_info):
        self.torch_device_cpu = torch.device('cpu')
        self.torch_device = self.torch_device_cpu
        self.torch_device_mps = None
        self.onnx_execution_provider = ['CPUExecutionProvider']
        available = ort.get_available_providers()
        if self.requested == 'cuda' and torch.cuda.is_available():
            if not self.music or 'CUDAExecutionProvider' in available:
                self.torch_device = torch.device('cuda')
                self.onnx_execution_provider = ['CUDAExecutionProvider','CPUExecutionProvider']
                self.backend = 'cuda'
        elif self.requested == 'mps' and torch.backends.mps.is_available():
            if not self.music or 'CoreMLExecutionProvider' in available:
                self.torch_device_mps = torch.device('mps')
                self.torch_device = self.torch_device_mps
                self.onnx_execution_provider = ['CoreMLExecutionProvider','CPUExecutionProvider']
                self.backend = 'mps'
        elif self.requested == 'directml' and sys.platform == 'win32':
            import torch_directml
            if torch_directml.is_available() and (not self.music or 'DmlExecutionProvider' in available):
                devices = range(torch_directml.device_count())
                # Prefer AMD over an integrated adapter. ONNX DML uses the same DXGI index.
                device = next((i for i in devices if any(v in torch_directml.device_name(i).lower() for v in ['amd','radeon'])),torch_directml.default_device())
                # MDX STFT uses complex tensors: keep that transform on CPU; run
                # the neural model on DirectML. VR's real-valued model uses DML.
                if not self.music: self.torch_device = torch_directml.device(device)
                self.onnx_execution_provider = [('DmlExecutionProvider',{'device_id':device}),'CPUExecutionProvider']
                self.backend = 'directml'
        if self.backend != 'cpu':
            torch.ones(1).to(self.torch_device).cpu()

original_session = ort.InferenceSession
def checked_session(*args, **kwargs):
    providers = kwargs.get('providers',[])
    names = [p[0] if isinstance(p,tuple) else p for p in providers]
    if 'DmlExecutionProvider' in names:
        options = kwargs.get('sess_options') or ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        kwargs['sess_options'] = options
    session = original_session(*args, **kwargs)
    gpu = next((p for p in names if p != 'CPUExecutionProvider'),None)
    if gpu and gpu not in session.get_providers():
        raise RuntimeError('The requested GPU provider could not initialize.')
    return session
ort.InferenceSession = checked_session

mode, source, output, cache = sys.argv[1:5]
if mode not in ['prepare', 'denoise', 'separate', 'isolate', 'enhance']:
    raise SystemExit('Unknown audio mode.')
options = {}
if len(sys.argv) >= 6 and sys.argv[5]:
    if sys.argv[5].startswith('{'):
        try:
            parsed = json.loads(sys.argv[5])
            if isinstance(parsed, dict):
                options = parsed
        except Exception:
            options = {}
    else:
        options = {'separatedSpeech': sys.argv[5]}
aggression = max(1, min(20, int(options.get('aggression', 5))))
if mode != 'prepare':
    # Missing cache must request explicit setup, never fetch during a media run.
    import requests
    def offline(*args, **kwargs):
        raise RuntimeError('Audio model cache is incomplete. Run audio engine setup again.')
    requests.sessions.Session.request = offline

def separate(filename, model, folder, backend=None):
    os.makedirs(folder, exist_ok=True)
    is_music = model.endswith('.onnx')
    backend = backend or requested
    try:
        engine = AcceleratedSeparator(backend=backend, music=is_music, output_dir=folder, model_file_dir=cache, output_format='WAV',
        log_level=logging.WARNING, normalization_threshold=0.99,
        mdx_params={'hop_length':1024, 'segment_size':256, 'overlap':0.25, 'batch_size':1, 'enable_denoise':False},
        vr_params={'batch_size':1, 'window_size':512, 'aggression':aggression, 'enable_tta':False, 'enable_post_process':False, 'post_process_threshold':0.2, 'high_end_process':False})
        message('Loading voice & music separation model…' if is_music else 'Loading noise removal model…')
        engine.load_model(model)
        labels = {'cpu':'CPU','cuda':'NVIDIA CUDA','directml':'Windows DirectML','mps':'Apple Metal'}
        event('Using '+labels[engine.backend]+'.','device',backend=engine.backend)
        message('Separating voice and music…' if is_music else 'Removing background noise…')
        engine.separate(filename, custom_output_names={engine.model_instance.primary_stem_name:'primary', engine.model_instance.secondary_stem_name:'secondary'})
        event('Processed with '+labels[engine.backend]+'.','device',backend=engine.backend)
        return {engine.model_instance.primary_stem_name:os.path.join(folder,'primary.wav'), engine.model_instance.secondary_stem_name:os.path.join(folder,'secondary.wav')}
    except Exception:
        if backend == 'cpu': raise
        # Retry within the accepted run, with no downloads or extra usage event.
        message('GPU processing could not finish. Retrying on CPU…')
        shutil.rmtree(folder,ignore_errors=True)
        return separate(filename,model,folder,'cpu')

if mode == 'prepare':
    # Download weights/metadata during explicit setup, so processing works offline.
    engine = AcceleratedSeparator(output_dir=output, model_file_dir=cache, log_level=logging.WARNING)
    for model in ['UVR-DeNoise-Lite.pth','UVR-MDX-NET-Inst_HQ_3.onnx']:
        message('Downloading and checking audio model…')
        engine.load_model(model)
    sys.exit(0)

def pick_clean_stem(stems):
    return next(filename for label,filename in stems.items() if label.lower() in ['no noise','no_noise','vocals'])

def pair(primary_source, primary_file, primary_label, primary_kind, rest_file, rest_label, rest_kind, progress_text):
    # The two published tracks always reconstruct the original recording exactly
    # (primary + residual = original), preserving sample-accurate length for video
    # lip-sync and enabling instant real-time dry/wet strength blending.
    import numpy as np
    import soundfile as sf
    primary_path = os.path.join(output, primary_file)
    rest_path = os.path.join(output, rest_file)
    message(progress_text)
    with sf.SoundFile(source) as original, sf.SoundFile(primary_source) as clean_src:
        if original.samplerate != clean_src.samplerate or original.channels != clean_src.channels:
            raise RuntimeError('The processed track format does not match the recording.')
        with sf.SoundFile(primary_path,'w',samplerate=original.samplerate,channels=original.channels,subtype='FLOAT') as primary_out, sf.SoundFile(rest_path,'w',samplerate=original.samplerate,channels=original.channels,subtype='FLOAT') as rest_out:
            completed, total, last = 0, math.ceil(original.frames/65536), time.monotonic()
            event(progress_text,'tracks',0,total,'blocks')
            while True:
                block = original.read(65536,dtype='float32',always_2d=True)
                if not len(block): break
                part = clean_src.read(len(block),dtype='float32',always_2d=True)
                if len(part) < len(block): part = np.pad(part,((0,len(block)-len(part)),(0,0)))
                primary_out.write(part)
                rest_out.write(block-part)
                completed += 1
                if completed == total or time.monotonic()-last >= .15:
                    event(progress_text,'tracks',completed,total,'blocks')
                    last = time.monotonic()
    return [{'label':primary_label,'kind':primary_kind,'path':primary_path},{'label':rest_label,'kind':rest_kind,'path':rest_path}]

items=[]
if mode == 'denoise':
    stems = separate(source,'UVR-DeNoise-Lite.pth',os.path.join(output,'noise'))
    clean = pick_clean_stem(stems)
    items = pair(clean,'clean.wav','Clean audio','speech','noise.wav','Removed noise','noise','Preparing cleaned audio and noise tracks…')
elif mode == 'separate':
    stems = separate(source,'UVR-MDX-NET-Inst_HQ_3.onnx',os.path.join(output,'music'))
    items = pair(stems['Vocals'],'speech.wav','Voice','speech','music.wav','Music','music','Preparing voice and music tracks…')
elif mode in ['isolate', 'enhance']:
    reused = options.get('separatedSpeech')
    if isinstance(reused, str) and reused and os.path.isfile(reused):
        voice_input = reused
    else:
        message('Step 1 of 2: Separating voice from music…')
        music_stems = separate(source,'UVR-MDX-NET-Inst_HQ_3.onnx',os.path.join(output,'music'))
        voice_input = music_stems['Vocals']
        message('Step 2 of 2: Removing background noise…')
    noise_stems = separate(voice_input,'UVR-DeNoise-Lite.pth',os.path.join(output,'noise'))
    clean = pick_clean_stem(noise_stems)
    items = pair(clean,'speech.wav','Clean voice','speech','background.wav','Music & noise','background','Preparing clean voice and background tracks…')

order = {'speech':0,'noise':1,'music':1,'background':1}
with open(os.path.join(output,'result.json'),'w',encoding='utf8') as handle:
    json.dump(sorted(items,key=lambda item: order.get(item['kind'], 2)),handle)
`;
