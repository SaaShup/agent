// Exercise the default health-probe port without connecting to an existing deployment.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mock } from 'node:test';
const get = http.get;
mock.method(http, 'get', (options, callback) => {
  assert.equal(options.port, 1880);
  return get({ ...options, port: Number(process.env.PROBE_PORT) }, callback);
});
