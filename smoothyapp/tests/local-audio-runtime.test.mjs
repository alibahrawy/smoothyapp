import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('../src/main/local-audio-runtime.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {audioBackend,audioPackages}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('hardware routing prioritizes NVIDIA on hybrid PCs, uses DirectML on Windows AMD/Intel and Metal only on Apple Silicon',()=>{
 assert.equal(audioBackend('win32','x64',[{vendorId:0x8086},{vendorId:0x10de}]),'cuda');
 assert.equal(audioBackend('win32','x64',[{vendorId:0x1002}]),'directml');
 assert.equal(audioBackend('win32','x64',[{vendorId:0x8086}]),'directml');
 assert.equal(audioBackend('darwin','arm64',[]),'mps');
 assert.equal(audioBackend('darwin','x64',[]),'cpu');
 assert.equal(audioBackend('linux','x64',[{vendorId:0x1002}]),'cpu');
 assert.equal(audioBackend('linux','x64',[{vendorId:0x10de}]),'cuda');
 assert.equal(audioBackend('win32','x64',[{vendorId:0x1414}]),'cpu');
});

test('backend packages keep one ORT provider and compatible CUDA/DirectML Torch families',()=>{
 const cuda=audioPackages('cuda','win32'),amd=audioPackages('directml','win32'),mac=audioPackages('mps','darwin');
 assert.ok(cuda.torch.every(name=>name.endsWith('+cu124')));
 assert.ok(amd.torch.includes('torch==2.4.1'));assert.ok(amd.extra.includes('torch-directml==0.2.5.dev240914'));
 assert.equal(amd.onnx,'onnxruntime-directml==1.20.1');
 assert.equal(mac.index,null);assert.equal(mac.onnx,'onnxruntime==1.20.1');
});
