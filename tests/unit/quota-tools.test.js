import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaTools } from '../../src/volumes.js';
const header='Project,BlockStatus,FileStatus,BlockUsed,BlockSoftLimit,BlockHardLimit,BlockGrace,FileUsed,FileSoftLimit,FileHardLimit,FileGrace\n';
function setup(root='/') {
  const calls=[];let report=header, attributes='1000000 -------------------P-- /var/lib/docker/volumes/data/_data\n';
  let mount={fstype:'ext4',source:'/dev/sda1',target:'/',options:'rw,prjquota'},devices='part\ndisk\n';
  const tools=new QuotaTools(root,async(tool,args,options)=>{
    calls.push({tool,args,options});
    if(tool==='nsenter'){tool=args[6];args=args.slice(7);}
    let stdout='';
    if(tool==='findmnt')stdout=JSON.stringify({filesystems:[mount]});
    if(tool==='lsblk')stdout=devices;
    if(tool==='repquota')stdout=report;
    if(tool==='lsattr')stdout=attributes;
    return {stdout,stderr:''};
  });
  return {tools,calls,setReport:value=>{report=value;},setAttributes:value=>{attributes=value;},setMount:value=>{mount=value;},setDevices:value=>{devices=value;}};
}

test('setquota and chattr use correct units and inheritance with no shell',async()=>{
  const {tools,calls}=setup();
  assert.equal(await tools.filesystem('/var/lib/docker/volumes'),'/dev/sda1');
  await tools.quota('/var/lib/docker/volumes/data/_data',1000000,1024);
  assert.deepEqual(calls.find(c=>c.tool==='setquota').args,['-P','1000000','0','1048576','0','0','--','/']);
  assert.deepEqual(await tools.project('/var/lib/docker/volumes/data/_data',1000000),{id:1000000,inherit:true});
  assert.deepEqual(calls.find(c=>c.tool==='chattr').args,['-p','1000000','+P','--','/var/lib/docker/volumes/data/_data']);
  for(const call of calls){assert.equal(call.options.shell,undefined);assert.equal(call.options.timeout,60000);assert.equal(call.options.env.LC_ALL,'C');}
  await tools.quota('/var/lib/docker/volumes',1000000,0);
  assert.deepEqual(calls.filter(c=>c.tool==='setquota').at(-1).args.slice(2,6),['0','0','0','0']);
});

test('repquota CSV preserves large IDs, block units, empty entries, and malformed reports fail closed',async()=>{
  const {tools,setReport}=setup();
  assert.equal((await tools.quota('/var/lib/docker/volumes',1000000)).max_size,0);
  setReport(header+'#99,ok,ok,4,0,0,,1,0,0,\n#1000000,ok,ok,4096,0,5242880,,2,3,4,\n');
  assert.deepEqual(await tools.quota('/var/lib/docker/volumes',1000000),{max_size:5120,soft:0,usage_bytes:4194304,inodes:2,inode_soft:3,inode_hard:4});
  setReport('bad');await assert.rejects(tools.quota('/var/lib/docker/volumes',1000000),{statusCode:503});
  setReport(header+'#1000000,ok,ok,bad,0,1024,,2,0,0,\n');await assert.rejects(tools.quota('/var/lib/docker/volumes',1000000),{statusCode:503});
});

test('findmnt and lsblk reject unsupported mounts and loop devices before quota writes',async()=>{
  const {tools,calls,setMount,setDevices}=setup();
  for(const mount of [undefined,{fstype:'xfs'},{fstype:'ext4',options:'rw'},{fstype:'ext4',options:'prjquota',source:'tmpfs'},{fstype:'ext4',options:'prjquota',source:'/dev/sda1[/bind]'}]){
    setMount(mount);await assert.rejects(tools.filesystem('/var/lib/docker/volumes'),{statusCode:503});
  }
  setMount({fstype:'ext4',source:'/dev/sda1',target:'/',options:'rw,prjquota'});
  for(const devices of ['loop\n','lvm\nloop\n','']){setDevices(devices);await assert.rejects(tools.filesystem('/var/lib/docker/volumes'),{statusCode:503});}
  assert.ok(!calls.some(c=>c.tool==='setquota'));
});

test('lsattr reads project IDs and validates output',async()=>{
  const {tools,setAttributes}=setup();
  setAttributes('0 --------------e------- /path');assert.deepEqual(await tools.project('/path'),{id:0,inherit:false});
  await assert.rejects(tools.project('/path',1000000),/chattr did not apply/);
  setAttributes('1000000 --------------e------- /path');await assert.rejects(tools.project('/path',1000000),/chattr did not apply/);
  setAttributes('invalid');await assert.rejects(tools.project('/path'),{statusCode:503});
});

test('container commands enter the host mount namespace and root using argument arrays',async()=>{
  const {tools,calls}=setup('/proc/1/root');
  await tools.filesystem('/proc/1/root/var/lib/docker/volumes');
  assert.deepEqual(calls[0].args,['--target','1','--mount','--root=/proc/1/root','--wd=/','--','findmnt','--json','--target','/var/lib/docker/volumes','--output','FSTYPE,SOURCE,OPTIONS,TARGET']);
  assert.equal(calls[0].tool,'nsenter');
  assert.equal(new QuotaTools().root,'/');
});

test('missing tools, stderr diagnostics, and permission failures return clear errors',async()=>{
  for(const error of [Object.assign(Error('not installed'),{code:'ENOENT'}),Object.assign(Error('failed'),{stderr:'Permission denied\n'})]){
    const tools=new QuotaTools('/',async()=>{throw error;});await assert.rejects(tools.run('setquota',[]),{statusCode:503});
  }
  const tools=new QuotaTools('/',async()=>({stdout:header,stderr:'Cannot scan quotas'}));
  await assert.rejects(tools.run('repquota',[]),/Cannot scan quotas/);
});

test('missing host tools show their installation command, including nsenter execution errors',async()=>{
  for(const [tool,pkg] of [['findmnt','util-linux'],['lsblk','util-linux'],['setquota','quota'],['repquota','quota'],['chattr','e2fsprogs'],['lsattr','e2fsprogs'],['id','coreutils']]){
    const tools=new QuotaTools('/',async()=>{throw Object.assign(Error('not installed'),{code:'ENOENT'});});
    await assert.rejects(tools.run(tool,[]),error=>error.statusCode===503&&error.message.includes(`sudo apt-get install ${pkg}`)&&error.message.includes('Docker host'));
  }
  const tools=new QuotaTools('/proc/1/root',async()=>{throw Object.assign(Error('command failed'),{stderr:'nsenter: failed to execute findmnt: No such file or directory'});});
  await assert.rejects(tools.run('findmnt',[]),/sudo apt-get install util-linux/);
  tools.execute=async()=>{throw Object.assign(Error('spawn nsenter ENOENT'),{code:'ENOENT'});};
  await assert.rejects(tools.run('findmnt',[]),/Rebuild the agent image/);
});

test('storage access and permission failures do not suggest installing tools',async()=>{
  const tools=new QuotaTools('/',async()=>{throw Object.assign(Error('Command failed: findmnt'),{code:1,stderr:''});});
  await assert.rejects(tools.run('findmnt',['--json','--target','/var/lib/docker/volumes']),error=>error.message.includes('Cannot access Docker volume storage at /var/lib/docker/volumes')&&!error.message.includes('apt-get'));
  tools.execute=async()=>{throw Object.assign(Error('failed'),{stderr:'findmnt: unrecognized option'});};
  await assert.rejects(tools.run('findmnt',[]),/Host findmnt failed: findmnt: unrecognized option/);
  for(const failure of [Object.assign(Error('failed'),{code:'EACCES'}),Object.assign(Error('failed'),{code:'EPERM'}),Object.assign(Error('failed'),{stderr:'Operation not permitted'})]){
    tools.execute=async()=>{throw failure;};
    await assert.rejects(tools.run('findmnt',[]),error=>error.message.includes('lacks permission')&&!error.message.includes('apt-get'));
  }
});
