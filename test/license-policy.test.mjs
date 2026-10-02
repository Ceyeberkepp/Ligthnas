import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('repository declares the development and community evaluation license', async () => {
  const [license, pkg, readme, app, module] = await Promise.all([
    read('LICENSE'),
    read('package.json'),
    read('README.md'),
    read('public/app.js'),
    read('src/license.mjs')
  ]);

  assert.match(license, /THIS IS NOT AN OPEN-SOURCE LICENSE/);
  assert.match(license, /development and early testing only/i);
  assert.match(license, /Enterprise and commercial users must obtain a separate paid license/i);
  assert.match(license, /Future Open-Source Release/);

  assert.equal(JSON.parse(pkg).license, 'SEE LICENSE IN LICENSE');
  assert.match(readme, /current source is \*\*not open source\*\*/i);
  assert.match(readme, /Default.*5 GiB|development and early testing/i);

  assert.match(app, /Development & Community Evaluation License/);
  assert.match(app, /Production, enterprise, commercial, hosting, managed-service/);

  assert.match(module, /licenseName: 'LightNAS Development and Community Evaluation License'/);
  assert.match(module, /productionAllowed: paidProduction/);
  assert.match(module, /enterpriseUseAllowed:/);
});
