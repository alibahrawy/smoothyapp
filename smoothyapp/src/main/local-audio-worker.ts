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
            self.text = 'Enhancing speech…' if inference else 'Preparing speech windows…'
            self.stage, self.unit = ('enhance' if inference else 'windows'), 'windows'
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
if mode not in ['prepare', 'separate', 'enhance']:
    raise SystemExit('Unknown audio mode.')
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
        vr_params={'batch_size':1, 'window_size':512, 'aggression':5, 'enable_tta':False, 'enable_post_process':False, 'post_process_threshold':0.2, 'high_end_process':False})
        message('Loading music separation model…' if is_music else 'Loading noise removal model…')
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

def pair(speech):
    # The two published tracks always reconstruct the recording: Speech is the
    # model's voice, and Music carries everything else — music, room and removed
    # noise. Float WAVs preserve residual peaks without clipping. Stream in blocks
    # so long recordings do not require another complete recording in memory.
    import numpy as np
    import soundfile as sf
    speech_path, music_path = os.path.join(output,'speech.wav'), os.path.join(output,'music.wav')
    message('Preparing speech and music tracks…')
    with sf.SoundFile(source) as original, sf.SoundFile(speech) as voice:
        if original.samplerate != voice.samplerate or original.channels != voice.channels:
            raise RuntimeError('The speech track format does not match the recording.')
        with sf.SoundFile(speech_path,'w',samplerate=original.samplerate,channels=original.channels,subtype='FLOAT') as clean, sf.SoundFile(music_path,'w',samplerate=original.samplerate,channels=original.channels,subtype='FLOAT') as rest:
            completed, total, last = 0, math.ceil(original.frames/65536), time.monotonic()
            event('Preparing speech and music tracks…','tracks',0,total,'blocks')
            while True:
                block = original.read(65536,dtype='float32',always_2d=True)
                if not len(block): break
                spoken = voice.read(len(block),dtype='float32',always_2d=True)
                if len(spoken) < len(block): spoken = np.pad(spoken,((0,len(block)-len(spoken)),(0,0)))
                clean.write(spoken)
                rest.write(block-spoken)
                completed += 1
                if completed == total or time.monotonic()-last >= .15:
                    event('Preparing speech and music tracks…','tracks',completed,total,'blocks')
                    last = time.monotonic()
    return [{'label':'Speech','kind':'speech','path':speech_path},{'label':'Music','kind':'music','path':music_path}]

items=[]
if mode == 'separate':
    stems=separate(source,'UVR-MDX-NET-Inst_HQ_3.onnx',os.path.join(output,'music'))
    items = pair(stems['Vocals'])
elif mode == 'enhance':
    # Reuse the accepted separation. Only the voice enters the noise remover, and
    # only the enhanced speech is published; the music and noise are not exposed.
    if len(sys.argv) < 6:
        raise SystemExit('Enhancement needs the separated speech track.')
    stems=separate(sys.argv[5],'UVR-DeNoise-Lite.pth',os.path.join(output,'noise'))
    clean=next(filename for label,filename in stems.items() if label.lower() in ['no noise','no_noise','vocals'])
    speech_path=os.path.join(output,'speech.wav')
    shutil.copyfile(clean,speech_path)
    items=[{'label':'Enhanced speech','kind':'speech','path':speech_path}]
with open(os.path.join(output,'result.json'),'w',encoding='utf8') as handle:
    json.dump(sorted(items,key=lambda item: {'speech':0,'music':1}[item['kind']]),handle)
`;
