import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class JsonStore {
  constructor(path) {
    this.path = path || resolve(process.env.NAS_DATA_FILE || 'data/state.json');
    this.state = {
      config: null,
      shares: [],
      users: [],
      groups: [],
      spaces: [],
      containerPublications: [],
      smtp: null,
      security: { apiTokens: [], webhooks: [], identityProviders: [] },
      activity: []
    };
    this.writeQueue = Promise.resolve();
    this.activityListener = null;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      this.state = { ...this.state, ...parsed };
      this.state.groups ||= [];
      this.state.containerPublications ||= [];
      this.state.security = {
        apiTokens: [],
        webhooks: [],
        identityProviders: [],
        ...(this.state.security || {})
      };
      this.state.security.apiTokens ||= [];
      this.state.security.webhooks ||= [];
      this.state.security.identityProviders ||= [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.state;
  }

  setActivityListener(listener) {
    this.activityListener = typeof listener === 'function' ? listener : null;
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writeQueue;
  }

  addActivity(type, message, severity = 'info') {
    const event = {
      id: crypto.randomUUID(),
      type,
      message,
      severity,
      timestamp: new Date().toISOString()
    };
    this.state.activity.unshift(event);
    this.state.activity = this.state.activity.slice(0, 100);
    if (this.activityListener) queueMicrotask(() => Promise.resolve(this.activityListener(event)).catch(() => {}));
    return event;
  }
}
