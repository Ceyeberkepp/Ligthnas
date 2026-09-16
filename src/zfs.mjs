import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStorageInventory } from './system.mjs';

const execute = promisify(execFile);
const datasetName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/;
const datasetPath = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)+$/;
const compressions = new Set(['off', 'lz4', 'zstd', 'gzip']);
let pending = false;

function refuse(message, status = 400) { throw Object.assign(new Error(message), { status }); }

async function run(args) {
  if (process.env.LIGHTNAS_ZFS_ENABLED !== '1') refuse('ZFS dataset changes are disabled on this host.', 409);
  if (pending) refuse('Another ZFS dataset operation is running.', 409);
  pending = true;
  try {
    await execute('zfs', args, { timeout: 30000, maxBuffer: 64 * 1024 });
  } catch {
    refuse('ZFS operation failed. Check host permissions, available capacity and dataset properties.', 409);
  } finally { pending = false; }
}

export async function createDataset(input) {
  if (!datasetName.test(input.name || '') || !datasetPath.test(`${input.parent}/${input.name}`)) refuse('Enter a valid parent and a 2–64 character dataset name.');
  const { zfs } = await getStorageInventory();
  if (!zfs.available || !zfs.datasets.some(item => item.name === input.parent)) refuse('Choose an accessible existing ZFS pool or dataset as parent.', 409);
  const compression = input.compression || 'lz4';
  if (!compressions.has(compression)) refuse('Choose a supported compression mode.');
  const quota = Number(input.quotaGiB || 0);
  if (!Number.isInteger(quota) || quota < 0 || quota > 1048576) refuse('Quota must be 0–1048576 GiB. Zero means unlimited.');
  const fullName = `${input.parent}/${input.name}`;
  const args = ['create', '-o', `compression=${compression}`];
  if (quota) args.push('-o', `quota=${quota}G`);
  args.push(fullName);
  await run(args);
  return { name: fullName };
}

export async function updateDataset(input) {
  if (!datasetPath.test(input.name || '')) refuse('Choose a valid existing dataset name.');
  const { zfs } = await getStorageInventory();
  if (!zfs.available || !zfs.datasets.some(item => item.name === input.name) || zfs.pools.some(pool => pool.name === input.name)) refuse('Dataset not found or pool root cannot be edited here.', 409);
  if (input.property === 'compression') {
    if (!compressions.has(input.value)) refuse('Choose a supported compression mode.');
  } else if (input.property === 'quota') {
    if (input.value !== 'none' && !/^([1-9][0-9]{0,6})G$/.test(input.value || '')) refuse('Enter a quota in GiB or none.');
  } else refuse('Only compression and quota can be changed.');
  await run(['set', `${input.property}=${input.value}`, input.name]);
  return { name: input.name, property: input.property, value: input.value };
}
