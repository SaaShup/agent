import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { diskUsage } from './docker.js';

export const projectLabel = 'com.saashup.quota.project';
const invalid = (message, statusCode = 409) => Object.assign(Error(message), { statusCode });
export function volumeInput(data = {}) {
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(data.name)) throw invalid('A valid Docker volume name is required (at least two characters)', 400);
  const max = data.max_size === undefined ? 0 : data.max_size;
  if (!Number.isSafeInteger(max) || max < 0 || max > Math.floor(Number.MAX_SAFE_INTEGER / 1048576)) throw invalid('max_size must be a non-negative integer in MiB; 0 means unlimited', 400);
  if (data.driver !== undefined && data.driver !== 'local') throw invalid('Managed volumes require the local Docker driver', 400);
  return { name: data.name, max_size: max };
}

export class Volumes {
  constructor(docker, store, options = {}) {
    Object.assign(this, { docker, store, root: process.env.VOLUME_QUOTA_HOST_ROOT || '/', readdir, statfs }, options);
    this.tools = options.tools || new QuotaTools(this.root);
    this.enabled = options.enabled ?? Boolean(process.env.VOLUME_QUOTA_HOST_ROOT);
    this.pending = Promise.resolve();
  }
  async capabilities() {
    try {
      const root = await this.host();
      const directory = path.join(this.root, root, 'volumes');
      const device = await this.filesystem(directory);
      if ((await this.tools.run('id', ['-u'])).trim() !== '0') throw invalid('Root privileges are required for host volume quotas', 503);
      await this.tools.run('setquota', ['--version']);
      await this.tools.project(directory);
      await this.tools.quota(directory, 0);
      const capacity = await this.capacity(root);
      return { available: true, filesystem: 'ext4', device, capacity, reason: 'Ext4 project quotas are enabled and accessible' };
    } catch (error) { return { available: false, reason: error.message }; }
  }
  async host() {
    if (process.env.DOCKER_HOST && !['unix://', 'unix:///var/run/docker.sock'].includes(process.env.DOCKER_HOST)) throw invalid('Host quotas require the local /var/run/docker.sock Engine', 503);
    if (!['/', '/proc/1/root'].includes(this.root)) throw invalid('VOLUME_QUOTA_HOST_ROOT must be / or /proc/1/root', 503);
    const info = await this.docker.info();
    if (info.SecurityOptions?.some(x => x.includes('rootless'))) throw invalid('Rootless Docker does not support host project quotas', 503);
    if (!path.isAbsolute(info.DockerRootDir || '')) throw invalid('Docker did not provide a host data root', 503);
    return info.DockerRootDir;
  }
  async filesystem(directory) { return this.tools.filesystem(directory); }
  async capacity(root) {
    const directory = path.join(this.root, root, 'volumes');
    await this.filesystem(directory);
    const disk = await this.statfs(directory);
    const free_bytes = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(free_bytes) || free_bytes < 0) throw invalid('Unable to determine available volume storage', 503);
    const volumes = [];
    for (const volume of (await this.docker.listVolumes()).Volumes || []) {
      const record = this.store.volumeQuotas?.volumes[volume.Name];
      if (!record || volume.Labels?.[projectLabel] !== String(record.project)) continue;
      const quota = await this.tools.quota(directory, record.project);
      volumes.push({ name: volume.Name, limit_bytes: quota.max_size * 1048576, usage_bytes: quota.usage_bytes });
    }
    // Used blocks already reduce bavail; reserve only each quota's unused portion.
    const reserved_bytes = volumes.reduce((sum, v) => sum + Math.max(0, v.limit_bytes - v.usage_bytes), 0);
    return { free_bytes, reserved_bytes, available_bytes: Math.max(0, free_bytes - reserved_bytes), volumes };
  }
  async ensureCapacity(root, name, limit) {
    const capacity = await this.capacity(root);
    const current = capacity.volumes.find(v => v.name === name);
    const used = current?.usage_bytes || 0;
    const credit = current ? Math.max(0, current.limit_bytes - used) : 0;
    const available = Math.max(0, capacity.free_bytes - capacity.reserved_bytes + credit);
    if (Math.max(0, limit * 1048576 - used) > available) throw invalid(`Insufficient volume storage: at most ${Math.floor((available + used) / 1048576)} MiB can be assigned to this volume`);
  }
  location(volume, root) {
    const expected = path.join(root, 'volumes', volume.Name, '_data');
    if (volume.Driver !== 'local' || volume.Options && Object.keys(volume.Options).length || volume.Scope !== 'local' || volume.Mountpoint !== expected) throw invalid('Only ordinary local Docker named volumes are supported');
    return path.join(this.root, expected);
  }
  async identity(volume, root, record) {
    if (!record || volume.Labels?.[projectLabel] !== String(record.project)) throw invalid('Only volumes created by this agent can have their limit changed');
    const directory = this.location(volume, root);
    await this.filesystem(directory);
    const project = await this.tools.project(directory);
    if (project.id !== record.project || !project.inherit) throw invalid('Volume project identity is incomplete; do not attach it; administrator recovery required', 503);
    return directory;
  }
  async list() {
    const data = await this.docker.listVolumes();
    const volumes = data.Volumes || [];
    if (volumes.length) {
      const usage = await diskUsage(this.docker).catch(() => ({}));
      const sizes = new Map((usage.Volumes || []).map(volume => [volume.Name, volume.UsageData]));
      for (const volume of volumes) if (sizes.get(volume.Name)) volume.UsageData = sizes.get(volume.Name);
    }
    const managed = volumes.filter(v => this.store.volumeQuotas?.volumes[v.Name] && v.Labels?.[projectLabel] === String(this.store.volumeQuotas.volumes[v.Name].project));
    if (managed.length) {
      const root = await this.host();
      for (const volume of managed) {
        const record = this.store.volumeQuotas.volumes[volume.Name];
        const directory = await this.identity(volume, root, record);
        const quota = await this.tools.quota(directory, record.project);
        Object.assign(volume, { max_size: quota.max_size, usage_bytes: quota.usage_bytes, project_id: record.project });
      }
    }
    return { ...data, Volumes: volumes, Warnings: data.Warnings || null };
  }
  change(method, data) {
    // Serialize allocation and all quota mutations, including after failed operations.
    const work = this.pending.catch(() => {}).then(() => this.write(method, volumeInput(data)));
    this.pending = work;
    return work;
  }
  async write(method, input) {
    const { name, max_size: limit } = input;
    const existing = ((await this.docker.listVolumes()).Volumes || []).find(v => v.Name === name);
    if (method === 'POST' && existing) throw invalid('Volume already exists');
    const record = this.store.volumeQuotas?.volumes[name];
    if (method === 'DELETE' && !record) return this.docker.getVolume(name).remove();
    if (method === 'POST' && !limit && (!this.enabled || !(await this.capabilities()).available)) return this.docker.createVolume({ Name: name, Driver: 'local' });
    const root = await this.host();
    if (method === 'POST') {
      const directory = path.join(this.root, root, 'volumes');
      const device = await this.filesystem(directory);
      if (limit) await this.ensureCapacity(root, name, limit);
      const state = this.store.volumeQuotas;
      const project = state.next_project;
      if (!Number.isInteger(project) || project < 1000000 || project > 2147483647) throw invalid('Project ID allocation state is invalid or exhausted', 503);
      const current = await this.tools.quota(directory, project);
      if (current.max_size || current.soft || current.usage_bytes || current.inodes || current.inode_soft || current.inode_hard) throw invalid('Reserved project ID is already in use; check host allocation', 503);
      state.next_project++;
      state.volumes[name] = { project };
      await this.store.save(); // Never reuse IDs, even after a crash or external Docker prune.
      await this.docker.createVolume({ Name: name, Driver: 'local', Labels: { [projectLabel]: String(project) } });
      const volume = await this.docker.getVolume(name).inspect();
      if (volume.Labels?.[projectLabel] !== String(project)) throw invalid('Concurrent external creation detected; volume left untouched');
      try {
        const target = this.location(volume, root);
        if (await this.filesystem(target) !== device) throw invalid('Volume filesystem changed during creation', 503);
        if ((await this.readdir(target)).length) throw invalid('New volume is not empty; refusing quota assignment');
        await this.tools.quota(target, project, limit);
        await this.tools.project(target, project);
        return volume;
      } catch (error) {
        await this.docker.getVolume(name).remove(); // Never force removal of an attached volume.
        await this.tools.quota(directory, project, 0);
        throw error;
      }
    }
    if (!existing) throw invalid('Volume not found', 404);
    const directory = await this.identity(await this.docker.getVolume(name).inspect(), root, record);
    if (method === 'PUT') {
      const value = await this.tools.quota(directory, record.project);
      if (limit && value.usage_bytes > limit * 1048576) throw invalid('New limit is below current storage usage');
      if (limit && (!value.max_size || limit > value.max_size)) await this.ensureCapacity(root, name, limit);
      await this.tools.quota(directory, record.project, limit);
      return { name, max_size: limit };
    }
    await this.docker.getVolume(name).remove();
    await this.tools.quota(path.join(this.root, root, 'volumes'), record.project, 0);
    return {};
  }
}

const execute = promisify(execFile);
export class QuotaTools {
  constructor(root = '/', run = execute) { this.root = root; this.execute = run; this.mounts = new Map(); }
  hostPath(directory) { return this.root === '/' ? directory : directory.slice(this.root.length); }
  async run(tool, args) {
    const host = this.root !== '/';
    try {
      const { stdout, stderr } = await this.execute(host ? 'nsenter' : tool, host ? ['--target', '1', '--mount', '--root=/proc/1/root', '--wd=/', '--', tool, ...args] : args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
      if (stderr.trim()) throw Error(stderr.trim());
      return stdout;
    } catch (error) {
      const detail = error.stderr?.trim() || error.message;
      if (host && error.code === 'ENOENT') throw invalid('The agent is missing nsenter. Rebuild the agent image to enable host quota access.', 503);
      if (error.code === 'ENOENT' || /failed to execute.*(?:No such file or directory|not found)/i.test(detail)) {
        const packages = { findmnt: 'util-linux', lsblk: 'util-linux', setquota: 'quota', repquota: 'quota', chattr: 'e2fsprogs', lsattr: 'e2fsprogs', id: 'coreutils' };
        throw invalid(`Host tool ${tool} is missing. On Debian/Ubuntu, run on the Docker host: sudo apt-get install ${packages[tool]}`, 503);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM' || /permission denied|operation not permitted/i.test(detail)) throw invalid('The agent lacks permission to access host quotas. Enable quota host access with root and host namespace privileges.', 503);
      if (tool === 'findmnt' && !error.stderr?.trim()) throw invalid(`Cannot access Docker volume storage at ${args[2]}. Enable quota host access and verify the Docker data root.`, 503);
      throw invalid(`Host ${tool} failed: ${detail}`, 503);
    }
  }
  async filesystem(directory) {
    const output = await this.run('findmnt', ['--json', '--target', this.hostPath(directory), '--output', 'FSTYPE,SOURCE,OPTIONS,TARGET']);
    const mount = JSON.parse(output).filesystems?.[0];
    if (!mount || mount.fstype !== 'ext4' || !mount.options.split(',').includes('prjquota') || !mount.source.startsWith('/dev/') || mount.source.includes('[')) throw invalid('Docker volumes must reside on real ext4 mounted with prjquota', 503);
    const devices = (await this.run('lsblk', ['--inverse', '--noheadings', '--raw', '--output', 'TYPE', '--', mount.source])).trim().split(/\s+/);
    if (!devices[0] || devices.includes('loop')) throw invalid('Loopback filesystems are unsupported; a real ext4 block device is required', 503);
    this.mounts.set(directory, mount);
    return mount.source;
  }
  async project(directory, id) {
    const target = this.hostPath(directory);
    if (id !== undefined) await this.run('chattr', ['-p', String(id), '+P', '--', target]);
    const result = (await this.run('lsattr', ['-d', '-p', '--', target])).trim().match(/^(\d+)\s+([a-zA-Z-]+)\s+/);
    if (!result) throw invalid('Unable to read ext4 project identity from lsattr', 503);
    const project = { id: Number(result[1]), inherit: result[2].includes('P') };
    if (id !== undefined && (project.id !== id || !project.inherit)) throw invalid('chattr did not apply the requested project identity and inheritance', 503);
    return project;
  }
  async quota(directory, id, limit) {
    await this.filesystem(directory);
    const mountpoint = this.mounts.get(directory).target;
    if (limit !== undefined) {
      await this.run('setquota', ['-P', String(id), '0', String(limit * 1024), '0', '0', '--', mountpoint]);
      return;
    }
    const output = await this.run('repquota', ['-P', '-n', '-v', '-O', 'csv', '--', mountpoint]);
    if (!output.startsWith('Project,BlockStatus,FileStatus,BlockUsed,')) throw invalid('Unable to read project quotas from repquota', 503);
    const row = output.trim().split('\n').slice(1).map(line => line.split(',')).find(fields => fields[0] === `#${id}`);
    if (!row) return { max_size: 0, soft: 0, usage_bytes: 0, inodes: 0, inode_soft: 0, inode_hard: 0 };
    const values = [3, 4, 5, 7, 8, 9].map(index => row[index]);
    if (values.some(value => !/^\d+$/.test(value))) throw invalid('Invalid numeric project quota report', 503);
    const [used, soft, hard, inodes, inode_soft, inode_hard] = values.map(Number);
    return { max_size: hard / 1024, soft, usage_bytes: used * 1024, inodes, inode_soft, inode_hard };
  }
}
