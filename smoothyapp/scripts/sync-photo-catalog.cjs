// Keep the desktop's models, ratios and all reaction prompts identical to the webapp.
// Run from the monorepo after changing dashboard/lib.ts; generated JSON ships in the public app repo.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '../web/src/components/dashboard/lib.ts'), 'utf8');
const code = transformSync(source.slice(source.indexOf('export const IMAGE_MODELS =')), { loader: 'ts', format: 'cjs' }).code;
const context = { module: { exports: {} } }; vm.runInNewContext(code, context);
const data = context.module.exports;
// Estimates for chat-based images must follow SmoothyEdit's existing token billing,
// not a different provider image tariff. This is display data, never a debit.
const pricingSource = fs.readFileSync(path.join(root, '../web/src/lib/model-pricing.ts'), 'utf8');
const pricingContext = { module: { exports: {} } };
vm.runInNewContext(transformSync(pricingSource, { loader: 'ts', format: 'cjs' }).code, pricingContext);
data.IMAGE_TOKEN_PRICING = Object.fromEntries(data.IMAGE_MODELS.filter(model => data.MODEL_CAPABILITIES[model.id].api !== 'images').map(model => [model.id, pricingContext.module.exports.MODEL_PRICING[model.id]]));
const keys = ['IMAGE_MODELS', 'DEFAULT_IMAGE_MODEL', 'ASPECT_RATIOS', 'DEFAULT_ASPECT_RATIO', 'IMAGE_SIZES', 'DEFAULT_IMAGE_SIZE', 'MODEL_CAPABILITIES', 'IMAGE_MODEL_DESCRIPTIONS', 'IMAGE_TOKEN_PRICING', 'VERTICAL_THUMBNAIL_PROMPT', 'REACTION_PRESETS'];
fs.mkdirSync(path.join(root, 'src/shared'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/shared/photo-catalog.json'), JSON.stringify(Object.fromEntries(keys.map(key => [key, data[key]])), null, 2) + '\n');
console.log(`Synced ${data.IMAGE_MODELS.length} image models and ${data.REACTION_PRESETS.length} reaction presets.`);
