// Canonical labels and honest descriptions from the webapp's Pick a Tool menu.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '../web/src/components/dashboard/toolPrefs.ts'), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, context);
fs.writeFileSync(path.join(root, 'src/shared/studio-catalog.json'), JSON.stringify(context.module.exports.ALL_TOOLS.filter(tool => tool.id !== 'shorts').map(({id,label,description}) => ({id,label,description})), null, 2) + '\n');
