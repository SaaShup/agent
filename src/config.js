import { readFile, mkdir, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { initialAccess, policy } from './access-control.js';
export const defaults = { netbox_url: '', netbox_token: '', ui: 1, id: '', endpoint: '', flows: '0' };
async function sync(filename) {
  const handle = await open(filename, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export class Store {
  constructor(directory = process.env.DATAPATH || '/data') { this.directory = directory; this.config = { ...defaults }; this.registries = []; this.volumeQuotas = { next_project: 1000000, volumes: {} }; this.accessControl = initialAccess(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    for (const [key, file] of [['config', 'config.js'], ['registries', 'registries.js'], ['volumeQuotas', 'volume-quotas.json'], ['accessControl', 'access-control.json']]) {
      try { this[key] = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`Invalid JSON in ${file}`, { cause: error }); }
    }
    this.config = { ...defaults, ...this.config, flows: '0' };
    this.accessControl = policy(this.accessControl);
    if (process.env.NETBOX_URL) this.config.netbox_url = process.env.NETBOX_URL;
    return this;
  }
  async save() {
    // Serialize writes to prevent concurrent webhook/persistence races.
    this.pending = (this.pending || Promise.resolve()).catch(() => {}).then(async () => {
      for (const [key, file] of [['config', 'config.js'], ['registries', 'registries.js'], ['volumeQuotas', 'volume-quotas.json'], ['accessControl', 'access-control.json']]) {
        const target = path.join(this.directory, file);
        await writeFile(`${target}.tmp`, JSON.stringify(this[key], null, 2), { mode: 0o600 });
        if (key === 'volumeQuotas') await sync(`${target}.tmp`);
        await rename(`${target}.tmp`, target);
        if (key === 'volumeQuotas') await sync(this.directory);
      }
    });
    return this.pending;
  }
}
