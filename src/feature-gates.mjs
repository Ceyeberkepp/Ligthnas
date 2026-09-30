import { readFile } from 'node:fs/promises';

export const FEATURE_GATES_FILE = process.env.LIGHTNAS_FEATURE_GATES_FILE || '/etc/lightnas/feature-gates.json';

export const KNOWN_FEATURES = Object.freeze([
  'advanced-backups',
  'replication',
  'multi-node',
  'enterprise-storage',
  'sso',
  'audit-export',
  'advanced-analytics',
  'priority-support',
  'branding',
  'gpu-passthrough'
]);

const DEFAULT_STATE = Object.freeze({
  edition: 'community-preview',
  enforce: false,
  features: Object.fromEntries(KNOWN_FEATURES.map(key => [key, true]))
});

export async function featureGateState() {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(FEATURE_GATES_FILE, 'utf8'));
  } catch {}

  const requested = parsed?.features && typeof parsed.features === 'object' && !Array.isArray(parsed.features)
    ? parsed.features
    : {};

  const features = Object.fromEntries(KNOWN_FEATURES.map(key => [
    key,
    requested[key] === undefined ? true : Boolean(requested[key])
  ]));

  return {
    edition: typeof parsed?.edition === 'string' && parsed.edition.trim()
      ? parsed.edition.trim().slice(0, 64)
      : DEFAULT_STATE.edition,
    // IMPORTANT: paid-feature enforcement intentionally remains OFF for the
    // current LightNAS builds. This lets the UI/backend be wired now without
    // unexpectedly locking existing users out of anything.
    enforce: parsed?.enforce === true,
    features
  };
}

export async function featureAllowed(feature) {
  const state = await featureGateState();
  if (!KNOWN_FEATURES.includes(feature)) return true;
  if (!state.enforce) return true;
  return state.features[feature] !== false;
}

export async function requireFeature(feature) {
  if (await featureAllowed(feature)) return true;
  const error = new Error('This feature is not enabled for the current LightNAS edition.');
  error.status = 402;
  error.code = 'FEATURE_LOCKED';
  error.feature = feature;
  throw error;
}
