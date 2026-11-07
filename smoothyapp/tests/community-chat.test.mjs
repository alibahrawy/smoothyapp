import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeRequire = createRequire(import.meta.url);

function loadCjs(code) {
  const module = { exports: {} };
  const dirname = path.join(root, 'out', 'main');
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
    module,
    module.exports,
    nodeRequire,
    dirname,
    path.join(dirname, 'index.js')
  );
  return module.exports;
}

// The lobby rules live on the web side; the desktop app follows the server.
// The standalone public app checkout has no web source; these run in the monorepo.
const webSource = path.join(root, '..', 'web', 'src', 'lib', 'community-chat.ts');
const standalone = !existsSync(webSource);
const chatTest = standalone
  ? (name) => test(name, { skip: 'Web source is in the monorepo' }, () => {})
  : test;
const chat = standalone ? {} : loadCjs(
  (
    await build({
      entryPoints: [webSource],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    })
  ).outputFiles[0].text
);

chatTest('guest names are stable, derived from the device id, and always say Guest', () => {
  const { guestNameFor, isGuestName, guestIdentity } = chat;
  const first = guestNameFor('4a2b9c1e-1111-4222-8333-444455556666');
  const second = guestNameFor('4a2b9c1e-1111-4222-8333-444455556666');
  assert.equal(first, second, 'same device keeps the same name');
  assert.match(first, /^Guest [A-Z][a-z]+ \d{2}$/);
  assert.equal(isGuestName(first), true);
  assert.equal(isGuestName('Ali'), false);
  assert.equal(isGuestName('Guest falcon 12'), false);

  const identity = guestIdentity('4a2b9c1e-1111-4222-8333-444455556666');
  assert.equal(identity.id, 'guest:4a2b9c1e-1111-4222-8333-444455556666');
  assert.equal(identity.guest, true);
  assert.equal(identity.tier, 'guest');
  assert.equal(identity.name, first);
});

chatTest('guest ids are validated, never echoed as arbitrary strings', () => {
  const { normalizeGuestId } = chat;
  assert.equal(normalizeGuestId('4A2B9C1E-1111-4222-8333-444455556666'), '4a2b9c1e-1111-4222-8333-444455556666');
  assert.equal(normalizeGuestId(''), null);
  assert.equal(normalizeGuestId('Guest Falcon 12'), null);
  assert.equal(normalizeGuestId('{userId:1}'), null);
  assert.equal(normalizeGuestId(42), null);
});

chatTest('message bodies collapse whitespace, cap lines and reject empty or oversized text', () => {
  const { sanitizeCommunityBody } = chat;
  assert.equal(sanitizeCommunityBody('  hello   there \n\n\n again  ').body, 'hello there\nagain');
  assert.equal(sanitizeCommunityBody('   \n  ').ok, false);
  assert.equal(sanitizeCommunityBody(42).ok, false);
  assert.equal(sanitizeCommunityBody('x'.repeat(501)).ok, false);
  assert.equal(sanitizeCommunityBody('x'.repeat(500)).ok, true);

  const manyLines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
  const result = sanitizeCommunityBody(manyLines);
  assert.equal(result.ok, true);
  assert.equal(result.body.split('\n').length, 8);
});

chatTest('links are removed for everyone, including members', () => {
  const { sanitizeCommunityBody } = chat;
  const samples = [
    'look at https://example.com/clip',
    'look at www.example.org',
    'look at example.tv/portfolio',
    'look at example dot com',
    'look at example[.]com',
  ];
  for (const sample of samples) {
    const result = sanitizeCommunityBody(sample);
    assert.equal(result.ok, true, sample);
    assert.match(result.body, /\[link removed\]/, sample);
    assert.equal(result.linkRemoved, true, sample);
  }
  // Not a link: a normal sentence with numbers.
  assert.equal(sanitizeCommunityBody('rendered in 4.5 seconds').body, 'rendered in 4.5 seconds');
});

chatTest('image payloads are refused, plain text is not', () => {
  const { sanitizeCommunityBody } = chat;
  for (const sample of ['data:image/png;base64,AAAA', '<img src="https://x.test/a.png">', '![alt](https://x.test/a.png)']) {
    const result = sanitizeCommunityBody(sample);
    assert.equal(result.ok, false, sample);
    assert.match(result.error, /text only/i);
  }
  assert.equal(sanitizeCommunityBody('a picture of my timeline').ok, true);
});

chatTest('strong language is masked in place, messages are not rejected', () => {
  const { sanitizeCommunityBody, maskProfanity } = chat;
  const result = sanitizeCommunityBody('this is fucking great, what the shit');
  assert.equal(result.ok, true);
  assert.equal(result.body, 'this is f****** great, what the s***');
  assert.equal(result.masked, true);
  // Word boundaries: everyday words that merely contain a fragment survive.
  assert.equal(maskProfanity('a classic masterpiece about assassins'), 'a classic masterpiece about assassins');
  // Mild swearing is left alone on purpose.
  assert.equal(maskProfanity('damn, that was close'), 'damn, that was close');
});

chatTest('display names never come from email and reserve the guest prefix', () => {
  const { memberName, sanitizeDisplayName } = chat;
  assert.equal(memberName('Very Fiey', 'user-1234'), 'Very Fiey');
  assert.equal(memberName('', 'user-1234'), 'Editor 1234');
  assert.equal(memberName(null, 'user-abcd'), 'Editor ABCD');
  assert.equal(memberName('Guest Falcon 12', 'user-1234'), 'Falcon 12');
  assert.equal(sanitizeDisplayName('  Guest  42  '), '42');
  assert.equal(sanitizeDisplayName(''), 'Editor');
  assert.equal(sanitizeDisplayName('fuckboy'), 'f******');
});

chatTest('guests get a tighter posting budget and slower pace than members', () => {
  const { messageLimitFor, minGapFor, COMMUNITY_LIMITS } = chat;
  assert.equal(messageLimitFor(true), 5);
  assert.equal(messageLimitFor(false), 20);
  assert.equal(minGapFor(true), 2000);
  assert.equal(minGapFor(false), 600);
  assert.equal(COMMUNITY_LIMITS.sessionsPerMinutePerIp, 6);
  assert.equal(COMMUNITY_LIMITS.maxFrameBytes, 8192);
});
