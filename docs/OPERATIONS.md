# API and operations

The service preserves `/info`, `/system/usage`, `/metrics`, `/api/{containers,images,networks,volumes,registries}`, `/api/engine/:type`, container exec/logs/stats/WebSocket setup, `/doc`, `/openapi`, and `/`. See the local API reference or [OpenAPI JSON](../public/openapi.json).

Resource reads return live Docker data. Containers return complete inspect records; volumes return `{Volumes, Warnings}`. Engine routes acknowledge with HTTP 202 and process asynchronously. The response echoes the write body (reads acknowledge with `{}`). Poll the live resource route for the result; an acknowledgment alone does not prove Docker or NetBox accepted an operation. Failures are logged and journaled to NetBox when configured.

Container operations: start, stop, restart, kill, pause, unpause, rename, update restart policy (`none`), and recreate. Recreation maps the plugin's image, hostname, environment, labels, command, capabilities, PID mode, security options, devices, mounts/binds, network attachments, ports, restart policy, logging, sysctls and optional memory/CPU limits. Failed replacement creation/start restores the original name and running state.

## Container memory and CPU limits

Both `POST /api/engine/containers` (create) and `PUT /api/engine/containers` with `operation: "recreate"` accept these optional fields inside `data`:

| Field | Unit | Default | Accepted values |
| --- | --- | --- | --- |
| `memory_limit` | Bytes | `0` (unlimited) | `0`, or an integer of at least 6291456 (6 MiB), up to JavaScript's maximum safe integer |
| `cpu_limit` | CPU cores | `0` (unlimited) | `0`, or a positive number; fractions such as `0.5` and `1.5` are supported |

Either limit can be supplied independently. Omitted fields keep the previous unlimited behavior, including during recreation; send the desired limits when recreating a limited container. Set a field to `0` to remove its limit. Values must be JSON numbers, not strings such as `"512m"` or `"1.5"`; `null` and negative values are rejected. CPU cores map to Docker `NanoCpus` by multiplying by one billion and rounding to a safe integer; a positive value must round to at least one nanocpu. Docker additionally validates limits against the daemon's CPU capacity and resource-controller support.

For example, create a container limited to 512 MiB and 1.5 CPU cores:

```sh
curl -u admin:saashup http://localhost:1880/api/engine/containers \
  -H 'Content-Type: application/json' \
  -d '{"data":{"name":"limited-app","state":"none","image":{"name":"nginx","version":"alpine"},"memory_limit":536870912,"cpu_limit":1.5}}'
```

To change an existing container's limits, send its complete desired recreation configuration with `PUT`, including `ContainerID`, `name`, `image`, `operation: "recreate"`, and the limit fields. Use the dashboard's **Configuration → Edit configuration** editor to start from its current supported settings. The creation template exposes both fields with `0` defaults. Inventory synchronization and operation callbacks report current limits using these same field names; the editor carries them forward when recreating. `operation: "none"` continues to update only restart policy and optional name; it does not apply resource limits.

Invalid limit values return HTTP 400 before work is queued or the original container is stopped. Valid requests return the usual HTTP 202 acknowledgment; daemon failures are logged/journaled asynchronously, and failed recreation restores the original container and its limits. Live inspect responses expose the effective settings under `HostConfig.Memory` and `HostConfig.NanoCpus`.

Docker events reconnect automatically. External container lifecycle events update the matching NetBox container by host and name. Lifecycle events triggered during an agent operation are gated; pause/unpause events remain synchronized. The startup check reports the agent version and requests a host refresh after an upgrade. Endpoint refresh deletes supplied resource IDs and repopulates inventory. Empty ID lists require no DELETE. For Paasbox, which purges inventory before notifying the agent, an HTTP 405 from a bulk DELETE does not prevent inventory import. Other deletion failures still stop refresh.

Settings saves (`operation: none`) still apply the restart policy and optional rename. Settings saves and explicit renames write their journals without PATCHing the container back to the manager, matching the legacy flow. This prevents callback webhooks from starting a journal loop and preserves configuration staged for recreation. Docker events send one PATCH containing runtime state to the container detail endpoint.

The terminal keeps the existing `/ws/engine/containers/:id/exec` route and byte-code protocol. Request its path with `POST /api/engine/containers/:id/ws` first. The synchronous HTTP exec route retains its historical `text/plain` JSON envelope. With `DISABLE_EXEC` set it returns a 200 exec-options echo without executing; disabled WebSocket setup returns 403. Both setup and upgrade require API credentials, and browser upgrades must be same-origin. The dashboard supports shell selection, keyboard input, paste, terminal resize, output and session closure. External clients can use `src/exec-client.js` or the existing protocol with authenticated upgrades.

## Dashboard

The Overview shows resource totals, host details, and disk allocation. The agent cannot recreate its own container: the API rejects this operation with HTTP 403, and its container card has no Recreate or Edit configuration control. Other containers can still be recreated.

At `/doc`,Swagger UI provides **Try it out** and **Execute** for sending requests to the agent, editing parameters/JSON bodies, and inspecting response status, headers and body. It uses the current dashboard authentication; **Authorize** can supply API credentials for all endpoints, including `/admin/config`. Authorizations are not persisted. The OpenAPI definition and UI assets are served locally, with external validation disabled.

See [pruning](PRUNING.md), [monitoring](MONITORING.md), and [configuration](CONFIGURATION.md) for detailed guides. Return to the [quick start](../README.md).
