import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { certificatePaths, secureHttp, serverTls } from '../../src/tls.js';
import { createServer } from '../../src/server.js';

const authorization = 'Basic ' + Buffer.from('admin:saashup').toString('base64');
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-https-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function request(transport, options) {
  return new Promise((resolve, reject) => {
    transport.get(options, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}
async function probe(env, flags = []) {
  const child = spawn(process.execPath, [...flags, 'src/healthcheck.js'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  return (await once(child, 'exit'))[0];
}

test('HTTP remains the default and secure configuration rejects ambiguous values', async () => {
  assert.equal(secureHttp({}), false);
  assert.equal(secureHttp({ HTTP_SECURE: 'false' }), false);
  assert.equal(secureHttp({ HTTP_SECURE: 'true' }), true);
  assert.throws(() => secureHttp({ HTTP_SECURE: 'yes' }), /must be true or false/);
  assert.equal(await serverTls({}), undefined);
  assert.equal(certificatePaths({}).directory, '/data/tls');
  await assert.rejects(serverTls({ HTTP_SECURE: 'true', HTTP_SECURE_IP: 'not-an-ip' }), /IPv4 or IPv6/);
});

test('self-signed identity persists, protects its key, and validates public IPv4/IPv6 SANs', async t => {
  const dir = await directory(t);
  const env = { HTTP_SECURE: 'true', DATAPATH: dir, HTTP_SECURE_IP: '198.51.100.20' };
  const first = await serverTls(env);
  const cert = new X509Certificate(first.cert);
  assert.equal(cert.checkIP(env.HTTP_SECURE_IP), env.HTTP_SECURE_IP);
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
  assert.ok(cert.checkIP('::1'));
  assert.equal(cert.checkHost('localhost'), 'localhost');
  assert.ok(cert.verify(new X509Certificate(first.ca).publicKey));
  assert.equal(first.minVersion, 'TLSv1.2');
  assert.equal(cert.ca, false);
  assert.equal(new X509Certificate(first.ca).ca, true);
  assert.equal((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86400000, 1095);
  const files = certificatePaths(env);
  assert.equal((await stat(files.pem)).mode & 0o777, 0o600);
  assert.equal((await stat(files.directory)).mode & 0o777, 0o700);
  const exported = await readFile(files.cert, 'utf8');
  assert.equal(exported, first.cert);
  assert.doesNotMatch(exported, /PRIVATE KEY/);
  await rm(files.cert);
  const next = await serverTls(env);
  assert.deepEqual(next.key, first.key);
  assert.equal(next.cert, first.cert);
  await assert.rejects(serverTls({ ...env, HTTP_SECURE_IP: '198.51.100.21' }), /does not contain/);
  const ipv6 = await serverTls({ ...env, DATAPATH: await directory(t), HTTP_SECURE_IP: '2001:db8::20' });
  assert.ok(new X509Certificate(ipv6.cert).checkIP('2001:db8::20'));
});

test('TLS startup preserves broken identities and rejects expiry and generation failures', async t => {
  const dir = await directory(t);
  const env = { HTTP_SECURE: 'true', DATAPATH: dir };
  const files = certificatePaths(env);
  await mkdir(files.directory);
  await mkdir(files.pem);
  await assert.rejects(serverTls(env), { code: 'EISDIR' });
  await rm(files.pem, { recursive: true });
  await writeFile(files.pem, 'broken certificate');
  await assert.rejects(serverTls(env));
  assert.equal(await readFile(files.pem, 'utf8'), 'broken certificate');
  await rm(files.pem);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent';
    await assert.rejects(serverTls(env), { code: 'ENOENT' });
  } finally { process.env.PATH = originalPath; }
  await serverTls(env);
  const future = Date.parse(new X509Certificate(await readFile(files.pem)).validTo) + 1000;
  const now = t.mock.method(Date, 'now', () => future);
  try { await assert.rejects(serverTls(env), /expired/); }
  finally { now.mock.restore(); }
});

test('native HTTPS verifies trust and identity, requires authentication, and serves WSS terminals', async t => {
  const env = { HTTP_SECURE: 'true', DATAPATH: await directory(t) };
  const tls = await serverTls(env);
  const stream = new PassThrough();
  const docker = {
    listContainers: async () => [{ Id: 'abc', State: 'running' }],
    getContainer: () => ({ exec: async () => ({ start: async () => stream }) }),
  };
  const server = createServer({ docker }, tls);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeTerminals(); server.closeAllConnections(); server.close(); stream.destroy(); });
  const options = { hostname: '127.0.0.1', port: server.address().port, ca: tls.ca };
  const download = (method = 'GET', headers = { authorization }) => new Promise((resolve, reject) => {
    const req = https.request({ ...options, method, path: '/api/tls/certificate', headers }, res => {
      let body = ''; res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
  assert.equal((await download('GET', {})).status, 401);
  const certificateDownload = await download();
  assert.equal(certificateDownload.status, 200);
  assert.equal(certificateDownload.headers['content-disposition'], 'attachment; filename="paashup-agent.crt"');
  assert.match(certificateDownload.headers['content-type'], /^application\/x-pem-file/);
  assert.equal(new X509Certificate(certificateDownload.body).fingerprint256, new X509Certificate(tls.ca).fingerprint256);
  assert.doesNotMatch(certificateDownload.body, /PRIVATE KEY/);
  const head = await download('HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  const unsupported = await download('POST');
  assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.allow, 'GET, HEAD');
  assert.equal(await request(https, { ...options, path: '/tls/server.pem', headers: { authorization } }), 404);
  assert.equal(await request(https, options), 401);
  assert.equal(await request(https, { ...options, headers: { authorization } }), 200);
  await assert.rejects(request(https, { ...options, ca: undefined }), /unable to verify|self-signed certificate/);
  await assert.rejects(request(https, { ...options, servername: 'wrong.example' }), /not in the cert/);
  await assert.rejects(request(http, options));
  const reservation = await new Promise((resolve, reject) => {
    const req = https.request({ ...options, method: 'POST', path: '/api/engine/containers/abc/ws', headers: { authorization } }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve(JSON.parse(body)));
    }); req.on('error', reject); req.end();
  });
  const ws = new WebSocket(`wss://127.0.0.1:${options.port}${reservation.path}`, { ca: tls.ca, headers: { authorization } });
  t.after(() => ws.terminate());
  const [ready] = await once(ws, 'message');
  assert.equal(ready[0], 100);
  const closing = once(ws, 'close'); ws.close(); await closing;
  assert.equal(await probe({ ...env, PORT: String(options.port) }), 0);
  assert.equal(await probe({ ...env, PORT: String(options.port), HEALTHCHECK_PASSWORD: 'wrong' }), 1);
  assert.equal(await probe({ ...env, PORT: String(options.port), HTTP_SECURE: 'false' }), 1);
  assert.equal(await probe({ ...env, PORT: String(options.port), HTTP_SECURE: 'invalid' }), 1);
});

test('health probe supports HTTP, connection errors, missing certificates, defaults and timeouts', async t => {
  const server = http.createServer((req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = String(server.address().port);
  assert.equal(await probe({ HTTP_SECURE: 'false', PORT: port, API_USERNAME: 'probe', HEALTHCHECK_PASSWORD: 'secret' }), 0);
  assert.equal(await probe({ HTTP_SECURE: 'false', PORT: '', PROBE_PORT: port }, ['--import', './tests/fixtures/default-healthcheck.mjs']), 0);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(await probe({ HTTP_SECURE: 'false', PORT: port }), 1);
  assert.equal(await probe({ HTTP_SECURE: 'true', DATAPATH: await directory(t), PORT: port }), 1);
  const stalled = http.createServer(() => {});
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  t.after(() => { stalled.closeAllConnections(); stalled.close(); });
  assert.equal(await probe({ HTTP_SECURE: 'false', PORT: String(stalled.address().port) }), 1);
});

test('certificate download is unavailable when HTTPS is disabled', async t => {
  const server = createServer({ docker: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeTerminals(); server.closeAllConnections(); server.close(); });
  assert.equal(await request(http, { hostname: '127.0.0.1', port: server.address().port, path: '/api/tls/certificate', headers: { authorization } }), 404);
});


test('legacy CA-as-server identity migrates without changing the already trusted CA', async t => {
  const env = { HTTP_SECURE: 'true', DATAPATH: await directory(t), HTTP_SECURE_IP: '198.51.100.20' };
  const files = certificatePaths(env);
  await mkdir(files.directory);
  const keyFile = path.join(files.directory, 'legacy-key.pem');
  const certFile = path.join(files.directory, 'legacy-cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1095',
    '-subj', '/CN=Paashup Agent', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'subjectAltName=IP:198.51.100.20,IP:127.0.0.1',
    '-keyout', keyFile, '-out', certFile]);
  const trusted = new X509Certificate(await readFile(certFile));
  const legacy = Buffer.concat([await readFile(keyFile), await readFile(certFile)]);
  await writeFile(files.pem, legacy);
  const migrated = await serverTls(env);
  assert.equal(new X509Certificate(migrated.ca).fingerprint256, trusted.fingerprint256);
  assert.equal(new X509Certificate(migrated.cert).ca, false);
  assert.ok(new X509Certificate(migrated.cert).verify(trusted.publicKey));
  assert.deepEqual(await readFile(files.caPem), legacy);
  const next = await serverTls(env);
  assert.deepEqual(next.key, migrated.key);
  assert.equal(next.ca, migrated.ca);
});

test('missing, incorrect and expired authorities fail without silently replacing trust', async t => {
  const env = { HTTP_SECURE: 'true', DATAPATH: await directory(t) };
  const first = await serverTls(env);
  const files = certificatePaths(env);
  const caPem = await readFile(files.caPem);
  await rm(files.caPem);
  await assert.rejects(serverTls(env), /CA is missing/);
  await writeFile(files.caPem, await readFile(files.pem));
  await assert.rejects(serverTls(env), /not a certificate authority/);
  const other = await serverTls({ ...env, DATAPATH: await directory(t) });
  await writeFile(files.caPem, other.ca);
  await assert.rejects(serverTls(env), /does not match/);
  await writeFile(files.caPem, caPem);
  // Isolate authority expiry from the separately checked leaf certificate.
  const now = Date.now();
  const expired = Date.parse(new X509Certificate(first.ca).validTo) + 1000;
  const clock = t.mock.method(Date, 'now', function () { return clock.mock.callCount() === 1 ? now : expired; });
  try { await assert.rejects(serverTls(env), /expired/); }
  finally { clock.mock.restore(); }
});
