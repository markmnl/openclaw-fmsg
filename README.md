# OpenClaw-fmsg

[![Tests](https://github.com/markmnl/openclaw-fmsg/actions/workflows/tests.yml/badge.svg)](https://github.com/markmnl/openclaw-fmsg/actions/workflows/tests.yml)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A52026.8.1-e11d48)](https://openclaw.ai)
[![Node.js](https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2025-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/OpenClaw-fmsg.png">
  <source media="(prefers-color-scheme: light)" srcset="./docs/OpenClaw-fmsg-light.png">
  <img alt="OpenClaw connected to fmsg" src="./docs/OpenClaw-fmsg-light.png" width="100%">
</picture>

Connect [OpenClaw](https://openclaw.ai) to [fmsg](https://fmsg.org), the federated messaging protocol. The plugin receives messages over WebSocket, catches up after reconnects, preserves fmsg message trees as native OpenClaw sessions, and carries attachments in both directions.

## Highlights

- Native threaded sessions: roots start sessions, linear replies continue them, and sibling branches fork with direct ancestry as context.
- Reliable delivery: WebSocket push, inbox catch-up, deduplication, JWT refresh, and reconnect backoff.
- Safe by default: deny-by-default inbound access, `no_reply` enforcement, loop protection, and outbound credential redaction.
- Full conversations: reply-all participant handling, attachment transfer, and chained replies within an agent turn.
- Proactive messaging: the bundled `fmsg_send` tool can continue a one-to-one thread or start a new root.

## Compatibility

| Component | Supported |
|---|---|
| OpenClaw | `2026.8.1` or newer |
| Node.js 22 | `22.22.3` or newer |
| Node.js 24 | `24.15.0` or newer |
| Node.js 25 | `25.9.0` or newer |
| Package format | TypeScript source plus prebuilt ESM JavaScript |

## Quick start

```bash
openclaw plugins install npm:@markmnl/openclaw-fmsg
openclaw channels add --channel fmsg
```

The published package contains TypeScript source for linked development and prebuilt JavaScript for managed installs. It has no install-time build hook and is compatible with OpenClaw/npm dependency installation using `--ignore-scripts`.

The setup flow prompts for your fmsg Web API URL, home fmsg address, and API key. No hosted API URL is assumed. For the credential, setup can store a plaintext key, use `FMSG_API_KEY`, or write an OpenClaw SecretRef.

For environment-based configuration, expose all values to the Gateway process:

```bash
export FMSG_API_URL='https://fmsg-api.example.com'
export FMSG_API_KEY='fmsgk_...'
export FMSG_HOME_CHANNEL='@owner@example.com'
```

Alternatively, configure the channel explicitly:

```json
{
  "channels": {
    "fmsg": {
      "enabled": true,
      "apiUrl": "https://fmsg-api.example.com",
      "apiKey": {
        "source": "env",
        "provider": "default",
        "id": "FMSG_API_KEY"
      },
      "homeChannel": "@owner@example.com",
      "allowedUsers": ["@owner@example.com"],
      "allowAllUsers": false,
      "maxAgentTurnsPerThread": 8,
      "maxAgentTurnsPerRoot": 20,
      "maxAgentTurnsPerSender": 20,
      "agentTurnWindowMs": 60000
    }
  }
}
```

Restart the gateway. A successful WebSocket connection identifies the address obtained from the JWT:

```text
fmsg connected as @agent@example.com
```

The sender address is always read from the exchanged JWT's `sub` claim. `homeChannel` is not a from-address.

### SecretRef credentials

`channels.fmsg.apiKey` accepts OpenClaw `env`, `file`, `exec`, and `store` SecretRefs. OpenClaw keeps the reference in `openclaw.json`, resolves it into the active in-memory runtime snapshot, and includes this path in `openclaw secrets audit`, `configure`, and `apply`.

An `env` SecretRef still requires the named variable in the Gateway environment. `file`, `exec`, and `store` references use the corresponding provider under OpenClaw's `secrets.providers` configuration and do not require `FMSG_API_KEY` to be injected into the Gateway environment.

```json
{
  "channels": {
    "fmsg": {
      "apiUrl": "https://fmsg-api.example.com",
      "apiKey": {
        "source": "file",
        "provider": "mounted-json",
        "id": "/fmsg/apiKey"
      },
      "homeChannel": "@owner@example.com"
    }
  }
}
```

When the legacy `FMSG_API_KEY` environment variable is present, it remains authoritative and a configured `apiKey` SecretRef is treated as inactive. Setup, Gateway logs, and the secrets audit warn about this shadowing. Remove the obsolete environment entry after migrating; the plugin never deletes credentials automatically.

## Configuration

Environment values take precedence over `channels.fmsg`. `apiUrl` is required: the plugin does not assume a public or hosted fmsg deployment.

| Configuration | Environment | Default | Purpose |
|---|---|---:|---|
| `apiUrl` | `FMSG_API_URL` | required | Explicit fmsg Web API base URL |
| `apiKey` | `FMSG_API_KEY` | required | `fmsgk_...` credential or OpenClaw SecretRef |
| `homeChannel` | `FMSG_HOME_CHANNEL` | prompted by setup | Default operator destination and fallback sole allowlist entry |
| `allowedUsers` | `FMSG_ALLOWED_USERS` | `[]` | Allowed inbound senders; environment form is comma-separated |
| `allowAllUsers` | `FMSG_ALLOW_ALL_USERS` | `false` | Explicitly allow every valid fmsg sender |
| `maxAgentTurnsPerThread` | `FMSG_MAX_AGENT_TURNS_PER_THREAD` | `8` | Automatic OpenClaw turns allowed per branch/window; `0` disables |
| `maxAgentTurnsPerRoot` | `FMSG_MAX_AGENT_TURNS_PER_ROOT` | `20` | Automatic OpenClaw turns across every branch of one root/window; `0` disables |
| `maxAgentTurnsPerSender` | `FMSG_MAX_AGENT_TURNS_PER_SENDER` | `20` | Automatic OpenClaw turns from one normalized sender across all roots/window; `0` disables |
| `agentTurnWindowMs` | `FMSG_AGENT_TURN_WINDOW_MS` | `60000` | Sliding window shared by all three circuit breakers |
| `mediaMaxBytes` | — | `10485760` | Maximum bytes per inbound/outbound attachment |

Access is default-deny:

- A non-empty `allowedUsers` list is enforced case-insensitively.
- An empty list with `homeChannel` configured uses that address as the effective sole allowlist and logs a warning.
- With neither value configured, all inbound messages are rejected with a clear warning.
- `allowAllUsers: true` is the only open-access setting.

### Access, owner authority, and scheduled delivery

These settings deliberately have different jobs:

| Setting | Purpose |
|---|---|
| `channels.fmsg.allowedUsers` | Who may send ordinary inbound messages |
| `channels.fmsg.homeChannel` | Default operator destination and fallback inbound allowlist entry |
| `commands.ownerAllowFrom` | Who may use privileged OpenClaw owner commands |
| `agents.defaults.heartbeat.target` | Heartbeat route mode: `owner`, `last`, `none`, or a channel such as `fmsg` |
| `agents.defaults.heartbeat.to` | Explicit destination when a channel target is selected |

`homeChannel` does not grant owner privileges. Interactive setup offers that privilege separately and defaults to no. To configure it manually:

```json
{
  "commands": {
    "ownerAllowFrom": ["fmsg:@owner@example.com"]
  }
}
```

A concrete effective fmsg allowlist can supply OpenClaw's default `owner` heartbeat route. An explicit route looks like:

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "target": "fmsg",
        "to": "@owner@example.com"
      }
    }
  }
}
```

Heartbeat routing is independent of proactive messaging: `fmsg_send` can initiate a message without granting its recipient owner authority.

### First-run verification

Run `openclaw status --deep` after setup. The fmsg account reports its JWT-derived identity, API URL, credential source, access policy, effective allowlist, connection state, and recent delivery errors without exposing the credential.

Do not treat a session transcript as proof of delivery. Confirm the reply arrived in the peer's fmsg inbox. For a fuller smoke test, verify a root reply, a later sibling branch, reply-all, an attachment, `no_reply`, and restart catch-up.

## Thread and session mapping

fmsg is a message tree. OpenClaw is given the fmsg branch ID as native `threadId` and the direct parent message as `replyToId`.

| fmsg event | OpenClaw branch/thread ID | Result |
|---|---|---|
| Root `R` from counterparty `C` | `R` | New counterparty session |
| First child on the line from `R` | inherited `R` | Continues that session |
| Later sibling `M` under root `R` | `R:br:M` | New session with direct ancestry context |
| Descendant of `M` | inherited `R:br:M` | Continues the branch session |

A native key has this shape:

```text
agent:<agentId>:fmsg:direct:<counterparty>:thread:<root-or-branch>
```

The first discovered child continues its parent's session; later discovered siblings fork. Catch-up is processed oldest-first, making this chronological during normal delivery. Fork context contains only the bounded root-to-parent `pid` chain—never sibling history—and is explicitly labelled as untrusted content.

Outbound replies:

- Multi-recipient inbound messages keep the sender-scoped direct session key, while all normalized participants other than the channel's own address are included as untrusted model context.
- Reply to the direct parent message.
- Reply-all to `from`, `to`, every `add_to_from`, and every `add_to.to` on that parent, excluding the JWT sender.
- If the live parent lookup fails, reply-all uses the persisted routing record and logs a warning instead of silently dropping co-recipients.
- If one OpenClaw turn emits several messages, the first replies to the inbound and each subsequent message replies to the preceding outbound message.
- A new inbound resets that output chain.
- Agent-initiated continuation selects only the latest strict one-to-one thread with the address. It never auto-selects a multi-party thread.
- Protocol IDs remain decimal strings internally and are emitted as exact JSON `int64` numbers at the Web API boundary, including values above JavaScript's safe-integer range.

## Agent tool

The plugin registers `fmsg_send`:

```json
{
  "to": "@alice@example.net",
  "text": "Status update",
  "fmsg_new_thread": false,
  "topic": "Optional topic for a new root"
}
```

By default it continues the latest strict one-to-one thread. Set `fmsg_new_thread` to force a new root.

## Safety behavior

- `no_reply` inbound messages are marked read without ancestry fetching or an automatic agent turn.
- `important` is exposed as `FmsgImportant` in OpenClaw's inbound context. `no_reply` is hard-suppressed before model dispatch.
- The loop circuit breakers count one successful automatic OpenClaw turn, not individual chunks, against the branch, root, and normalized sender. Inbound messages do not reset them. On the final allowed turn for any enabled budget, outbound messages carry `no_reply`; further turns are suppressed until timestamps leave the shared sliding window.
- Operators can tune each budget independently. Setting `maxAgentTurnsPerThread`, `maxAgentTurnsPerRoot`, or `maxAgentTurnsPerSender` to `0` disables that scope's breaker.
- Suppression warnings identify the exhausted scope, key, sender, and budget, and are rate-limited to one warning per scope/window.
- Inbound bodies, ancestry, topics, addresses, and filenames are untrusted.
- `fmsgk_...` and compact JWT-shaped strings are redacted immediately before any outbound text is drafted and from plugin error logs.
- `senderIsOwner` is derived from `commands.ownerAllowFrom`, not ordinary channel access. `senderKind` remains unknown unless fmsg eventually supplies authenticated human/agent metadata; the plugin does not guess from addresses.

Runtime routing state is stored under OpenClaw's state directory in `fmsg/<account>.json`, with bounded message and deduplication history.

Final replies use OpenClaw's durable outbound path. An inbound message is acknowledged only after delivery settles or the plugin intentionally suppresses a reply. Definite pre-send failures remain eligible for inbox catch-up after reconnect. fmsg currently exposes no verified idempotency key or send-reconciliation contract to this plugin, so an interrupted request after platform dispatch is treated as an ambiguous outcome rather than retried blindly.

Restarting the whole Gateway can interrupt a model turn. The plugin persists routing state before dispatch, drains its in-process receive queue during graceful shutdown, and catches up unacknowledged inbox messages after reconnect; it cannot preserve an executing model process across termination.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Releasing

Stable releases are published to npm by `.github/workflows/publish.yml` when a GitHub Release is published. Use a stable semantic-version tag such as `v0.1.1`; the workflow derives the npm version from the tag and updates both `package.json` and `package-lock.json` in the release checkout before publishing. Build and commit `dist/` whenever source code changes before creating the release.

The npm package must configure a trusted GitHub Actions publisher for repository `markmnl/openclaw-fmsg`, workflow `publish.yml`, with `npm publish` allowed. The workflow uses short-lived OIDC credentials and does not require an npm token secret.

The unit suite runs a strict in-memory HTTP and WebSocket implementation of the fmsg Web API. It enforces numeric `pid` input and covers full-range `int64` preservation, JWT exchange/refresh, drafts and attachments, WebSocket plus inbox catch-up, access control, branch mapping, native session routing, reply-all, output chaining, proactive one-to-one continuation, flags, secret redaction, persistence, delivery failure acknowledgement, and the circuit breaker.

### Live OpenClaw gateway acceptance

The opt-in gateway test launches the installed OpenClaw executable with a deterministic local model and the in-memory fmsg Web API. It verifies the ready connection, root and branch session rows in OpenClaw's SQLite session store, first-child continuation, and reply-all:

```bash
npm run test:gateway
```

Set `OPENCLAW_E2E_ROOT` to an OpenClaw package directory when it is not available at `node_modules/openclaw`. Set `OPENCLAW_E2E_PLUGIN_ROOT` to exercise a particular installed copy of this package instead of the working tree.

### fmsg-docker e2e

The e2e test expects two provisioned identities in an already-running [fmsg-docker](https://github.com/markmnl/fmsg-docker) environment:

```bash
FMSG_E2E=1 \
FMSG_E2E_AGENT_API_URL=http://localhost:8181 \
FMSG_E2E_AGENT_API_KEY='fmsgk_...' \
FMSG_E2E_PEER_API_URL=http://localhost:8182 \
FMSG_E2E_PEER_API_KEY='fmsgk_...' \
npm run test:e2e
```

The addresses are derived from the JWTs. The test sends a root with an attachment, observes WebSocket delivery, downloads the attachment, replies through the second deployment, and verifies the reply's `pid`.

Pull requests and npm releases also run `.github/scripts/run-fmsg-docker-e2e.sh`, which provisions isolated real stacks at a pinned fmsg-docker revision before running this acceptance.

## License

MIT
