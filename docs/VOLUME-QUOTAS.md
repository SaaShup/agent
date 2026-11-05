# Docker named volumes with ext4 project quotas

The agent checks the Docker host's filesystem and manages quotas by invoking
standard Linux tools: `findmnt`, `lsblk`, `setquota`, `repquota`, `chattr`, and
`lsattr`. There is no custom C module, Python code, separate service, or host
script. Commands use argument arrays without a shell.

Volumes are ordinary Docker `local` named volumes with no driver mount options.
The agent assigns a project ID and project inheritance to the volume's `_data`
directory and sets a hard block quota. Files written by all containers using the
volume share that quota. This works independently of Docker's image storage
driver, including overlay2. Volume storage uses no bind mounts, tmpfs, loop
devices, or replacement filesystem.

## Run the agent with host quota access

The Linux host must support ext4 project quotas and run rootful Docker. Its Docker
volume storage must already reside on a real ext4 filesystem with the `project` and
`quota` features, mounted with `prjquota`. The agent verifies the actual directory
with `findmnt`, checks its backing devices with `lsblk`, then probes
project quota support with `repquota` before creating a managed volume. Unsupported
storage or insufficient privileges returns an error without creating a volume.

From the checkout:

```sh
npm run build:quota
```

### Enable SSH key management and quotas together

Point the SSH mount at an existing `authorized_keys` file, then run:

```sh
export SSH_AUTHORIZED_KEYS_FILE="$HOME/.ssh/authorized_keys"
export SSH_KEYS_UID="$(id -u)" SSH_KEYS_GID="$(id -g)"
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
npm run build
```

The equivalent Compose command is:

```sh
docker compose -f docker-compose.yml -f docker-compose.ssh.yml -f docker-compose.quotas.yml up -d --build
```

Keep the quota override last: it sets the agent user to root. The SSH override
passes `SSH_KEYS_UID` separately so the agent still checks the host file's actual
owner, preserves its ownership and permissions, and accepts existing backups
owned by that user. The main file provides the Docker socket and persistent data;
the two overrides enable features on that same agent. SSH uses a file bind mount;
Docker volume storage still uses real named volumes.

The quota Compose override runs the **agent itself as root, privileged, with the
host PID namespace** and `VOLUME_QUOTA_HOST_ROOT=/proc/1/root`. It accesses the
host's existing Docker directories through that host root. The image includes
`nsenter`; the agent uses it to run the host's tools in the host mount namespace and root, so they see the correct filesystems and quota
tables. Install the standard tools on the Docker host (Debian/Ubuntu example):

```sh
sudo apt-get install quota e2fsprogs util-linux
```

No host service or script needs to be installed. Docker Compose must support the
`!reset` override tag (2.24.4+).

This deployment grants the agent host administration privileges; restrict its
API credentials and network access accordingly. The default Compose deployment
remains unprivileged and supports ordinary unlimited volumes. Limited volumes
require the quota deployment above. The filesystem's project quota features and
mount option are prerequisites: the agent does not reformat, unmount, or modify
the host's filesystem configuration. If these prerequisites are absent, the
agent reports the reason so the administrator can prepare the existing ext4
filesystem during an appropriate maintenance window.

For an agent running directly on the host, install the same standard tools,
run with root quota privileges, and set `VOLUME_QUOTA_HOST_ROOT=/`. The agent
executes tools directly in this mode. Remote Engines, rootless Docker, Docker
Desktop VMs, non-ext4 storage, loop devices (including stacked loop devices), and
local driver bind/tmpfs options are unsupported. The agent must use the host's
`/var/run/docker.sock`. Missing tools or permissions produce a clear 503 error.

## Real-host test and CI

`npm run test:quota` probes the actual Docker host using the same capability
checks as the agent. On a supported host it creates a temporary real named
volume, verifies that writes fail with `EDQUOT` at a 16 MiB limit, increases the
limit and verifies further writes, rejects a shrink below usage, removes the
limit and writes beyond the previous limit, then deletes the test volume.
Test containers and allocator state are isolated and cleaned up.

On unsupported hosts, the Node test reports **SKIP** with the capability failure
reason. A failed Docker connection or a failed enforcement assertion fails the
test. Insufficient test capacity (less than 64 MiB) also produces an explicit
skip. The test never prepares, reformats, or remounts host storage. It pulls
`node:24-alpine` only after support is confirmed; `QUOTA_TEST_IMAGE` can select
another image with Node.js installed.

For a direct host run with quota privileges:

```sh
sudo env PATH="$PATH" VOLUME_QUOTA_HOST_ROOT=/ npm run test:quota
```

The standard `npm test` includes this probe. GitHub Actions runs it in a separate
job with root access and host tools installed and uploads its log, so the result
records whether the runner actually supports project quotas. Unsupported GitHub
runner storage skips enforcement instead of using a loopback filesystem.

## Overview status

The Overview page displays **Volume quotas: Available** or **Unavailable**.
Setup snippets, installation commands, and detailed failure messages are not
shown there. `GET /info` retains the full `volumeQuotas` result, including the
reason when quotas are unavailable, for troubleshooting.

The check reads filesystem, project attributes, and quota information and checks
root access and `setquota` availability. It does not create a volume or change
any quota; actual enforcement is confirmed when a managed volume is created.

## Troubleshooting unavailable quotas

The installation and Compose commands above install packages and start the agent
with host access. They do **not** enable ext4 filesystem features or add `prjquota` to the host mount.
Repeating package installation or rebuilding the agent cannot fix missing
filesystem quota support.

Check the `volumeQuotas.reason` field in `GET /info` and inspect the host storage:

```sh
quota_docker_root="$(docker info --format '{{.DockerRootDir}}')"
sudo findmnt --target "$quota_docker_root/volumes" --output TARGET,SOURCE,FSTYPE,OPTIONS
```

Also check that the running agent has the expected host access:

- The host `findmnt` output must show `ext4` and `prjquota`.
- The agent `id` output should show `uid=0`.
- The agent environment should show `/proc/1/root`.
- `findmnt` executed through the agent's `nsenter` should report the same storage
  as the command on the host. A failure here identifies missing container access.

If `prjquota` is absent, filesystem preparation is still required. The commands
for that depend on the actual block device, filesystem features, mount point,
and whether this is the host root filesystem. Determine those before changing
filesystem features or mount configuration; root filesystem preparation can
require a maintenance reboot. Device-specific changes require an appropriate maintenance procedure.

## Create, inspect, change, and remove volumes

Choose **Volumes → Create volume** and select 1 GiB, 5 GiB, 10 GiB, or unlimited.
The form provides Name, Type (Local), and Storage limit fields. When quotas are
unavailable, the storage selector is disabled at Unlimited. Custom integral MiB
limits can be supplied through the API. Volume cards show **Used** storage and **Size**. Managed volumes use the live
project quota limit and usage, with a usage bar for limited volumes. Ordinary
local volumes show **Unlimited** and usage from Docker disk accounting. Missing
usage is shown as **Unavailable**, rather than zero. Managed volumes also
provide **Change limit**.

### Storage capacity checks

The existing creation and resize API rejects a quota increase with HTTP 409 when
it would exceed the remaining storage budget. The agent reads free, unreserved
blocks on the filesystem containing Docker's volumes, then subtracts the unused
portion of each live, agent-managed quota. Already used blocks are counted by
the filesystem and are not subtracted twice. A resize credits the volume's
existing allocation; reductions and removing a limit remain possible when the
filesystem is overcommitted. Deleting a volume releases its allocation.

The volume form shows the capacity available for that volume and disables limits
that exceed it or fall below current usage. `GET /info` exposes the same snapshot
in `volumeQuotas.capacity`: `free_bytes`, `reserved_bytes`, `available_bytes`, and
per-volume `name`, `limit_bytes`, and `usage_bytes`. The API recalculates capacity
inside its serialized mutation queue before applying a new or larger quota.

These are allocation checks, not physical disk reservations. Unlimited volumes,
external applications, other agent instances, and host administrators can still
consume or allocate storage. Unlimited volumes reserve no future capacity, but
their existing data reduces filesystem free space. For predictable capacity,
use a dedicated filesystem with limited volumes managed by one agent.

```http
POST /api/engine/volumes
Content-Type: application/json

{"data":{"name":"app-data","driver":"local","max_size":1024}}
```

Update the existing quota without recreating the volume or its containers:

```http
PUT /api/engine/volumes
Content-Type: application/json

{"data":{"name":"app-data","max_size":5120}}
```

`max_size` is MiB: `1024`, `5120`, `10240`, or `0` for unlimited. Omission means
unlimited. Negative, fractional, string, null, and unsafe values are rejected.
Setting `0` clears the hard limit and retains the project ID for future changes.
A reduction below current allocated usage returns 409. Quotas count allocated
blocks, not logical file lengths; further allocations fail with `EDQUOT` at the
hard limit. Host free space can run out first. Limits do not reserve space and do
not restrict inode counts.

`GET /api/volumes` preserves Docker's response and adds `max_size`, `usage_bytes`,
and `project_id` for managed volumes, read from the kernel. An existing name
returns 409 on creation. Existing unmanaged volumes cannot be adopted or resized;
create a managed volume and migrate data explicitly. Volume POST, PUT and DELETE
return the existing 202 echo after the operation completes, or an error directly.
Docker's normal in-use deletion protection remains in effect.

When host quota access is enabled, unlimited volumes also get a project ID with
no hard limit, allowing later changes. In the default unprivileged deployment,
unlimited volumes use ordinary Docker storage. Limited creation fails with 503
when host access, required tools, or ext4 project quota enforcement is
unavailable.

## Persistence and recovery

The agent stores its monotonic allocation counter and managed volume identities
in `volume-quotas.json` in its existing data directory (`/data` by default).
Back up this file with the agent data and volumes; never reset or delete it while
managed volumes or their quotas exist. Reserve project IDs **1000000 through
2147483647** exclusively for this agent on the backing filesystem. Existing IDs
with usage or limits are rejected. Run one quota-managing agent per Docker host.

Project IDs, inheritance, and limits persist in ext4 across agent, Docker, and
host restarts. IDs are never reused, even after external Docker removal/prune.
Deletion removes the volume before clearing its quota. Creation reserves the ID
durably before creating the volume, then applies the limit before inheritance.
Failed setup attempts non-forced Docker removal. If a crash or external attachment
interrupts setup, incomplete project identities cause an error; detach/remove the
incomplete volume using Docker and recreate it. Do not attach an incomplete
volume or manually change project IDs.

The agent serializes quota mutations and blocks its pruning during mutations.
Host administrators and direct Docker clients must coordinate external creates,
attachments and removals with it. Do not run multiple agents against the same
Docker host or assign IDs from the agent's reserved range using another tool.

## Verification

`npm run test:unit` covers command construction and output parsing as well as
agent lifecycle, filesystem checks, allocation, creation rollback, resizing,
usage, persistence, isolation, and deletion safety. The browser test exercises
create, change, and delete through the dashboard.

On a prepared host, verify enforcement using an ordinary container attached to a
small managed volume: write beyond the quota and confirm `Disk quota exceeded`,
raise the limit and repeat, then set unlimited and repeat. Verify two volumes have
separate quotas and that a retained volume remains limited after an agent/host
restart. No loopback filesystem is needed for any deployment test.

Tools: [setquota](https://man7.org/linux/man-pages/man8/setquota.8.html),
[repquota](https://man7.org/linux/man-pages/man8/repquota.8.html), and
[chattr](https://man7.org/linux/man-pages/man1/chattr.1.html).

For a 1 GiB limit, the agent runs the equivalent of
`setquota -P PROJECT_ID 0 1048576 0 0 MOUNTPOINT` (limits are in KiB), then
`chattr -p PROJECT_ID +P VOLUME_DATA_DIRECTORY`. It verifies identity with
`lsattr -d -p` and reads live limits/allocated usage using
`repquota -P -n -v -O csv MOUNTPOINT`. Setting the hard limit to `0` makes the
volume unlimited without changing its project ID.
