// Sync the server's allowlisted budget chat models into the standalone desktop source.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, '../web/src/lib/chat-catalog.json');
const target = path.join(root, 'src/shared/chat-catalog.json');
fs.copyFileSync(source, target);
console.log('Synced budget chat models and conversation limits.');

fs.copyFileSync(path.resolve(root, "../web/src/lib/chat-validation.ts"), path.join(root, "src/shared/chat-validation.ts"));
fs.copyFileSync(path.resolve(root, "../web/src/lib/chat-writing.json"), path.join(root, "src/shared/chat-writing.json"));
