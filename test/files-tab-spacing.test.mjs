import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Files and media tab spacing is compact on desktop and mobile', async () => {
  const css = await read('public/enhancements.css');
  assert.match(css, /\.files-page > \.page-head \{\s*margin-bottom:14px;/);
  assert.match(css, /\.files-page > \.library-tabs \{[\s\S]*padding:2px 1px 6px;[\s\S]*margin-bottom:2px;/);
  assert.match(css, /\.files-page \.file-toolbar \{[\s\S]*padding:6px 0 8px;[\s\S]*margin-bottom:6px;/);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*\.files-page > \.library-tabs \{[\s\S]*margin-bottom:0;/);
});
