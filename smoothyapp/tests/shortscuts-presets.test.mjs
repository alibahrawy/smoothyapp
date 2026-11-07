import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL('../src/main/shortscuts/premiere-presets.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['@xmldom/xmldom'],
});
const module = { exports: {} };
new Function('module', 'exports', 'require', output.outputFiles[0].text)(module, module.exports, nodeRequire);
const { parsePremierePresetXmlForTest } = module.exports;

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <BinTreeItem ObjectID="1"><TreeItemBase><Name>Root</Name></TreeItemBase><Items><Item Index="0" ObjectRef="2"/></Items></BinTreeItem>
  <BinTreeItem ObjectID="2"><TreeItemBase><Name>Presets</Name></TreeItemBase><Items><Item Index="0" ObjectRef="3"/></Items></BinTreeItem>
  <BinTreeItem ObjectID="3"><TreeItemBase><Name>My Folder</Name></TreeItemBase><Items><Item Index="0" ObjectRef="4"/></Items></BinTreeItem>
  <TreeItem ObjectID="4"><TreeItemBase><Data ObjectRef="5"/><Name>My Animated Look</Name></TreeItemBase></TreeItem>
  <FilterPresetItem ObjectID="5"><FilterPresets><FilterPreset ObjectRef="6"/></FilterPresets></FilterPresetItem>
  <FilterPreset ObjectID="6"><FilterMatchName>AE.ADBE Geometry2</FilterMatchName><Component ObjectRef="7"/></FilterPreset>
  <VideoFilterComponent ObjectID="7"><VideoFilterType>2</VideoFilterType><Component Version="7"><DisplayName>Transform</DisplayName><Params><Param Index="0" ObjectRef="8"/></Params></Component><MatchName>AE.ADBE Geometry2</MatchName></VideoFilterComponent>
  <VideoComponentParam ObjectID="8"><Name>Position</Name><CurrentValue>0.5:0.5</CurrentValue><Keyframes>0,0.5:0.5,0,0;254016000000,0.5:0.7,0,0;</Keyframes><IsTimeVarying>true</IsTimeVarying></VideoComponentParam>
</PremiereData>`;

const staticFixture = fixture
  .replace('<Name>My Animated Look</Name>', '<Name>My Static Look</Name>')
  .replace('<Keyframes>0,0.5:0.5,0,0;254016000000,0.5:0.7,0,0;</Keyframes>', '<Keyframes></Keyframes>')
  .replace('<IsTimeVarying>true</IsTimeVarying>', '<IsTimeVarying>false</IsTimeVarying>')
  .replace('<CurrentValue>0.5:0.5</CurrentValue>', '<CurrentValue>0.5:0.5</CurrentValue>');

test('Premiere .prfpset parser reads bins, effects, static values and keyframes', () => {
  const parsed = parsePremierePresetXmlForTest(fixture, '/tmp/Effect Presets and Custom Items.prfpset');
  assert.equal(parsed.summaries.length, 1);
  const summary = parsed.summaries[0];
  assert.equal(summary.name, 'My Animated Look');
  assert.match(summary.folder, /My Folder/);
  assert.equal(summary.animated, true);
  assert.equal(summary.mediaType, 'video');
  assert.equal(summary.components, 1);
  const full = parsed.full.get(summary.id);
  assert.ok(full);
  assert.equal(full.preset.components[0].displayName, 'Transform');
  assert.equal(full.preset.components[0].matchName, 'AE.ADBE Geometry2');
  const prop = full.preset.components[0].properties[0];
  assert.equal(prop.name, 'Position');
  assert.deepEqual(prop.value, [0.5, 0.5]);
  assert.equal(prop.keyframes.length, 2);
  assert.deepEqual(prop.keyframes[0], { time: 0, value: [0.5, 0.5] });
  assert.deepEqual(prop.keyframes[1], { time: 254016000000, value: [0.5, 0.7] });
});

test('Premiere .prfpset parser marks static presets as not animated', () => {
  const parsed = parsePremierePresetXmlForTest(staticFixture, '/tmp/Effect Presets and Custom Items.prfpset');
  assert.equal(parsed.summaries.length, 1);
  assert.equal(parsed.summaries[0].animated, false);
  assert.equal(parsed.summaries[0].name, 'My Static Look');
  const full = parsed.full.get(parsed.summaries[0].id);
  assert.equal(full.preset.components[0].properties[0].keyframes, undefined);
});

test('Premiere .prfpset parser rejects malformed XML without throwing', () => {
  const parsed = parsePremierePresetXmlForTest('<PremiereData><not-closed>', '/tmp/broken.prfpset');
  assert.deepEqual(parsed.summaries, []);
  assert.ok(parsed.errors.length >= 1);
});
