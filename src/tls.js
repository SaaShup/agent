import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export function secureHttp(env = process.env) {
  const value = env.HTTP_SECURE ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error('HTTP_SECURE must be true or false');
  return value === 'true';
}
export function certificatePaths(env = process.env) {
  const directory = path.join(env.DATAPATH || '/data', 'tls');
  return { directory, pem: path.join(directory, 'server.pem'), cert: path.join(directory, 'server.crt'), caPem: path.join(directory, 'ca.pem'), caCert: path.join(directory, 'ca.crt') };
}
async function optionalFile(filename) {
  try { return await readFile(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function checkExpiry(certificate) {
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('HTTPS certificate has expired; replace it and update PaaShup trust');
}
async function atomicPem(filename, contents, directory) {
  const temporary = path.join(directory, path.basename(filename));
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, filename);
}
export async function serverTls(env = process.env) {
  if (!secureHttp(env)) return undefined;
  const ip = env.HTTP_SECURE_IP;
  if (ip && !isIP(ip)) throw new Error('HTTP_SECURE_IP must be an IPv4 or IPv6 address');
  const files = certificatePaths(env);
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  let pem = await optionalFile(files.pem);
  const existing = pem && new X509Certificate(pem);
  if (existing) {
    checkExpiry(existing);
    if (ip && !existing.checkIP(ip)) throw new Error('HTTPS certificate does not contain HTTP_SECURE_IP; replace it and update PaaShup trust');
  }
  let caPem = await optionalFile(files.caPem);
  const temporary = await mkdtemp(path.join(files.directory, '.generate-'));
  try {
    // Older releases served a CA certificate directly. Keep that same authority
    // and key so certificates already imported into Firefox remain trusted.
    if (!caPem) {
      if (existing) {
        if (!existing.ca) throw new Error('HTTPS CA is missing; restore tls/ca.pem from backup');
        caPem = pem;
      } else {
        const keyFile = path.join(temporary, 'ca-key.pem');
        const certFile = path.join(temporary, 'ca-cert.pem');
        await run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '1095',
          '-subj', '/CN=Paashup Agent CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
          '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', keyFile, '-out', certFile], { timeout: 30000 });
        caPem = Buffer.concat([await readFile(keyFile), await readFile(certFile)]);
      }
      await atomicPem(files.caPem, caPem, temporary);
    }
    const authority = new X509Certificate(caPem);
    checkExpiry(authority);
    if (!authority.ca) throw new Error('HTTPS CA certificate is not a certificate authority');
    if (!existing || existing.ca) {
      const keyFile = path.join(temporary, 'server-key.pem');
      const csrFile = path.join(temporary, 'server.csr');
      const certFile = path.join(temporary, 'server-cert.pem');
      const extensions = path.join(temporary, 'server.ext');
      const sans = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1'];
      if (ip) sans.push(`IP:${ip}`);
      await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans.join(',')}\n`);
      await run('openssl', ['req', '-new', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-subj', '/CN=Paashup Agent Server', '-keyout', keyFile, '-out', csrFile], { timeout: 30000 });
      await run('openssl', ['x509', '-req', '-in', csrFile, '-CA', files.caPem, '-CAkey', files.caPem,
        '-set_serial', '0x' + randomBytes(20).toString('hex'),
        '-days', '1095', '-sha256', '-extfile', extensions, '-out', certFile], { timeout: 30000 });
      pem = Buffer.concat([await readFile(keyFile), await readFile(certFile)]);
      await atomicPem(files.pem, pem, temporary);
    }
    const certificate = new X509Certificate(pem);
    if (!certificate.verify(authority.publicKey)) throw new Error('HTTPS server certificate does not match its CA');
    await writeFile(files.cert, certificate.toString(), { mode: 0o644 });
    await writeFile(files.caCert, authority.toString(), { mode: 0o644 });
    return { key: pem, cert: certificate.toString(), ca: authority.toString(), minVersion: 'TLSv1.2' };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
