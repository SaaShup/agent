# Configuration

| Setting | Default | Behavior |
| --- | --- | --- |
| `PORT` | `1880` | HTTP or HTTPS listen port |
| `HOST` | `0.0.0.0` | HTTP or HTTPS listen address |
| `HTTP_SECURE` | `false` | `true` enables native HTTPS with a persistent self-signed certificate; `false` keeps HTTP. Other values are rejected |
| `ALLOWED_IPS` | empty | Initial comma/space-separated IPv4, IPv6 or CIDR allowlist; enables filtering unless `IP_FILTERING=false` |
| `IP_FILTERING` | `false` (or `true` with initial allowed IPs) | Initial IP-filtering switch; subsequent settings are managed in the UI and persisted |
| `HTTP_SECURE_IP` | absent | Public IPv4 or IPv6 address added to the generated certificate's IP SAN for PaaShup connections by IP |
| `DATAPATH` | `/data` | Persistent JSON files named `config.js` and `registries.js` |
| `API_USERNAME` | `admin` | Username for all HTTP APIs, configuration, dashboard, documentation, metrics and WebSockets |
| `API_PASSWORD` | bcrypt hash of `saashup` | Existing bcrypt hashes remain valid; plaintext secrets are also supported |
| `DISABLE_EXEC` | absent | Any nonempty value disables HTTP command execution and WebSocket execution |
| `DISABLE_SSL_CHECK` | absent | Any nonempty value disables certificate validation for NetBox requests |
| `NETBOX_URL` | persistent value | Overrides the NetBox server URL |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Unix socket, `tcp://host:port`, HTTP or HTTPS Docker endpoint |
| `DOCKER_GID` | `0` | Compose supplementary group for the Docker socket |
| `HEALTHCHECK_PASSWORD` | `saashup` | Plaintext API password used only by the container health probe; set alongside a custom API password |

`config.js` retains `netbox_url`, `netbox_token`, `ui`, `id`, `endpoint`, and `flows` (`"0"`), plus existing unknown keys. `registries.js` retains registry/image associations. These files contain JSON, despite their historical extension; they are never evaluated as JavaScript. Writes are serialized and atomic, with mode 0600. The files are saved on changes, every minute, and on graceful shutdown. HTTP JSON bodies are limited to 1 MiB, collected Docker output to 16 MiB, WebSocket messages to 1 MiB and terminal output buffering to 8 MiB. NetBox requests time out after 15 seconds.

## Native HTTPS on port 1880

No reverse proxy is required. Set the public agent IP before first enabling HTTPS:

```sh
export HTTP_SECURE=true
export HTTP_SECURE_IP=198.51.100.20 # Replace with this agent's public IP
docker compose up -d --build
```

`npm run build` enables HTTPS automatically and includes the SSH and volume-quota overrides. Set `HTTP_SECURE_IP` to the agent's public IP before running it. Direct Compose commands and the other build scripts use the configured `HTTP_SECURE` value, which defaults to `false`.

Connect using `https://198.51.100.20:1880`. The listener serves HTTPS only in secure mode; the dashboard and terminal use HTTPS/WSS. Authentication is still required. Manage application IP allowlisting under Agent settings; a hosting firewall can additionally restrict inbound TCP 1880 before requests reach the agent.

On first secure startup the agent uses OpenSSL (included in the image; also required when running directly with Node) to generate a local self-signed certificate authority and a separate HTTPS server certificate signed by it. Both are valid for 1095 days (three years). The server certificate has `CA:FALSE`, server-authentication usage, and SANs for localhost, both loopback addresses, and `HTTP_SECURE_IP` when configured. The CA has `CA:TRUE` and is the certificate to import into browsers and PaaShup.

The persistent `/data/tls` directory contains:

| File | Contents |
| --- | --- |
| `ca.pem` | CA private key and certificate; mode 0600; keep private |
| `ca.crt` | Public CA certificate for browser and PaaShup trust |
| `server.pem` | HTTPS server private key and certificate; mode 0600; keep private |
| `server.crt` | Public HTTPS server certificate |

Paths follow `DATAPATH` if overridden. Keep the data volume to preserve trust across container recreations. Invalid TLS files stop startup; the agent does not fall back to HTTP. Older installations that served a CA directly are automatically migrated to a separate server certificate while retaining the same CA and key. A CA already imported into Firefox or PaaShup remains trusted after this migration.

In the HTTPS dashboard, open **Agent settings → HTTPS certificate authority → Download certificate (.crt)**. The download contains the public CA, never a private key. In Firefox, open **Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import**, select the downloaded file, and enable **Trust this CA to identify websites**. The server's IP must match the URL in the browser. For first-time access, verify the CA fingerprint through a trusted channel before accepting the certificate and signing in. Alternatively, export the public CA:

```sh
docker compose cp agent:/data/tls/ca.crt ./agent-ca.crt
```

Mount `agent-ca.crt` read-only into the PaaShup container and set `NODE_EXTRA_CA_CERTS=/certs/agent-ca.crt` there, then restart PaaShup. Use `https://AGENT_IP:1880` in its host endpoint with the configured API authentication. Never copy either `.pem` file to PaaShup or disable certificate verification. The health probe trusts the CA and verifies the HTTPS server certificate normally.

Certificates persist across restarts and are not renewed automatically. Before the server certificate expires, stop the agent, back up and remove `tls/server.pem`, and restart to generate a replacement signed by the same CA. The same process updates the server certificate after an IP change. If changing the IP, remove `server.pem` before restarting with the new `HTTP_SECURE_IP`. When the CA expires, back up and replace both `ca.pem` and `server.pem`, then import the new public CA into Firefox and PaaShup. Missing or mismatched CA files stop startup to prevent an accidental change of trusted identity.

Registries are inferred from local image references. The agent refreshes associations at startup, after image operations and pruning, on Docker image events, on registry API reads, and every minute to recover missed events. Empty registries and deleted image references are removed from the local list. Local refreshes work without a Paashup/NetBox connection and retain known registry IDs and server addresses. **Discover registries** additionally synchronizes registry metadata with the configured manager; local refreshes do not create or delete manager inventory records. Unqualified image names are grouped under `dockerhub`. Discovery does not recover registry login credentials.

Use the plugin's normal endpoint registration, the dashboard connection form, or:

```sh
curl -u admin:saashup --get http://localhost:1880/api/engine/endpoint \
  --data-urlencode url=https://netbox.example.com \
  --data-urlencode token=YOUR_TOKEN \
  --data-urlencode id=HOST_ID \
  --data-urlencode endpoint=https://agent.example.com
```

The historical registration route uses a query string: avoid recording it in reverse-proxy access logs. Tokens starting with `ntb_` use Bearer authentication; older tokens use Token authentication. Responses and journals use the plugin's existing field names and bulk callback formats.

`GET /admin/config` and `PATCH /admin/config` use the same `API_USERNAME` / `API_PASSWORD` credentials as the dashboard and other endpoints. `ENABLE_EDITOR` is retired and can be removed from deployment configuration. PATCH accepts the five connection/UI configuration fields. The legacy `/nodered` route has been removed.

For optional SSH key management, see [host SSH keys](HOST-SSH-KEYS.md). Return to the [quick start](../README.md).


## IP access control

Open **Agent settings → IP access control** to enable filtering and manage IPv4 addresses, IPv6 addresses and CIDR ranges. **Add my current IP** adds the actual peer address observed by the agent. Saving changes takes effect immediately for dashboard pages, APIs, certificate downloads and terminal upgrades. Existing terminal sessions from newly blocked addresses are terminated. API authentication remains required. Forwarding headers such as `X-Forwarded-For` are ignored; if a proxy or NAT is in front of the agent, the observed peer is its address.

The agent saves rules in `/data/access-control.json` independently of manager connection settings, but disconnecting PaaShup resets the complete ACL: all IP/CIDR entries are removed, the recorded manager IP is cleared, and filtering is disabled. Active terminals and reserved terminal paths are cleared too. This fresh state persists across restarts and allows a different PaaShup server to register using valid agent credentials. Registration adds the new server’s IP to the empty list and automatically enables filtering. Empty `ALLOWED_IPS` and no persisted policy keep filtering disabled for compatibility. To seed a new installation:

```sh
export ALLOWED_IPS="203.0.113.10,198.51.100.20/32" # PaaShup outbound IP and administrator IP
npm run build
```

`ALLOWED_IPS` and `IP_FILTERING` initialize a policy only when no persisted policy exists. Once saved, manage it through the UI or `GET /admin/access-control` / `PUT /admin/access-control`. PUT takes `{ "enabled": true, "allowed_ips": ["203.0.113.10", "198.51.100.20"] }`. Invalid entries are rejected before saving. A remote administrator cannot enable rules that exclude their current address or remove their own access.

The agent always appends PaaShup's actual source IP and enables filtering during authenticated server registration, preserving existing administrator entries and avoiding duplicates. The enabled state is persisted, and existing terminal connections from excluded IPs are closed. There is no learning switch. The UI displays the last registered PaaShup address. Complete server registration requests may reach the authentication check even from a new, unlisted IP when filtering is enabled; successful authentication and a valid manager URL are required before the IP is added. Other requests remain blocked. Browser-originated registration, missing credentials, incomplete registration and invalid manager URLs do not add an IP. Existing persisted learning flags are ignored.

**Recovery:** loopback (`127.0.0.0/8` and `::1`, including mapped IPv4) remains allowed for authenticated health probes and local recovery. From the agent container, use the API on localhost to disable filtering or replace the list. Alternatively, stop the agent and update the persisted `access-control.json` file before restarting. A proxy on localhost can make all proxied clients appear local; use direct connections or enforce filtering at the proxy in that deployment. These application rules do not replace a network firewall.
