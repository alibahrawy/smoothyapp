import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
const root=new URL('..',import.meta.url).pathname,scratch=await fs.mkdtemp(path.join(os.tmpdir(),'smoothy-chat-files-'));
const bundle=await build({entryPoints:[path.join(root,'src/main/chat-attachments.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['sharp','unpdf','mammoth','adm-zip']});
const module={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));const {readChatAttachment}=module.exports;
async function write(name,bytes){const file=path.join(scratch,name);await fs.writeFile(file,bytes);return file;}
function pdf(text){const content=`BT /F1 12 Tf 20 50 Td (${text}) Tj ET`,objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];let raw='%PDF-1.4\n',offsets=[0];objects.forEach((value,i)=>{offsets.push(raw.length);raw+=`${i+1} 0 obj\n${value}\nendobj\n`;});const xref=raw.length;raw+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(raw);}
test('real local UTF-8, PDF and DOCX parsers return text with basename only; image decoding/resizing produces bounded model input',async()=>{
 assert.equal((await readChatAttachment(await write('notes.txt','Local notes 🌟'))).text,'Local notes 🌟');
 assert.match((await readChatAttachment(await write('brief.pdf',pdf('A PDF brief')))).text,/A PDF brief/);
 const zip=new AdmZip();zip.addFile('[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));zip.addFile('word/document.xml',Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A Word brief</w:t></w:r></w:p></w:body></w:document>'));
 assert.equal((await readChatAttachment(await write('brief.docx',zip.toBuffer()))).text,'A Word brief');
 const file=await readChatAttachment(await write('picture.png',await sharp({create:{width:2000,height:1000,channels:4,background:'#ff00ff80'}}).png().toBuffer()));assert.equal(file.name,'picture.png');assert.equal(file.type,'image');const bytes=Buffer.from(file.data.split(',')[1],'base64');const meta=await sharp(bytes).metadata();assert.equal(meta.width,1600);assert.equal(meta.height,800);assert.ok(bytes.length<=1024*1024);
});
test('unsupported, unreadable, binary, oversized and empty files reject without silent truncation',async()=>{
 for(const [name,bytes] of [['script.exe','binary'],['bad.pdf','not pdf'],['bad.docx','not zip'],['bad.png','not image'],['empty.txt',' '],['binary.txt',Buffer.from([0,255])],['long.txt','x'.repeat(24001)],['huge.txt',Buffer.alloc(10*1024*1024+1)]])await assert.rejects(readChatAttachment(await write(name,bytes)));
});
