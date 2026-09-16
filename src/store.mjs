import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class JsonStore {
  constructor(path) {
    this.path = path || resolve(process.env.NAS_DATA_FILE || 'data/state.json');
    this.state = {
      config: null,
      shares: [],
      activity: []
    };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      this.state = { ...this.state, ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.state;
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
    this.state.activity.unshift({
      id: crypto.randomUUID(),
      type,
      message,
      severity,
      timestamp: new Date().toISOString()
    });
    this.state.activity = this.state.activity.slice(0, 100);
  }
}
