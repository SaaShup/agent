import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { Store } from '../../src/config.js';
import { Agent } from '../../src/agent.js';
import { createServer } from '../../src/server.js';
const authorization = 'Basic ' + Buffer.from('admin:saashup').toString('base64');
async function fixture(t) {
  const directory = await mkdtemp('/tmp/agent-acl-');
  const store = await new Store(directory).load();
  const streams = [];
  const docker = { listContainers: async () => [{ Id: 'abc', State: 'running' }], getContainer: () => ({ exec: async () => ({ start: async () => { const stream = new PassThrough(); streams.push(stream); return stream; } }) }) };
  const agent = { docker, store, enqueue: () => {} };
  const server = createServer(agent);
  let peer = '198.51.100.10';
  const setPeer = req => Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: peer });
  // Simulate public peers while keeping all test network traffic on localhost.
  server.prependListener('request', setPeer); server.prependListener('upgrade', setPeer);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeTerminals(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const stream of streams) stream.destroy(); await rm(directory, { recursive: true, force: true }); });
  function request(path = '/admin/access-control', method = 'GET', data, headers = { authorization }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, agent: false, headers }, res => {
        let raw = ''; res.on('data', data => raw += data); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
      }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  return { agent, store, server, request, setPeer: value => { peer = value; } };
}
const rules = (entries, extra = {}) => ({ enabled: true, allowed_ips: entries, ...extra });

test('access settings require authentication, validate input, persist, and enforce peer IP without trusting forwarding headers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(undefined, 'GET', undefined, {})).status, 401);
  assert.equal((await f.request()).body.current_ip, '198.51.100.10');
  assert.equal((await f.request(undefined, 'POST')).status, 405);
  assert.equal((await f.request(undefined, 'PUT', rules(['bad']))).status, 400);
  assert.equal((await f.request(undefined, 'PUT', rules([]))).status, 409);
  assert.equal((await f.request(undefined, 'PUT', rules(['198.51.100.10']), { authorization, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request(undefined, 'PUT', rules(['198.51.100.10', '2001:db8::/64']))).status, 200);
  const saved = await new Store(f.store.directory).load();
  assert.equal(saved.accessControl.enabled, true);
  assert.deepEqual(saved.accessControl.allowed_ips, ['198.51.100.10', '2001:db8::/64']);
  assert.equal(JSON.parse(await readFile(`${f.store.directory}/access-control.json`)).enabled, true);
  f.setPeer('203.0.113.5');
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request(undefined, 'GET', undefined, { authorization, 'x-forwarded-for': '198.51.100.10' })).status, 403);
  f.setPeer('2001:db8::1'); assert.equal((await f.request()).status, 200);
  f.setPeer('127.0.0.1'); assert.equal((await f.request()).status, 200);
  assert.equal((await f.request(undefined, 'PUT', rules([]))).status, 200);
  f.setPeer('198.51.100.10'); assert.equal((await f.request()).status, 403);
});

test('registration bootstrap learns only authenticated server peers and preserves administrator entries', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(undefined, 'PUT', rules(['198.51.100.10'], { enabled: false }))).status, 200);
  assert.equal('learn_registration' in (await f.request()).body, false);
  const registration = '/api/engine/endpoint?url=https://manager.example&id=1&token=test&endpoint=https://agent.example';
  f.setPeer('203.0.113.5');
  assert.equal((await f.request(registration, 'GET', undefined, {})).status, 401);
  assert.equal(f.store.accessControl.manager_ip, '');
  assert.equal((await f.request(registration, 'GET', undefined, { authorization, origin: 'http://127.0.0.1:' + f.server.address().port })).status, 202);
  assert.equal(f.store.accessControl.manager_ip, '');
  assert.equal((await f.request(registration)).status, 202);
  assert.equal(f.store.accessControl.manager_ip, '203.0.113.5');
  assert.equal(f.store.accessControl.enabled, true);
  assert.equal((await new Store(f.store.directory).load()).accessControl.enabled, true);
  assert.deepEqual(f.store.accessControl.allowed_ips, ['198.51.100.10', '203.0.113.5']);
  f.setPeer('198.51.100.10');
  assert.equal((await f.request(undefined, 'PUT', rules(['198.51.100.10', '203.0.113.5'], {}))).status, 200);
  f.setPeer('203.0.113.6');
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request(registration, 'GET', undefined, {})).status, 401);
  assert.equal((await f.request(registration)).status, 202);
  assert.equal((await f.request()).status, 200);
  f.setPeer('127.0.0.1');
  assert.equal((await f.request(undefined, 'PUT', rules([], {}))).status, 200);
  f.setPeer('203.0.113.6');
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request(registration.replace('https://manager.example', 'ftp://invalid'))).status, 400);
  assert.equal(f.store.accessControl.allowed_ips.length, 0);
  assert.equal((await f.request(registration)).status, 202);
  assert.equal(f.store.accessControl.manager_ip, '203.0.113.6');
  f.setPeer('203.0.113.7');
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request(registration)).status, 202);
  assert.equal((await f.request()).status, 200);
});

test('new restrictions close existing remote terminals and reject blocked WebSocket upgrades', async t => {
  const f = await fixture(t);
  await f.request(undefined, 'PUT', rules(['198.51.100.10']));
  const reservation = await f.request('/api/engine/containers/abc/ws', 'POST');
  const ws = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${reservation.body.path}`, { headers: { authorization } });
  const [ready] = await once(ws, 'message'); assert.equal(ready[0], 100);
  // An allowed update keeps the existing connection open.
  await f.request(undefined, 'PUT', rules(['198.51.100.10']));
  assert.equal(ws.readyState, WebSocket.OPEN);
  const closing = once(ws, 'close');
  f.setPeer('127.0.0.1'); await f.request(undefined, 'PUT', rules(['203.0.113.5']));
  await closing;
  f.setPeer('198.51.100.10');
  const blocked = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${reservation.body.path}`, { headers: { authorization, 'x-forwarded-for': '203.0.113.5' } });
  await assert.rejects(once(blocked, 'open'), /403/); blocked.terminate();
});

test('policy changes during authentication or a streamed update cannot bypass a new restriction', async t => {
  const f = await fixture(t);
  f.server.once('request', () => { f.store.accessControl = rules(['203.0.113.5']); });
  assert.equal((await f.request()).status, 403);
  f.store.accessControl = rules(['198.51.100.10']);
  const result = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.server.address().port, path: '/admin/access-control', method: 'PUT', headers: { authorization } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
    setTimeout(() => { f.store.accessControl = rules(['203.0.113.5']); req.end('"enabled":false,"allowed_ips":[]}'); }, 100);
  });
  assert.equal(await result, 403);
});

test('server access settings also work for an injected agent without a persistent store', async t => {
  const server = createServer({ docker: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeTerminals(); server.closeAllConnections(); server.close(); });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/admin/access-control', method: 'PUT', headers: { authorization } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(rules([])));
  });
  assert.equal(result, 200);
});


test('disconnect clears every ACL entry and terminal reservation, then permits registration with a new PaaShup', async t => {
  const f = await fixture(t);
  f.store.accessControl = { enabled: true, allowed_ips: ['198.51.100.10', '203.0.113.20', '192.168.1.0/24'], manager_ip: '198.51.100.10' };
  f.agent.write = Agent.prototype.write;
  let job;
  f.agent.enqueue = (key, work) => { job = work(); };
  const reservation = await f.request('/api/engine/containers/abc/ws', 'POST');
  const ws = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${reservation.body.path}`, { headers: { authorization } });
  const [ready] = await once(ws, 'message'); assert.equal(ready[0], 100);
  const closing = once(ws, 'close');
  f.setPeer('203.0.113.20');
  assert.equal((await f.request('/api/engine/endpoint', 'DELETE')).status, 202);
  await job; await closing;
  const state = await f.request();
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.allowed_ips, []);
  assert.equal(state.body.manager_ip, '');
  assert.equal(state.body.enabled, false);
  const restored = await new Store(f.store.directory).load();
  assert.deepEqual(restored.accessControl, { enabled: false, allowed_ips: [], manager_ip: '' });
  f.setPeer('203.0.113.30');
  assert.equal((await f.request(undefined, 'GET', undefined, {})).status, 401);
  assert.equal((await f.request()).status, 200);
  const stale = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${reservation.body.path}`, { headers: { authorization } });
  await assert.rejects(once(stale, 'open'), /403/); stale.terminate();
  f.agent.sync = async () => {};
  assert.equal((await f.request('/api/engine/endpoint?url=https://new-paashup.example&id=2&token=new-token')).status, 202);
  await job;
  const registered = (await f.request()).body;
  assert.deepEqual(registered.allowed_ips, ['203.0.113.30']);
  assert.equal(registered.manager_ip, '203.0.113.30');
  assert.equal(registered.enabled, true);
  f.setPeer('198.51.100.10');
  assert.equal((await f.request()).status, 403);
  assert.equal(f.store.config.id, '2');
});

test('registration enables filtering and closes existing terminals from newly excluded peers', async t => {
  const f = await fixture(t);
  const reservation = await f.request('/api/engine/containers/abc/ws', 'POST');
  const ws = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${reservation.body.path}`, { headers: { authorization } });
  const [ready] = await once(ws, 'message'); assert.equal(ready[0], 100);
  const closing = once(ws, 'close');
  f.setPeer('203.0.113.30');
  assert.equal((await f.request('/api/engine/endpoint?url=https://paashup.example&id=2&token=token')).status, 202);
  await closing;
  const registered = (await f.request()).body;
  assert.equal(registered.enabled, true);
  assert.deepEqual(registered.allowed_ips, ['203.0.113.30']);
  f.setPeer('198.51.100.10');
  assert.equal((await f.request()).status, 403);
});
