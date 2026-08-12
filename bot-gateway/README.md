# RyanAI Bot Gateway

This directory is an independent Node.js sidecar for forwarding personal WeChat and QQ bot messages into RyanAI. RyanAI remains the only inference, memory, permission, quota, and tool runtime. OpenClaw is used only as the host required by Tencent's official channel plugins.

## Current integration status

- The gateway core, HMAC transport, multipart attachments, SQLite WAL replay protection, fair global backpressure, per-conversation serialization, response segmentation, encrypted credentials, canonical control API, Prometheus metrics, Docker image, and tests are implemented.
- `BOT_GATEWAY_ADAPTER=openclaw` starts an embedded, loopback-only OpenClaw host and loads Tencent's pinned official WeChat and QQ channel plugins plus the local `ryanai-bridge` plugin. No separate OpenClaw deployment is required.
- `ryanai-bridge` claims inbound messages with OpenClaw's typed `inbound_claim` hook before Agent routing. Success, ignored, validation-error, and transport-error paths are all handled in the bridge; `before_agent_reply` remains a fail-closed compatibility guard. RyanAI is the only inference, memory, permission, quota, and tool runtime.
- Shared topology is the default: up to 12 accounts of one channel share an OpenClaw shard process, while each event remains authoritatively routed to its RyanAI connection. `BOT_GATEWAY_OPENCLAW_TOPOLOGY=isolated` remains available as an emergency rollback.
- In normal product mode RyanAI SQL is authoritative for connections, assignments, encrypted credentials, and account checkpoints. The local encrypted vault remains available for standalone development and migration compatibility.
- Redis coordination is optional and used only for multi-node deployments. It provides node heartbeats, sticky target nodes, CAS leases, fencing epochs, drain state, and scheduler leadership; single-node mode has no Redis dependency.
- Health reports sidecar/embedded-host availability, not account authentication. A running host remains healthy while a channel is logged out or waiting for QR login; connection snapshots expose login state separately.
- `BOT_GATEWAY_ADAPTER=mock` remains a developer-only fixture and never connects to Tencent.

Pinned runtime versions:

| Package                            | Version                             |
| ---------------------------------- | ----------------------------------- |
| Node.js                            | `>=22.22.3` (Docker uses `22.22.3`) |
| `openclaw`                         | `2026.7.1-2`                        |
| `@tencent-weixin/openclaw-weixin`  | `2.4.6`                             |
| `@tencent-connect/openclaw-qqbot`  | `2.0.0`                             |
| `@tencent-connect/qqbot-connector` | `1.2.0`                             |

## Configuration contract

Required production configuration:

| Variable                                  | Default / format                                                  |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `BOT_GATEWAY_ENABLED`                     | `false`; disabled mode requires no secrets and starts health only |
| `BOT_GATEWAY_INTERNAL_PORT`               | `8787`                                                            |
| `BOT_GATEWAY_HMAC_SECRET`                 | Required, at least 32 characters                                  |
| `BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY`  | Required, exactly 32 random bytes as base64 or 64 hex characters  |
| `BOT_GATEWAY_DATA_DIR`                    | `/data`                                                           |
| `RYANAI_BASE_URL`                         | `http://ryanai:8080`                                              |
| `BOT_GATEWAY_WECHAT_ENABLED`              | `false` unless explicitly enabled                                 |
| `BOT_GATEWAY_QQ_ENABLED`                  | `false` unless explicitly enabled                                 |
| `BOT_GATEWAY_ADAPTER`                     | `openclaw`; use `mock` only for tests                             |
| `BOT_GATEWAY_OPENCLAW_STATE_DIR`          | OS temporary directory; Docker uses `/data/openclaw/state`        |
| `BOT_GATEWAY_OPENCLAW_HOME_DIR`           | OS temporary directory; Docker uses `/data/openclaw/home`         |
| `BOT_GATEWAY_OPENCLAW_PORT`               | `18789`, bound to loopback inside the sidecar                     |
| `BOT_GATEWAY_OPENCLAW_STARTUP_TIMEOUT_MS` | `180000`                                                          |
| `BOT_GATEWAY_OPENCLAW_TOPOLOGY`           | `shared`; set `isolated` for one child per connection             |
| `BOT_GATEWAY_COORDINATION_MODE`            | `single`; set `redis` only for a multi-node deployment            |
| `BOT_GATEWAY_NODE_ID`                      | Stable unique node ID; required in Redis mode                     |
| `BOT_GATEWAY_ADVERTISE_URL`                | Reachable control URL; required in Redis mode                     |
| `REDIS_URL`                                | Required in Redis mode                                            |

When `BOT_GATEWAY_ENABLED=false`, the process does not initialize the state store, credential vault, RyanAI client, or any channel adapter. `GET /health` returns HTTP 200 with `status: "disabled"`; every `/v1/*` request returns HTTP 503 with error code `disabled`. The HMAC and encryption keys are required only when `BOT_GATEWAY_ENABLED=true`.

`BOT_GATEWAY_ADAPTER` is `openclaw` by default or `mock` for the test harness. Backpressure defaults are 16 global active events, 4 active events per connection, 1000 globally queued events, 100 per connection, 128 MiB queued payload, and a 30-second maximum queue wait. Every queue has both count and byte limits.

RyanAI's scheduler defaults to `BOT_GATEWAY_SCHEDULER_MODE=shadow`, so it previews sticky, load-aware moves without applying them. `static` also disables rebalance application and `auto` enables control-plane assignment updates. Auto mode moves at most one connection every two minutes, limits hourly impact to 10% of active shards (at least one), and gives each moved connection a 30-minute cooldown.

Each gateway keeps decayed per-connection 5-minute and 30-minute runtime observations and reports event rate, processing seconds per minute, attachment MiB per minute, ten-minute error count, and consecutive deterministic account failures in its control-plane heartbeat. Redis mode accepts a sample only from the current lease owner at the current assignment generation; single-node mode reports it best-effort without making the gateway depend on RyanAI availability. The scheduler converts the higher recent or sustained signal into 1-12 load units, isolates accounts at 8 units or after three deterministic account-error samples, splits only after a shard exceeds 120% capacity for three one-minute windows, and merges only after it remains below 40% for 30 windows.

The OpenClaw attachment bridge only reads local files under trusted roots. `BOT_GATEWAY_ATTACHMENT_ROOTS` can add platform path-delimiter-separated roots; the configured OpenClaw state/home media directories are included automatically.

## Developer-only mock test fixture (not a channel integration)

```powershell
cd D:\RyanAI\bot-gateway
npm install
$env:BOT_GATEWAY_HMAC_SECRET = 'replace-with-at-least-32-random-characters'
$env:BOT_GATEWAY_ENABLED = 'true'
$env:BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:BOT_GATEWAY_DATA_DIR = (Join-Path $PWD 'data')
$env:RYANAI_BASE_URL = 'http://127.0.0.1:8080'
$env:BOT_GATEWAY_WECHAT_ENABLED = 'true'
$env:BOT_GATEWAY_QQ_ENABLED = 'true'
$env:BOT_GATEWAY_ADAPTER = 'mock'
npm run build
npm start
```

The mock adapter exists only for automated gateway/backend contract tests. It starts logged out; signed test calls can log it in and inject events through `POST /v1/mock/events`. Mock QR data is explicitly marked `mock: true`, is not a Tencent QR code, and is not evidence of live-channel availability.

## HMAC contract

All `/v1/*` control requests and the RyanAI event request use these headers:

- `X-RyanAI-Timestamp`: Unix seconds.
- `X-RyanAI-Nonce`: unique 16–128 character nonce.
- `X-RyanAI-Content-SHA256`: lowercase SHA-256 hex of the exact raw HTTP body (empty body for GET).
- `X-RyanAI-Signature`: `v1=<lowercase HMAC-SHA256 hex>`.

The canonical string is:

```text
v1
<timestamp>
<nonce>
<UPPERCASE_METHOD>
<exact_path_and_query>
<raw_body_sha256>
```

The HMAC key is `BOT_GATEWAY_HMAC_SECRET`. Requests outside the configured clock skew are rejected; control nonces are single-use during the replay window. Request bodies and credential values are never logged.

## Canonical control API

`GET /health` is intentionally unauthenticated for container health checks. Every other canonical route requires the HMAC headers above.

| Method and path                                | Behavior                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /health`                                  | Sidecar/embedded-host readiness; login state does not determine health |
| `GET /v1/connections`                          | List non-secret connection snapshots                                   |
| `PATCH /v1/connections/{id}`                   | Set `{ "enabled": boolean }`                                           |
| `PUT /v1/connections/{id}/credentials`         | Encrypt and persist a JSON credential object; returns 204              |
| `POST /v1/connections/{id}/login`              | Begin login using encrypted credentials when present                   |
| `GET /v1/connections/{id}/login`               | Read login state and QR data when available                            |
| `POST /v1/connections/{id}/reconnect`          | Reconnect the channel                                                  |
| `POST /v1/connections/{id}/logout`             | Logout and remove stored credentials                                   |
| `GET /v1/connections/{id}/groups`              | List discovered groups and allowlist state                             |
| `POST /v1/connections/{id}/groups/discover`    | Ask the adapter to refresh group discovery                             |
| `PATCH /v1/connections/{id}/groups/{group_id}` | Set `{ "enabled": boolean }` (optional `name`)                         |

The extra `/v1/mock/events` route exists only in mock mode and returns 404 in real mode.

## RyanAI event contract

The gateway always sends:

```text
POST /api/v1/internal/bot-gateway/events
Content-Type: multipart/form-data
Idempotency-Key: <event_id>
X-RyanAI-Event-ID: <event_id>
```

The `event` part is JSON:

```json
{
	"version": "1.1",
	"event_id": "channel-event-id",
	"occurred_at": "2026-08-09T12:00:00.000Z",
	"channel": "wechat",
	"connection_id": "wechat-default",
	"node_id": "gateway-node-a",
	"shard_id": "wechat-shard-000",
	"lease_epoch": 42,
	"assignment_generation": 3,
	"conversation": { "type": "private", "id": "contact-id" },
	"sender": { "id": "contact-id" },
	"message": { "text": "hello", "mentions_bot": true },
	"attachments": [
		{
			"field_name": "attachment_0",
			"id": "file-id",
			"file_name": "report.pdf",
			"content_type": "application/pdf",
			"size": 1234,
			"sha256": "lowercase-hex"
		}
	]
}
```

Each attachment is a binary multipart part named by `field_name`. RyanAI must verify the HMAC over the exact multipart body, enforce timestamp/nonce replay protection, verify attachment size/hash, and enforce `event_id` idempotency before invoking the chat pipeline.

Expected response:

```json
{
	"version": "1.0",
	"event_id": "channel-event-id",
	"status": "ok",
	"reply": { "text": "RyanAI response" }
}
```

`status: "ignored"` with no reply is also valid. Non-2xx, malformed, oversized, timed-out, or mismatched responses are converted to the configured safe error text. They can never fall through to OpenClaw Agent execution.

## Embedded OpenClaw host and bridge boundary

The sidecar starts the pinned OpenClaw executable as a child process bound only to loopback. Its generated configuration loads exactly three plugins: the official WeChat channel, the official QQ channel, and `dist/openclaw/plugin.js` (`ryanai-bridge`). It does not configure a model provider. The child receives a narrow environment allowlist and a bridge-specific HMAC key derived from the main gateway secret; it does not receive the credential-vault encryption key.

The QQ plugin `2.0.0` ships management slash commands such as `/bot-upgrade`, `/bot-logs`, and `/bot-clear-storage` that would otherwise intercept messages before RyanAI. The package `postinstall` hook runs `scripts/harden-qqbot.cjs`: it verifies the exact pinned QQ version and removes only that middleware from the published bundle. The patch is fail-closed and refuses to run if the package version or expected bundle shape changes; ordinary QQ messages and the RyanAI bridge are unaffected. Re-validate this hardening whenever the QQ plugin version is upgraded.

Inbound delivery follows this boundary:

1. The typed `inbound_claim` hook normalizes authoritative channel, account, conversation, group, mention, sender, message, and trusted local-media fields.
2. The bridge signs the normalized multipart event and sends it to the parent sidecar over loopback.
3. The parent applies replay, allowlist, serialization, and idempotency rules, then calls RyanAI.
4. The bridge returns a synthetic reply with `handled: true`, so OpenClaw Agent/model routing is never used. The compatibility hooks also fail closed, and any `model_call_started` event is treated as a security violation.

Remote media URLs are intentionally not fetched. Local media paths must resolve beneath an automatically trusted OpenClaw media directory or an explicitly configured `BOT_GATEWAY_ATTACHMENT_ROOTS` entry.

WeChat login uses the official plugin's QR flow. QQ can use encrypted `appId`/`appSecret` credentials or the official connector's QR flow. Login, reconnect, logout, and channel enable/disable operations restart or probe the embedded host as needed. Account authentication state is visible through connection snapshots and does not make an otherwise running sidecar unhealthy.

## Persistence and security

- `/data/state/gateway-state.db` is the active local store. It uses SQLite WAL in a worker thread for connection/group caches, replay claims and replies, supervisor checkpoints, and migration receipts.
- A legacy `/data/state/gateway-state.json` is imported transactionally once, verified by row counts and checksum, then renamed to a timestamped backup. A failed migration keeps the original file and aborts startup.
- In standalone mode `/data/credentials/*.json` stores AES-256-GCM envelopes. In product Redis mode credentials are fetched from RyanAI SQL only after the node owns the shard lease; stale local credentials never start a cluster shard.
- WeChat account sync checkpoints are restricted to the account's sync JSON and `allowFrom`, capped at 1 MiB, encrypted independently in SQL, restored only after a fresh lease, and uploaded every 30 seconds only when changed.
- OpenClaw state/home/media live under the configured runtime directories. Shard children receive only their account material and a bridge secret derived from shard, node, and fencing epoch.
- Events are serialized by `channel + connection + conversation`, with group conversations additionally scoped by sender. Duplicate event IDs share one in-flight result and later replays use the persisted result without a second RyanAI call or charge.
- Group messages are discovered but ignored until the group is enabled and the message explicitly mentions the bot.

## Operations and verification

`GET /metrics` exposes Prometheus counters, gauges, and latency histograms. Signed operations endpoints provide node/shard snapshots, drain/resume, and circuit reset; the RyanAI administration page provides rebalance preview/apply.

```console
npm run check
npm run test:coordination:docker
docker build -t ryanai-bot-gateway .
npm run benchmark:docker
npm run benchmark:docker -- --matrix
```

The quick Docker benchmark compares two accounts in shared and isolated topology, verifies process count, shard routing, forged signatures, duplicate account rejection, supervisor recovery, and memory use. `--matrix` repeats the topology comparison for 1, 2, 4, 8, and 12 accounts. Fake Tencent credentials are sufficient for topology and failure tests, but real QR login and message send/receive remain a release acceptance step.
