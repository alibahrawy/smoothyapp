// Parse real local fixtures through native Electron and packaged dependencies; no network.
const { app }=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-chat-parser-ui-')));
app.whenReady().then(async()=>{try{
 const root=path.resolve(__dirname,'..'),packageFile=process.env.CHAT_PACKAGE_ASAR;
 const required=packageFile?createRequire(packageFile+'/package.json'):createRequire(path.join(root,'package.json'));
 const bundle=require('esbuild').buildSync({entryPoints:[path.join(root,'src/main/chat-attachments.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['sharp','unpdf','mammoth','adm-zip']});
 const module={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(module,module.exports,required);
 const folder=fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('smoothy-chat-files-')&&fs.existsSync(path.join(os.tmpdir(),name,'brief.docx'))).map(name=>path.join(os.tmpdir(),name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];assert.ok(folder,'Run real file tests first');
 for(const [name,type,text] of [['notes.txt','text','Local notes'],['brief.pdf','text','A PDF brief'],['brief.docx','text','A Word brief'],['picture.png','image']]){const result=await module.exports.readChatAttachment(path.join(folder,name));assert.equal(result.type,type);if(text)assert.ok(result.text.includes(text));else assert.ok(result.data.startsWith('data:image/jpeg;base64,'));}
 console.log('Native Electron real TXT/PDF/DOCX/image parsers passed'+(packageFile?' with dependencies loaded from final ASAR.':'.'));app.exit(0);
}catch(error){console.error(error);app.exit(1);}});
