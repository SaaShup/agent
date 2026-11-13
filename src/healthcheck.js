import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { certificatePaths, secureHttp } from './tls.js';

try {
  const secure = secureHttp();
  const transport = secure ? https : http;
  const options = {
    hostname: '127.0.0.1', port: Number(process.env.PORT || 1880), path: '/', timeout: 4000,
    headers: { authorization: 'Basic ' + Buffer.from(`${process.env.API_USERNAME || 'admin'}:${process.env.HEALTHCHECK_PASSWORD || 'saashup'}`).toString('base64') },
    ...(secure ? { ca: await readFile(certificatePaths().caCert) } : {}),
  };
  const req = transport.get(options, res => { res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1; });
  req.on('timeout', () => req.destroy(new Error('Health check timed out')));
  req.on('error', () => { process.exitCode = 1; });
} catch { process.exitCode = 1; }
