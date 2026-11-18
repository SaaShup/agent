import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessControl, allowedIps, initialAccess, ipAddress, policy } from '../../src/access-control.js';
const req = (ip = '198.51.100.10', overrides = {}) => ({ socket: { remoteAddress: ip }, method: 'GET', url: '/', headers: {}, ...overrides });
const registration = '/api/engine/endpoint?url=https://manager.example&id=1&token=test';
function controller(settings = {}) { return new AccessControl({ accessControl: { ...initialAccess({}), ...settings }, save: async () => {} }); }

test('allowlists validate and normalize IPv4, IPv6 and CIDR values', () => {
  assert.equal(ipAddress('::ffff:c633:640a'), '198.51.100.10');
  assert.equal(ipAddress('2001:0db8::1'), '2001:db8::1');
  assert.equal(ipAddress('invalid'), '');
  assert.deepEqual(allowedIps([' 198.51.100.10 ', '198.51.100.10', '2001:0db8::1/064', '0.0.0.0/0', '::/0']), ['198.51.100.10', '2001:db8::1/64', '0.0.0.0/0', '::/0']);
  for (const input of [null, new Array(257).fill('127.0.0.1'), [42], [''], ['name.example'], ['1.2.3.4/33'], ['2001:db8::1/129'], ['1.2.3.4/-1'], ['1.2.3.4/x'], ['1.2.3.4/1/2'], ['::ffff:1.2.3.4/120']]) assert.throws(() => allowedIps(input));
  for (const input of [null, {}, { enabled: 'true' }, { enabled: true }]) assert.throws(() => policy(input));
  assert.deepEqual(initialAccess({}), { enabled: false, allowed_ips: [], manager_ip: '' });
  assert.equal(initialAccess({ ALLOWED_IPS: '198.51.100.10, 2001:db8::1\n192.0.2.0/24' }).enabled, true);
  assert.equal(initialAccess({ ALLOWED_IPS: '198.51.100.10', IP_FILTERING: 'false' }).enabled, false);
  assert.throws(() => initialAccess({ IP_FILTERING: 'yes' }), /must be true or false/);
  assert.equal(new AccessControl({ save: async () => {} }).allowed(req()), true);
  assert.equal('learn_registration' in policy({ enabled: false, allowed_ips: [], learn_registration: false }), false);
});

test('filtering honors ranges, actual peer addresses, loopback recovery and registration bootstrap', () => {
  const access = controller({ enabled: true, allowed_ips: ['198.51.100.0/24', '2001:db8::/64'] });
  for (const ip of ['198.51.100.10', '::ffff:198.51.100.10', '2001:db8::1', '127.0.0.1', '::1']) assert.equal(access.allowed(req(ip)), true);
  for (const ip of ['203.0.113.5', '2001:db9::1', 'invalid']) assert.equal(access.allowed(req(ip, { headers: { 'x-forwarded-for': '198.51.100.10' } })), false);
  const pending = controller({ enabled: true });
  assert.equal(pending.allowed(req(undefined, { url: registration })), true);
  for (const change of [{ url: '/' }, { method: 'POST', url: registration }, { url: '/api/engine/endpoint?url=https://manager.example' }, { url: registration, headers: { origin: 'https://manager.example' } }, { url: registration, headers: { 'sec-fetch-site': 'same-origin' } }]) assert.equal(pending.allowed(req(undefined, change)), false);
});

test('updates prevent administrator lockout, persist rules and roll back failed saves', async () => {
  const access = controller();
  await assert.rejects(access.update({ enabled: true, allowed_ips: [] }, req()), { statusCode: 409 });
  await assert.rejects(access.update({ enabled: true, allowed_ips: ['bad'] }, req()), { statusCode: 400 });
  const saved = await access.update({ enabled: true, allowed_ips: ['198.51.100.10'] }, req());
  assert.equal(saved.current_ip, '198.51.100.10'); assert.equal(saved.enabled, true);
  assert.equal(saved.loopback_always_allowed, true);
  const before = access.store.accessControl;
  access.store.save = async () => { throw Error('disk failure'); };
  await assert.rejects(access.update({ enabled: false, allowed_ips: [] }, req()), /disk failure/);
  assert.equal(access.store.accessControl, before);
  access.store.save = async () => { access.store.accessControl = before; throw Error('concurrent failure'); };
  await assert.rejects(access.update({ enabled: false, allowed_ips: [] }, req()), /concurrent failure/);
  assert.equal(access.store.accessControl, before);
});

test('learning records authenticated server registration peers and excludes browser requests', async () => {
  const access = controller();
  await access.learn(req());
  for (const request of [req(), req('bad', { url: registration }), req(undefined, { url: registration, headers: { origin: 'https://agent.example' } })]) await access.learn(request);
  assert.deepEqual(access.store.accessControl.allowed_ips, []);
  assert.equal(access.store.accessControl.enabled, false);
  await access.learn(req('::ffff:198.51.100.10', { url: registration }));
  await access.learn(req('198.51.100.10', { url: registration }));
  assert.deepEqual(access.store.accessControl.allowed_ips, ['198.51.100.10']);
  assert.equal(access.status(req()).manager_ip, '198.51.100.10');
  assert.equal(access.store.accessControl.enabled, true);
  await access.learn(req('127.0.0.1', { url: registration }));
  assert.ok(access.store.accessControl.allowed_ips.includes('127.0.0.1'));
});

test('failed registration persistence does not leave an uncommitted peer allowed', async () => {
  const access = controller();
  access.store.save = async () => { throw Error('disk failure'); };
  await assert.rejects(access.learn(req(undefined, { url: registration })), /disk failure/);
  assert.deepEqual(access.store.accessControl.allowed_ips, []);
  assert.equal(access.store.accessControl.manager_ip, '');
  assert.equal(access.store.accessControl.enabled, false);
});
