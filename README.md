# Agent

[![version](https://img.shields.io/github/v/tag/SaaShup/agent?label=version)](https://github.com/SaaShup/agent/tags)
[![node](https://img.shields.io/badge/node-24--alpine-6cc24a)](Dockerfile)
[![license](https://img.shields.io/github/license/SaaShup/agent)](LICENSE)
[![last commit](https://img.shields.io/github/last-commit/SaaShup/agent)](https://github.com/SaaShup/agent/commits/main)
[![repo size](https://img.shields.io/github/repo-size/SaaShup/agent)](https://github.com/SaaShup/agent)
[![top language](https://img.shields.io/github/languages/top/SaaShup/agent)](https://github.com/SaaShup/agent)
[![Tests](https://img.shields.io/github/actions/workflow/status/SaaShup/agent/pr_ci.yml?label=Tests&logo=github)](https://github.com/SaaShup/agent/actions/workflows/pr_ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](package.json)
[![image](https://img.shields.io/badge/image-ghcr.io%2Fsaashup%2Fagent-2496ed?logo=docker&logoColor=white)](https://github.com/SaaShup/agent/pkgs/container/agent)

Manage a VM's host and it's Docker Engine from [Paashup](https://github.com/SaaShup/paashup) or the [NetBox Docker plugin](https://github.com/SaaShup/netbox-docker-plugin), with a local dashboard and API.

![Paashup connects to the Agent inside a VM. The agent controls the local Docker Engine through its Unix socket and sends inventory, events, and journals back to Paashup.](docs/images/paashup-agent-architecture.svg)

## User quick start

Requires Docker Engine and Docker Compose on the VM. From this checkout:

```sh
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose up -d --build
```

Open **http://localhost:1880** and sign in with `admin` / `saashup`.

Before exposing the agent, set `API_USERNAME`, `API_PASSWORD`, and `HEALTHCHECK_PASSWORD` (the plaintext API password), then recreate the container. Docker socket access grants control of the host; restrict access and use HTTPS through a reverse proxy.

Use **Agent settings** to connect to Paashup/NetBox, or register the endpoint from the plugin. The dashboard also works standalone. Registry lists stay synchronized with local images.

The agent stores configuration in the persistent `/data` volume. Follow logs or stop it with:

```sh
docker compose logs -f
docker compose down
```

For optional host SSH key management, follow the [SSH setup guide](docs/HOST-SSH-KEYS.md).

## Developer quick start

Requires Node.js 24 or newer and access to a Docker Engine.

```sh
npm ci
DATAPATH=./data npm start
```

The dashboard runs at **http://localhost:1880**. Open **http://localhost:1880/doc** for interactive API documentation.

```sh
npm run test:unit      # unit, integration, and security tests
npm run codeql:install # one-time local CodeQL installation
npm test              # also runs CodeQL, Docker compatibility, and browser tests
```

The full suite requires Docker Compose, privileged containers, and registry network access. See [development and testing](docs/DEVELOPMENT.md) for individual suites and test setup.

## Guides

- [Configuration and Paashup/NetBox connection](docs/CONFIGURATION.md)
- [API and dashboard operations](docs/OPERATIONS.md)
- [Pruning](docs/PRUNING.md)
- [Monitoring](docs/MONITORING.md)
- [Host SSH key management](docs/HOST-SSH-KEYS.md)
- [Development and testing](docs/DEVELOPMENT.md)
- [Migration from 1.x](docs/MIGRATION.md)
