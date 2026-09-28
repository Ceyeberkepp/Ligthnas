import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('global control-center spacing is compact on desktop and mobile', async () => {
  const css = await read('public/enhancements.css');
  assert.match(css, /Global compact layout rhythm/);
  assert.match(css, /\.content \{[\s\S]*padding-top:22px;[\s\S]*padding-left:26px;/);
  assert.match(css, /\.page-head \{[\s\S]*margin-bottom:16px;/);
  assert.match(css, /\.panel \{\s*padding:17px;/);
  assert.match(css, /\.module-hero \{[\s\S]*margin-top:18px;[\s\S]*padding:22px;/);
  assert.match(css, /\.storage-workspace,[\s\S]*margin-top:14px;/);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*\.content \{[\s\S]*padding:16px 12px 96px;/);
});
