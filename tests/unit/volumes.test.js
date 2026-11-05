import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volumes, volumeInput, projectLabel } from '../../src/volumes.js';

function setup(t, options = {}) {
  const calls = [], volumes = new Map(); let id = 0, inherit = false, usage = 0; const limits = new Map();
  const store = { volumeQuotas: { next_project: 1000000, volumes: {} }, save: async () => calls.push(['save']) };
  const docker = {
    info: async () => ({ DockerRootDir: '/var/lib/docker', SecurityOptions: [] }),
    listVolumes: async () => ({ Volumes: [...volumes.values()].map(v => ({...v})) }),
    createVolume: async input => {
      calls.push(['create', input]);
      const volume = { Name: input.Name, Driver: 'local', Scope: 'local', Options: null, Labels: input.Labels, Mountpoint: `/var/lib/docker/volumes/${input.Name}/_data` };
      volumes.set(input.Name, volume); return volume;
    },
    getVolume: name => ({ inspect: async () => volumes.get(name), remove: async () => { calls.push(['remove', name]); volumes.delete(name); } })
  };
  const tools = {
    run: async () => '0',
    filesystem: directory => { calls.push(['filesystem',directory]); return '8:1'; },
    project: (directory, value) => { if (value !== undefined) { id = value; inherit = true; calls.push(['project',id]); } return { id, inherit }; },
    quota: (directory, project, value) => {
      if (value !== undefined) { limits.set(project,value); calls.push(['quota',project,value]); }
      return { max_size: limits.get(project) || 0, usage_bytes: usage, soft: 0, inodes: 0 };
    }
  };
  const manager = new Volumes(docker, store, { tools, enabled: true, readdir: async () => [], statfs: async () => ({ bavail: 1024 * 1024, bsize: 1048576 }), ...options });
  return { manager, docker, store, tools, calls, volumes, setUsage: value => {usage = value;} };
}

test('volume validation rejects unsafe data and supports integral MiB limits', () => {
  for (const data of [null, {}, {name:'ok',max_size:null}, {name:'../escape'}, {name:'a'}, {name:'ok',max_size:-1}, {name:'ok',max_size:'1024'}, {name:'ok',max_size:0.5}, {name:'ok',max_size:Number.MAX_SAFE_INTEGER}, {name:'ok',driver:'tmpfs'}]) assert.throws(()=>volumeInput(data), {statusCode:400});
  assert.throws(()=>volumeInput(), {statusCode:400});
  assert.deepEqual(volumeInput({name:'data',driver:'local',max_size:5120}), {name:'data',max_size:5120});
  assert.deepEqual(volumeInput({name:'data'}), {name:'data',max_size:0});
});

test('agent checks ext4 and applies hard quota before project inheritance on real named volumes', async t => {
  const {manager,calls,store} = setup(t);
  await manager.change('POST',{name:'data',max_size:1024});
  assert.ok(calls.findIndex(c=>c[0]==='filesystem') < calls.findIndex(c=>c[0]==='create'));
  assert.ok(calls.findIndex(c=>c[0]==='save') < calls.findIndex(c=>c[0]==='create'));
  assert.ok(calls.findIndex(c=>c[0]==='quota') < calls.findIndex(c=>c[0]==='project'));
  assert.deepEqual(calls.find(c=>c[0]==='create')[1],{Name:'data',Driver:'local',Labels:{[projectLabel]:'1000000'}});
  assert.equal(store.volumeQuotas.next_project,1000001);
  const result = await manager.list(); assert.equal(result.Volumes[0].max_size,1024); assert.equal(result.Volumes[0].project_id,1000000);
  for (const max_size of [5120,10240,0]) await manager.change('PUT',{name:'data',max_size});
  assert.equal((await manager.list()).Volumes[0].max_size,0);
  await assert.rejects(manager.change('POST',{name:'data'}), {statusCode:409});
  await manager.change('DELETE',{name:'data'});
  assert.equal(store.volumeQuotas.volumes.data.project,1000000);
  assert.deepEqual((await manager.list()).Volumes,[]);
});

test('agent rejects quota reductions below usage and keeps in-use volumes enforced', async t => {
  const {manager,docker,setUsage,calls}=setup(t);
  await manager.change('POST',{name:'data',max_size:1024});
  setUsage(5*1048576);
  await assert.rejects(manager.change('PUT',{name:'data',max_size:1}),/below current/);
  const before=calls.length;
  docker.getVolume=()=>({inspect:async()=>({Name:'data',Driver:'local',Scope:'local',Mountpoint:'/var/lib/docker/volumes/data/_data',Labels:{[projectLabel]:'1000000'}}),remove:async()=>{throw Error('in use');}});
  await assert.rejects(manager.change('DELETE',{name:'data'}),/in use/);
  assert.ok(!calls.slice(before).some(c=>c[0]==='quota'));
});

test('quota assignment errors remove unused volume but reserve project IDs', async t => {
  const {manager,tools,calls,store}=setup(t);
  tools.project=()=>{throw Error('assignment failed');};
  await assert.rejects(manager.change('POST',{name:'data',max_size:1024}),/assignment failed/);
  assert.ok(calls.some(c=>c[0]==='remove')); assert.ok(calls.some(c=>c[0]==='quota'&&c[2]===0));
  assert.equal(store.volumeQuotas.next_project,1000001);
});

test('ordinary unlimited volumes work without host access and unmanaged volumes cannot be resized', async t => {
  const {manager,docker}=setup(t,{enabled:false});
  await manager.change('POST',{name:'data'});
  assert.equal((await manager.list()).Volumes[0].max_size,undefined);
  await assert.rejects(manager.change('PUT',{name:'data',max_size:1024}),/Only volumes created/);
  await manager.change('DELETE',{name:'data'});
  await assert.rejects(manager.change('PUT',{name:'missing'}),{statusCode:404});
  docker.listVolumes=async()=>({}); assert.deepEqual(await manager.list(),{Volumes:[],Warnings:null});
  await manager.change('POST',{name:'more'});
});

test('quota-enabled deployment can still create unlimited volumes on an unsupported host', async t => {
  const { manager, tools, calls } = setup(t);
  tools.filesystem = () => { throw Error('ext4 project quotas unavailable'); };
  await manager.change('POST', { name: 'unlimited', max_size: 0 });
  assert.deepEqual(calls.find(call => call[0] === 'create')[1], { Name: 'unlimited', Driver: 'local' });
  assert.equal((await manager.list()).Volumes[0].project_id, undefined);
  await assert.rejects(manager.change('POST', { name: 'limited', max_size: 1024 }), /ext4 project quotas unavailable/);
});

test('capacity rejects the eleventh 1 GiB quota and serializes competing allocations', async t => {
  const { manager, store, calls } = setup(t, { statfs: async () => ({ bavail: 10240, bsize: 1048576 }) });
  for (let i = 0; i < 9; i++) await manager.change('POST', { name: `data-${i}`, max_size: 1024 });
  const results = await Promise.allSettled(['last-one', 'too-many'].map(name => manager.change('POST', { name, max_size: 1024 })));
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.statusCode, 409);
  assert.match(results[1].reason.message, /Insufficient volume storage/);
  assert.equal(store.volumeQuotas.next_project, 1000010);
  assert.equal(calls.filter(c => c[0] === 'create').length, 10);
  assert.equal((await manager.capacity('/var/lib/docker')).available_bytes, 0);
});

test('capacity accounts for existing usage, resize credits, unlimited volumes and released limits', async t => {
  let free = 6144;
  const { manager, tools, volumes, store } = setup(t, { statfs: async () => ({ bavail: free, bsize: 1048576 }) });
  const quotas = new Map();
  function seed(name, project, limit, used) {
    store.volumeQuotas.volumes[name] = { project };
    volumes.set(name, { Name: name, Driver: 'local', Scope: 'local', Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Labels: { [projectLabel]: String(project) } });
    quotas.set(project, { max_size: limit, usage_bytes: used * 1048576 });
  }
  seed('first', 1000000, 5120, 3072);
  seed('second', 1000001, 3072, 1024);
  seed('unlimited', 1000002, 0, 4096);
  tools.project = directory => ({ id: store.volumeQuotas.volumes[directory.split('/').at(-2)].project, inherit: true });
  tools.quota = (directory, project, limit) => {
    const quota = quotas.get(project);
    if (limit !== undefined) quota.max_size = limit;
    return quota;
  };
  let capacity = await manager.capacity('/var/lib/docker');
  assert.equal(capacity.reserved_bytes, 4096 * 1048576);
  assert.equal(capacity.available_bytes, 2048 * 1048576);
  await manager.change('PUT', { name: 'first', max_size: 7168 });
  await assert.rejects(manager.change('PUT', { name: 'second', max_size: 4096 }), /Insufficient volume storage/);
  free = 0; // Unrelated host data filled the filesystem; reductions must still work.
  await manager.change('PUT', { name: 'first', max_size: 5120 });
  await manager.change('PUT', { name: 'first', max_size: 0 });
  free = 6144;
  await manager.change('PUT', { name: 'unlimited', max_size: 8192 });
  await manager.change('DELETE', { name: 'second' });
  capacity = await manager.capacity('/var/lib/docker');
  assert.equal(capacity.available_bytes, 2048 * 1048576);
});

test('capacity fails closed on unreadable storage and ignores stale or foreign quota records', async t => {
  const { manager, docker, store, volumes } = setup(t);
  store.volumeQuotas.volumes.foreign = { project: 1000000 };
  volumes.set('foreign', { Name: 'foreign', Labels: { [projectLabel]: '999' } });
  volumes.set('ordinary', { Name: 'ordinary' });
  assert.equal((await manager.capacity('/var/lib/docker')).reserved_bytes, 0);
  docker.listVolumes = async () => ({});
  assert.equal((await manager.capacity('/var/lib/docker')).reserved_bytes, 0);
  manager.statfs = async () => ({ bavail: NaN, bsize: 4096 });
  await assert.rejects(manager.change('POST', { name: 'bad', max_size: 1 }), { statusCode: 503 });
  manager.statfs = async () => { throw Error('Host storage inaccessible'); };
  await assert.rejects(manager.change('POST', { name: 'bad', max_size: 1 }), /Host storage inaccessible/);
});

test('agent rejects remote daemons, rootless Docker, and invalid roots', async t => {
  const {manager,docker}=setup(t);
  const previous=process.env.DOCKER_HOST;
  t.after(()=>{if(previous===undefined) delete process.env.DOCKER_HOST;else process.env.DOCKER_HOST=previous;});
  process.env.DOCKER_HOST='tcp://remote:2375'; await assert.rejects(manager.host(),{statusCode:503});
  process.env.DOCKER_HOST='unix:///var/run/docker.sock'; await manager.host();
  delete process.env.DOCKER_HOST;
  manager.root='/other'; await assert.rejects(manager.host(),{statusCode:503});
  manager.root='/';docker.info=async()=>({DockerRootDir:'/var/lib/docker',SecurityOptions:['name=rootless']});await assert.rejects(manager.host(),/Rootless/);
  docker.info=async()=>({});await assert.rejects(manager.host(),/data root/);

});

test('reserved IDs, empty directories, volume driver and project ownership are enforced', async t => {
  for (const project of [999999,2147483648,1.5]) {
    const {manager,store}=setup(t);store.volumeQuotas.next_project=project;
    await assert.rejects(manager.change('POST',{name:'data',max_size:1}),/allocation state/);
  }
  for (const key of ['max_size','soft','usage_bytes','inodes','inode_soft','inode_hard']) {
    const {manager,tools}=setup(t);tools.quota=()=>({[key]:1});await assert.rejects(manager.change('POST',{name:'data',max_size:1}),/already in use/);
  }
  const {manager,tools,docker,calls,volumes}=setup(t);
  manager.readdir=async()=>['existing'];await assert.rejects(manager.change('POST',{name:'data',max_size:1}),/not empty/);
  manager.readdir=async()=>[];
  let filesystemCalls=0;tools.filesystem=()=>++filesystemCalls===1?'8:1':'8:2';
  await assert.rejects(manager.change('POST',{name:'data',max_size:1}),/filesystem changed/);
  tools.filesystem=()=> '8:1';await manager.change('POST',{name:'data',max_size:1});
  tools.project=()=>({id:0,inherit:false});await assert.rejects(manager.list(),/identity is incomplete/);
  tools.project=()=>({id:1000002,inherit:false});await assert.rejects(manager.list(),/identity is incomplete/);
  const volume=volumes.get('data');
  for (const change of [{Driver:'nfs'},{Options:{type:'tmpfs'}},{Scope:'global'},{Mountpoint:'/other'}]) assert.throws(()=>manager.location({...volume,...change},'/var/lib/docker'),/ordinary local/);
  volume.Options={};assert.ok(manager.location(volume,'/var/lib/docker'));
  volume.Labels={};await assert.rejects(manager.change('PUT',{name:'data'}),/Only volumes created/);
  await manager.list();
  docker.createVolume=async input=>{volumes.set(input.Name,{Name:input.Name,Labels:{}});};
  const before=calls.length;await assert.rejects(manager.change('POST',{name:'different',max_size:1}),/Concurrent external/);
  assert.ok(!calls.slice(before).some(c=>c[0]==='remove'));
});

test('quota mutations serialize safely after failures', async t => {
  const {manager,tools}=setup(t,{root:'/proc/1/root'});
  await manager.change('POST',{name:'data',max_size:0});
  assert.ok((await manager.list()).Volumes[0].project_id);
  const result=await Promise.allSettled([manager.change('POST',{name:'data'}),manager.change('PUT',{name:'data',max_size:5})]);
  assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
});

test('project allocation persists in the agent data volume and resumes without reusing IDs',async t=>{
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {Store}=await import('../../src/config.js');
  const directory=await mkdtemp(tmpdir()+'/agent-quota-persist-');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {manager,docker}=setup(t);
  manager.store=await new Store(directory).load();
  await manager.change('POST',{name:'first',max_size:1024});
  const state=JSON.parse(await readFile(directory+'/volume-quotas.json','utf8'));
  assert.equal(state.next_project,1000001);assert.equal(state.volumes.first.project,1000000);
  manager.store=await new Store(directory).load();
  assert.equal((await manager.list()).Volumes[0].max_size,1024);
  await manager.change('POST',{name:'second',max_size:5120});
  const restarted=await new Store(directory).load();
  assert.equal(restarted.volumeQuotas.next_project,1000002);
  assert.equal(restarted.volumeQuotas.volumes.second.project,1000001);
});

test('quota capability checks are read-only and explain unsupported hosts and permissions',async t=>{
  const {manager,tools,calls}=setup(t);
  const commands=[];
  tools.run=async(tool,args)=>{commands.push([tool,args]);return tool==='id'?'0\n':'setquota version';};
  const status=await manager.capabilities();
  assert.equal(status.available,true);assert.equal(status.filesystem,'ext4');assert.equal(status.device,'8:1');
  assert.deepEqual(commands,[['id',['-u']],['setquota',['--version']]]);
  assert.ok(!calls.some(c=>['create','quota','project','save','remove'].includes(c[0])));
  tools.run=async()=> '1000';
  assert.deepEqual(await manager.capabilities(),{available:false,reason:'Root privileges are required for host volume quotas'});
  tools.filesystem=()=>{throw Error('ext4 mounted with prjquota required');};
  assert.deepEqual(await manager.capabilities(),{available:false,reason:'ext4 mounted with prjquota required'});
});

test('volume listing includes Docker disk usage without requiring project quotas',async t=>{
  const {manager,docker}=setup(t,{enabled:false});
  await manager.change('POST',{name:'ordinary'});
  await manager.change('POST',{name:'empty'});
  await manager.change('POST',{name:'unknown'});
  docker.modem={dial:(options,callback)=>{
    assert.equal(options.path,'/system/df');
    callback(null,{Volumes:[{Name:'ordinary',UsageData:{Size:2621440,RefCount:1}},{Name:'empty',UsageData:{Size:0}},{Name:'unknown',UsageData:{Size:-1}},{Name:'gone'}]});
  }};
  const listed=(await manager.list()).Volumes;
  assert.deepEqual(listed.map(v=>v.UsageData.Size),[2621440,0,-1]);
  assert.equal(listed[0].max_size,undefined);
  docker.modem.dial=(options,callback)=>callback(Error('accounting unavailable'));
  assert.equal((await manager.list()).Volumes.length,3);
});
