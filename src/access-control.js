import { BlockList, isIP, SocketAddress } from 'node:net';

export function ipAddress(value) {
  const family = isIP(value);
  if (!family) return '';
  if (family === 4) return value;
  const normalized = new SocketAddress({ address: value, family: 'ipv6' }).address;
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}
export function allowedIps(values) {
  if (!Array.isArray(values) || values.length > 256) throw new Error('Allowed IPs must be an array of at most 256 IP addresses or CIDR ranges');
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Each allowed IP must be a string');
    const parts = value.trim().split('/');
    const address = ipAddress(parts[0]);
    if (!address || parts.length > 2) throw new Error(`Invalid allowed IP: ${value}`);
    if (parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) > (isIP(address) === 4 ? 32 : 128) || parts[0].toLowerCase().includes('::ffff:'))) throw new Error(`Invalid CIDR range: ${value}`);
    result.push(address + (parts.length === 2 ? `/${Number(parts[1])}` : ''));
  }
  return [...new Set(result)];
}
export function policy(value) {
  if (!value || typeof value.enabled !== 'boolean') throw new Error('IP filtering must be true or false');
  return { enabled: value.enabled, allowed_ips: allowedIps(value.allowed_ips), manager_ip: ipAddress(value.manager_ip || '') };
}
export function initialAccess(env = process.env) {
  const entries = (env.ALLOWED_IPS || '').split(/[\s,]+/).filter(Boolean);
  const enabled = env.IP_FILTERING || String(entries.length > 0);
  if (!['true', 'false'].includes(enabled)) throw new Error('IP_FILTERING must be true or false');
  return policy({ enabled: enabled === 'true', allowed_ips: entries });
}
function includes(entries, address) {
  if (!address) return false;
  const block = new BlockList();
  for (const entry of entries) {
    const [ip, prefix] = entry.split('/');
    const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) block.addAddress(ip, family);
    else block.addSubnet(ip, Number(prefix), family);
  }
  return block.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}
function loopback(ip) { return includes(['127.0.0.0/8', '::1'], ip); }
function registration(req) {
  const url = new URL(req.url, 'http://localhost');
  return req.method === 'GET' && url.pathname === '/api/engine/endpoint' && ['url', 'id', 'token'].every(key => url.searchParams.get(key)) && !req.headers.origin && !req.headers['sec-fetch-site'];
}
export class AccessControl {
  constructor(store) {
    this.store = store;
    this.store.accessControl ??= initialAccess();
  }
  address(req) { return ipAddress(req.socket.remoteAddress); }
  allowed(req) {
    const p = this.store.accessControl;
    const ip = this.address(req);
    return !p.enabled || loopback(ip) || includes(p.allowed_ips, ip) || registration(req);
  }
  status(req) { return { ...this.store.accessControl, current_ip: this.address(req), loopback_always_allowed: true }; }
  async persist(next) {
    const previous = this.store.accessControl;
    this.store.accessControl = next;
    try { await this.store.save(); }
    catch (error) { if (this.store.accessControl === next) this.store.accessControl = previous; throw error; }
  }
  async update(input, req) {
    let next;
    try { next = policy({ ...input, manager_ip: this.store.accessControl.manager_ip }); }
    catch (error) { error.statusCode = 400; throw error; }
    const ip = this.address(req);
    if (next.enabled && !loopback(ip) && !includes(next.allowed_ips, ip)) throw Object.assign(new Error('Add your current IP before enabling filtering or removing its access'), { statusCode: 409 });
    await this.persist(next);
    return this.status(req);
  }
  async learn(req) {
    const p = this.store.accessControl;
    if (!registration(req)) return;
    const ip = this.address(req);
    if (!ip) return;
    const next = { ...p, enabled: true, manager_ip: ip, allowed_ips: allowedIps([...new Set([...p.allowed_ips, ip])]) };
    await this.persist(next);
  }
}
