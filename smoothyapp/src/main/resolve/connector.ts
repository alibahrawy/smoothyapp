import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { luaString } from './handoff';

const SIGNATURE = '-- SmoothyEdit Connector v1';
// Start only from Workspace > Scripts. A resident fusion:Execute/Console loop
// occupies Fusion's shared executor and prevents other scripts from running.
export function connectorScript(mailbox: string) {
  return `${SIGNATURE}
local function attempt(fn) local ok,v=pcall(fn);if ok then return v end end
local host=resolve or attempt(function() return Resolve() end)
local prefs=fusion or fu or attempt(function() return host:Fusion() end)
if not prefs or not loadfile or not bmd or not bmd.wait or not os or not os.time then
  if print then print('[Smoothy] Connector unavailable on this Resolve build.') end;return
end
local key='Global.SmoothyEditConnectorOwnerV1'
local owner=tostring({})..tostring(os.time())
prefs:SetPrefs(key,owner)
bmd.wait(0.25)
if prefs:GetPrefs(key)~=owner then return end
if print then print('[Smoothy] Connected. Send and load timelines from Smoothy. Start this script once per Resolve session.') end
local last=''
while prefs:GetPrefs(key)==owner do
  local chunk=loadfile(${luaString(mailbox.replace(/\\/g, '/'))})
  local request=chunk and attempt(chunk)
  if type(request)=='table' and type(request.id)=='string' and request.id~=last and type(request.expires)=='number' and request.expires>=os.time() and request.expires<=os.time()+190 and type(request.run)=='function' then
    last=request.id
    local claim='Global.SmoothyEditConnectorClaimV1'
    if prefs:GetPrefs(claim)~=request.id then
      prefs:SetPrefs(claim,request.id)
      attempt(request.run)
    end
  end
  bmd.wait(0.5)
end
`;
}

export function createResolveConnector(directory: string) {
  const script = path.join(directory, 'Smoothy Connector.lua');
  const mailbox = path.join(directory, '.smoothy-connector-request.lua');
  function write(file: string, content: string, signature: string) {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || !fs.readFileSync(file, 'utf8').startsWith(signature))) throw new Error('A different file occupies the Smoothy Connector location; it was not replaced.');
    const temp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  const revoke = () => write(mailbox, SIGNATURE + '\nreturn nil\n', SIGNATURE);
  return {
    script,
    install() { write(script, connectorScript(mailbox), SIGNATURE); revoke(); },
    queue(id: string, code: string, deadline: number) {
      write(mailbox, `${SIGNATURE}\nreturn {id=${luaString(id)},expires=${Math.floor(deadline / 1000)},run=function()\n${code}\nend}\n`, SIGNATURE);
    },
    revoke
  };
}
