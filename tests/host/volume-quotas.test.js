import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { dockerClient, demux } from '../../src/docker.js';
import { Store } from '../../src/config.js';
import { Volumes } from '../../src/volumes.js';

test('real host enforces project quotas on Docker named volumes', { timeout: 240000 }, async t => {
  if (process.platform !== 'linux') return t.skip('Host project quotas require Linux');
  const docker = dockerClient();
  await docker.ping(); // A broken Docker connection is a failure, not unsupported storage.
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-host-quotas-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).load();
  // Isolate test state and avoid the normal allocator's initial project IDs.
  store.volumeQuotas.next_project = randomInt(1500000000, 2000000000);
  const manager = new Volumes(docker, store, { enabled: true });
  const support = await manager.capabilities();
  if (!support.available) return t.skip(`Host project quotas unavailable: ${support.reason}`);
  if (support.capacity.available_bytes < 64 * 1048576) return t.skip('Host quota test needs at least 64 MiB of unallocated capacity');

  const image = process.env.QUOTA_TEST_IMAGE || 'node:24-alpine';
  await new Promise((resolve, reject) => docker.pull(image, (error, stream) => {
    if (error) return reject(error);
    docker.modem.followProgress(stream, error => error ? reject(error) : resolve());
  }));
  const name = `agent-quota-test-${randomUUID()}`;
  let created = false;
  t.after(async () => { if (created) await manager.change('DELETE', { name }); });

  async function writeTo(mebibytes) {
    const container = await docker.createContainer({
      Image: image,
      Cmd: ['node', '-e', `
        const fs = require('node:fs');
        const file = fs.openSync('/quota/payload', 'a');
        let code = null;
        try {
          const chunk = Buffer.alloc(1048576, 1);
          while (fs.fstatSync(file).size < ${mebibytes} * 1048576) {
            fs.writeSync(file, chunk);
            fs.fsyncSync(file);
          }
        } catch (error) { code = error.code; }
        const bytes = fs.fstatSync(file).size;
        fs.closeSync(file);
        console.log(JSON.stringify({code, bytes}));
      `],
      HostConfig: { NetworkMode: 'none', Mounts: [{ Type: 'volume', Source: name, Target: '/quota' }] }
    });
    try {
      await container.start();
      const result = await container.wait();
      const output = demux(await container.logs({ stdout: true, stderr: true })).toString();
      assert.equal(result.StatusCode, 0, output);
      return JSON.parse(output.trim());
    } finally { await container.remove({ force: true }); }
  }

  await manager.change('POST', { name, max_size: 16 });
  created = true;
  const volume = await docker.getVolume(name).inspect();
  assert.equal(volume.Driver, 'local');
  assert.ok(!volume.Options || Object.keys(volume.Options).length === 0);
  const limited = await writeTo(24);
  assert.equal(limited.code, 'EDQUOT', `Expected project quota enforcement: ${JSON.stringify(limited)}`);
  assert.ok(limited.bytes > 0 && limited.bytes <= 16 * 1048576);
  assert.ok((await manager.list()).Volumes.find(v => v.Name === name).usage_bytes > 0);
  await assert.rejects(manager.change('PUT', { name, max_size: 1 }), /below current storage usage/);
  await manager.change('PUT', { name, max_size: 32 });
  assert.deepEqual(await writeTo(24), { code: null, bytes: 24 * 1048576 });
  await manager.change('PUT', { name, max_size: 0 });
  assert.deepEqual(await writeTo(40), { code: null, bytes: 40 * 1048576 });
  await manager.change('DELETE', { name });
  created = false;
  await assert.rejects(docker.getVolume(name).inspect(), { statusCode: 404 });
});
