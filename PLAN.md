# OpenClaw fmsg channel — Phase 1 plan

Status: Phase 1 approved; Phase 2 implementation and acceptance completed on 2026-09-01.

Research date: 2026-09-01 (Australia/Perth).

## Sources and version baseline

This plan is pinned to the following source revisions so later SDK or protocol changes do not silently change the design:

- OpenClaw npm package and source tag `2026.8.1`, source commit [`ea806575e6450e4d1efdfc72c19f04be982a1b9b`](https://github.com/openclaw/openclaw/tree/ea806575e6450e4d1efdfc72c19f04be982a1b9b).
- Current OpenClaw documentation: [Building plugins](https://docs.openclaw.ai/plugins/building-plugins), [Channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins), and [SDK entrypoints](https://docs.openclaw.ai/plugins/sdk-entrypoints). The requested `building-extensions` URL now redirects to `building-plugins`.
- DingTalk structural reference, commit [`42c6b94609d226520bfcfb5568a6f356c399a6ab`](https://github.com/soimy/openclaw-channel-dingtalk/tree/42c6b94609d226520bfcfb5568a6f356c399a6ab). Its current package is `@soimy/dingtalk` 3.6.10 and targets an older OpenClaw 2026.7.1 prerelease, so it is a structural reference rather than the SDK authority.
- Hermes fmsg reference, commit [`6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc`](https://github.com/markmnl/hermes-fmsg/tree/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc). Its README was read first; its [thread-mapping contract](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/README.md#L189-L217) is the behavioral baseline.
- fmsg Web API server corroboration, commit [`f9d2526b58670a21fcd0d1448acf12139bf71f1b`](https://github.com/markmnl/fmsg-webapi/tree/f9d2526b58670a21fcd0d1448acf12139bf71f1b). Hermes remains the porting source; the server source was used to verify ambiguous wire details.
- Local `fmsg-docker`, commit [`222d7717efe022ad584c8846b3b1b2699acbc49e`](https://github.com/markmnl/fmsg-docker/tree/222d7717efe022ad584c8846b3b1b2699acbc49e), will be the opt-in integration environment.

## 1. Verified OpenClaw SDK entrypoint and registration API

### Exact entrypoint style

For OpenClaw 2026.8.1, the preferred channel entrypoint is `defineChannelPluginEntry` from the focused `openclaw/plugin-sdk/channel-core` subpath. The helper registers the channel itself by calling `api.registerChannel({ plugin })`; custom tools belong in `registerFull`.

The implementation entrypoint will therefore have this shape:

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineChannelPluginEntry({
  id: "fmsg",
  name: "fmsg Channel",
  description: "Federated messaging through fmsg",
  plugin: fmsgPlugin,
  setRuntime: setFmsgRuntime,
  registerFull(api) {
    api.registerTool(fmsgSendTool, { name: "fmsg_send" });
  },
});
```

Evidence:

- The current [SDK entrypoint documentation](https://docs.openclaw.ai/plugins/sdk-entrypoints) says to import channel helpers from `openclaw/plugin-sdk/channel-core`, and documents that `defineChannelPluginEntry` calls `api.registerChannel(...)` automatically.
- The exact option type is in [`src/plugin-sdk/core.ts` lines 474–499](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/plugin-sdk/core.ts#L474-L499); its registration and mode behavior are in [lines 547–599](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/plugin-sdk/core.ts#L547-L599).
- DingTalk uses the same helper pattern and registers its extra tool from `registerFull` in [`index.ts` lines 287–329](https://github.com/soimy/openclaw-channel-dingtalk/blob/42c6b94609d226520bfcfb5568a6f356c399a6ab/index.ts#L287-L329). Its broad `openclaw/plugin-sdk/core` import is an older style and will not be copied.

The manual fallback would be a default object with `register(api)` and `api.registerChannel({ plugin: fmsgPlugin })`, but there is no reason to prefer it on 2026.8.1.

### Plugin assembly and lifecycle

The channel will be composed as a `ChannelPlugin` with separate config, security, messaging, outbound, gateway, status, and threading adapters. DingTalk's [`src/channel.ts`](https://github.com/soimy/openclaw-channel-dingtalk/blob/42c6b94609d226520bfcfb5568a6f356c399a6ab/src/channel.ts#L23-L128) is the structural model. Its gateway lifecycle—`gateway.startAccount(ctx)`, status patching, abort handling, a returned `stop` function, and reconnect ownership—is the model for the fmsg connection manager; see [`channel-gateway.ts`](https://github.com/soimy/openclaw-channel-dingtalk/blob/42c6b94609d226520bfcfb5568a6f356c399a6ab/src/gateway/channel-gateway.ts#L168-L360).

Current focused SDK imports will be used instead of copying DingTalk's older imports. The outbound adapter will use current channel-outbound/message adapter APIs, and inbound media will use `toInboundMediaFacts`; deprecated `dispatchInboundReplyWithBase` will not be introduced.

### Required manifests and tool declaration

The package needs both:

- `package.json`, with OpenClaw package metadata and the selected development/runtime entrypoint arrangement.
- `openclaw.plugin.json`, with `id: "fmsg"`, `channels: ["fmsg"]`, the `channels.fmsg` configuration schema, and `contracts.tools: ["fmsg_send"]`.

The second file is mandatory in current OpenClaw even though it was not explicitly named in the requested deliverables. `api.registerTool(...)` registers the implementation; the manifest contract advertises the tool during discovery.

### Packaging decision

The requested packaging constraints conflict with the current SDK's managed-install contract:

- `extensions: ["./index.ts"]` is supported for workspace/git/local-linked development, where OpenClaw can load source TypeScript.
- A package installed and managed through `openclaw plugins install` is expected to publish compiled JavaScript and point `runtimeExtensions` at that output. Missing built runtime output is treated as a packaging error by current OpenClaw. This distinction is documented under [SDK entrypoints](https://docs.openclaw.ai/plugins/sdk-entrypoints) and [building plugins](https://docs.openclaw.ai/plugins/building-plugins).
- DingTalk confirms the practical pattern: it declares a TypeScript source extension for development, but also builds and publishes `dist/index.js` as its runtime extension.

Therefore these two requirements cannot both be promised unchanged:

1. “TypeScript, ESM, loaded via jiti (no build step)”; and
2. normal npm/ClawHub installation via `openclaw plugins install`.

Decision: retain `extensions: ["./index.ts"]` for development, compile and publish prebuilt JavaScript in `dist`, and declare `runtimeExtensions: ["./dist/index.js"]`. The package will contain no install-time build hook, so `openclaw plugins install` remains compatible with npm's `--ignore-scripts`; compilation happens before publication.

## 2. fmsg Web API surface reverse-engineered from Hermes

Base URL: `FMSG_API_URL`, default `https://api.fmsg.io`, with trailing slashes normalized away. All REST calls use native `fetch`; the WebSocket uses `ws`.

Hermes's complete client contract is in [`plugin/fmsg_client.py`](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/fmsg_client.py#L7-L274). The server's route declarations provide a second check in [`cmd/fmsg-webapi/main.go`](https://github.com/markmnl/fmsg-webapi/blob/f9d2526b58670a21fcd0d1448acf12139bf71f1b/cmd/fmsg-webapi/main.go#L167-L213).

### Authentication and JWT exchange

#### `POST /fmsg/token`

- Request header: `Authorization: Bearer fmsgk_...`.
- Request body: none.
- Success: `200` JSON containing `access_token`, `token_type: "Bearer"`, `expires_in`, and `expires_at`.
- The signed JWT's `sub` claim is the authenticated fmsg address and is the only sender identity. `homeChannel` is access-control configuration, never a from-address.
- Token exchange `401`/`403` is a fatal account configuration error.
- Cache the token until a safety margin before expiry. Protected REST requests that receive `401` force one token refresh and one retry, matching Hermes.
- JWT payload decoding is only used to read `sub`/expiry after the server has authenticated the token; it is not treated as local signature verification.
- API keys and JWTs must never enter URLs or normal logs.

The exchange is implemented by Hermes at [`fmsg_client.py` lines 101–159](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/fmsg_client.py#L101-L159) and by the server at [`token.go` lines 25–53](https://github.com/markmnl/fmsg-webapi/blob/f9d2526b58670a21fcd0d1448acf12139bf71f1b/internal/handlers/token.go#L25-L53).

### Inbox, sent messages, and message retrieval

All endpoints below use `Authorization: Bearer <JWT>`.

#### `GET /fmsg?limit=<n>&offset=<n>`

- Returns the authenticated recipient's inbox as a JSON array, newest ID first.
- Used for restart/reconnect catch-up and cold state reconstruction.
- Hermes pages at 100. On first installation it limits unsolicited unread adoption to 50, then processes selected messages oldest first.

#### `GET /fmsg/sent?limit=<n>&offset=<n>`

- Returns messages authored by the authenticated sender, including drafts.
- Hermes searches inbox plus sent messages, up to 50 each, to find the latest strict one-to-one thread for agent-initiated continuation.

#### `GET /fmsg/:id`

- Returns complete message metadata.
- Used to walk `pid` ancestry, resolve a root, reconstruct participants, and obtain attachment metadata.

#### `GET /fmsg/:id/data`

- Returns the raw message body.
- A list item's `short_text` is complete only when its UTF-8 byte length is at least the declared `size`; otherwise this endpoint supplies the full content.

#### `POST /fmsg/:id/read`

- Marks an inbox message read. The operation is idempotent.
- Success: `200` with `{ id, time_read }`.
- It will be called only after an inbound message has been durably accepted/recorded, matching Hermes's ordering.

Hermes's endpoint wrappers are at [`fmsg_client.py` lines 163–239](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/fmsg_client.py#L163-L239); catch-up behavior is in [`adapter.py` lines 461–495](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/adapter.py#L461-L495).

### Draft, attachments, and send

#### `POST /fmsg`

Creates a draft. JSON body:

```json
{
  "version": 1,
  "from": "@sender@example.org",
  "to": ["@recipient@example.net"],
  "type": "text/plain; charset=utf-8",
  "size": 12,
  "data": "message text",
  "pid": "parent-message-id",
  "important": false,
  "no_reply": false
}
```

- `from` must equal the JWT `sub`; it is not independently configurable.
- `size` is the UTF-8 byte size, not JavaScript string length.
- A reply uses `pid`. A new root uses `topic`. Exactly one of those is supplied.
- `important` and `no_reply` are optional.
- Success: `201` with `{ id }`.

#### `POST /fmsg/:id/attach`

- Adds an attachment to a draft before sending.
- Multipart form field name: `file`.
- Success includes `{ filename, size }`.
- The actual route is singular `/attach`, despite an inconsistent plural comment in the server source.

#### `GET /fmsg/:id/attach/:filename`

- Downloads raw attachment bytes for a message visible to the authenticated owner/recipient.
- Inbound attachment metadata is an array of `{ filename, size }`.

#### `POST /fmsg/:id/send`

- Finalizes and delivers the draft; a sent message cannot be sent again.
- Success: `200` with `{ id, time }`.

#### `DELETE /fmsg/:id`

- Deletes an owned draft; success is `204`.
- Used as best-effort cleanup if attachment upload or final send fails.

Hermes performs the draft → attachments → send transaction and failed-draft cleanup in [`adapter.py` lines 1128–1190](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/adapter.py#L1128-L1190).

### WebSocket subscribe

#### `GET /fmsg/ws` upgraded to WebSocket

- Convert the configured base scheme from `http`/`https` to `ws`/`wss` and append `/fmsg/ws`.
- Authenticate with `Authorization: Bearer <JWT>` in the upgrade request. The server also accepts a query token, but this plugin will not place credentials in URLs.
- Frames have `{ "type": "...", "data": ... }`.
- Hermes consumes `type: "new_msg"`; `data` is the full inbox-list message object.
- The current server also publishes `delivered` and `recipients_added`. They are not new inbound messages; the first implementation will ignore `delivered` and may use `recipients_added` to refresh participant state.
- JWT refresh is not in-band. The manager must deliberately rotate a socket before token expiry.

Hermes's WebSocket iterator is at [`fmsg_client.py` lines 242–274](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/fmsg_client.py#L242-L274); the current server event forms are in [`hub.go`](https://github.com/markmnl/fmsg-webapi/blob/f9d2526b58670a21fcd0d1448acf12139bf71f1b/internal/handlers/hub.go#L15-L28).

### Message and participant shape

Relevant fields are:

```text
id, version, has_pid, pid, has_add_to, important, no_reply, deflate,
from, to, to_delivery, add_to, time, topic, type, size, short_text,
read, time_read, attachments
```

Each `add_to` batch contains `batch_id`, `add_to_from`, `to`, `to_delivery`, and `time`. Reply-all recipients are the case-insensitive, stable-deduplicated union of:

```text
parent.from
+ parent.to
+ every parent.add_to[].add_to_from
+ every parent.add_to[].to
- the authenticated agent address
```

The server-side model is defined in [`models.go` lines 28–49](https://github.com/markmnl/fmsg-webapi/blob/f9d2526b58670a21fcd0d1448acf12139bf71f1b/internal/models/models.go#L28-L49). Hermes's participant logic is at [`adapter.py` lines 795–851](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/adapter.py#L795-L851).

## 3. Connection, catch-up, and delivery design

### Connection lifecycle

1. Resolve account config and exchange the API key through a single-flight token manager.
2. Open the authenticated WebSocket first.
3. Once open, log the exact line `fmsg connected` and start inbox catch-up while funnelling both live frames and catch-up results through one serialized, message-ID-deduplicated queue. This closes the catch-up-before-subscribe race present in a simpler sequential design.
4. Process selected catch-up messages oldest first.
5. Persist the high-water/message adoption state only after OpenClaw accepts the event; then mark the fmsg message read.
6. On disconnect, reconnect with exponential full-jitter backoff from about 1 second to 60 seconds. Reset backoff after a healthy interval, and rotate proactively before JWT expiry.
7. Respect OpenClaw's `AbortSignal`; close the socket, timers, and pending work from the gateway's returned `stop` function.

Message IDs are the deduplication/event keys. A reconnect cannot produce duplicate OpenClaw turns even when the same message is seen via both WebSocket and inbox.

### Attachments

- Inbound: validate metadata and size, download with authenticated fetch, store/cache through the OpenClaw runtime media facilities, and expose normalized facts through `toInboundMediaFacts`. Body and filenames remain untrusted input.
- Outbound: load OpenClaw reply media through the shared media loader, create the fmsg draft, upload every attachment, then finalize with `/send`. On any intermediate failure, delete the draft best-effort.
- The client will enforce OpenClaw's configured media limit and handle server `413`; fmsg does not expose a reliable capability endpoint for the server's configured maximum.

## 4. fmsg thread mapping onto native OpenClaw sessions

### Native key shape

OpenClaw's native direct-message routing can produce an outer key like:

```text
agent:<agentId>:fmsg:direct:<normalized-counterparty>
```

Thread-aware routing then appends:

```text
:thread:<normalized-thread-id>
```

The relevant core behavior is in [`resolveThreadSessionKeys`](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/routing/session-key.ts#L337-L355). The fmsg mapping will be:

| fmsg situation | fmsg branch/thread ID passed to OpenClaw | resulting native session suffix |
|---|---|---|
| Root message `R` from counterparty `C` | `R` | `fmsg:direct:C:thread:R` |
| First child of any message already on branch `R` | inherited `R` | same session |
| Later sibling message `M` under root `R` | `R:br:M` | `fmsg:direct:C:thread:R:br:M` |
| Descendant of branch message `M` | inherited `R:br:M` | same branch session |

The full key remains OpenClaw-native, e.g. `agent:main:fmsg:direct:@alice@example.org:thread:R:br:M`. This preserves the requested `{root}:br:{message}` branch grammar rather than making that string replace OpenClaw's outer agent/channel/peer key.

The branch assignment state mirrors Hermes:

- `parent → ordered discovered children`
- `message → root`
- `message → branch/thread ID`
- recent message metadata/participants
- per-branch last inbound and last outbound IDs

Catch-up is oldest-first, so “first child” normally means chronological first child. To reproduce Hermes exactly, the first child observed wins; later discovered siblings fork. Descendants inherit their parent's branch ID.

### Direct ancestry context

For a fork, follow `pid` from the branch parent to the root, reverse it, and inject only that direct ancestry as bounded, clearly delimited untrusted context. Hermes limits this to 20 messages/8,000 characters and 500 characters per ancestor in [`adapter.py` lines 759–793](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/adapter.py#L759-L793); those are sensible initial bounds.

The prior OpenClaw session cannot simply be inherited as `parentSessionKey`: it can contain sibling continuation that is not in the new branch's direct ancestry. Exact ancestry hydration therefore remains fmsg adapter logic.

### Does `buildThreadAwareOutboundSessionRoute` fit?

Yes, for the final native session route and preservation/recovery of `replyToId`/`threadId`, with important adaptations. The helper's exact implementation is in [`src/plugin-sdk/core.ts` lines 421–459](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/plugin-sdk/core.ts#L421-L459).

The fmsg meanings will be:

- `threadId`: the logical fmsg branch ID (`R` or `R:br:M`).
- `replyToId`: the direct fmsg parent/message ID.
- precedence: `threadId`, then `replyToId`, then current session. The helper's default prefers `replyToId`, which would incorrectly create a session per direct parent.
- thread normalization: preserve the safe normalized `{root}:br:{message}` grammar.
- recovery: only accept the current session when its base route belongs to the same account/counterparty.

One more adaptation is required: `buildChannelOutboundSessionRoute` defaults to the global `session.dmScope`, whose default can collapse DMs into the agent's main session. fmsg explicitly requires the counterparty in the key. The plugin will enforce/mirror a `per-channel-peer` base route for fmsg and pass that route to the thread-aware helper rather than allowing the default `main` scope to erase the counterparty.

The helper does **not** solve branch detection, ancestry hydration, participant selection, or multi-output parent chaining; those stay in the fmsg adapter.

The channel will declare native threads and message-based thread addressing (`threadAddressing: "message"`).

### Reply parent, reply-all, and output chaining

- A new inbound message records itself as the current parent and resets that branch's outbound chain.
- The first outbound message in an agent turn replies to the latest inbound message.
- Each later outbound message/chunk in the same turn replies to the preceding successful outbound fmsg message.
- Recipients are computed from the actual chosen parent's `from`, `to`, and all `add_to` batches, excluding the JWT `sub` address.
- Outbound success records the fmsg message ID so subsequent chunks route to it.
- Agent-initiated continuation without an explicit parent scans recent inbox and sent messages for the most recent strict one-to-one exchange with the requested address. It never auto-selects a multi-party thread.
- `fmsg_new_thread: true` bypasses continuation and creates a root; `topic` is then optional.

Hermes implements the corresponding parent/chaining/proactive behavior in [`adapter.py` lines 962–1117](https://github.com/markmnl/hermes-fmsg/blob/6dd934a8d85a8d02eb1a7194ceb97c9e5eef4ecc/plugin/adapter.py#L962-L1117).

## 5. Configuration and access control

`channels.fmsg` will expose:

```json
{
  "apiUrl": "https://api.fmsg.io",
  "apiKey": "fmsgk_...",
  "homeChannel": "@owner@example.org",
  "allowedUsers": ["@owner@example.org"],
  "allowAllUsers": false,
  "maxAgentTurnsPerThread": 8,
  "agentTurnWindowMs": 60000
}
```

Environment values take precedence. Required mappings are `FMSG_API_URL` and `FMSG_API_KEY`; the Hermes-compatible mappings `FMSG_HOME_CHANNEL`, `FMSG_ALLOWED_USERS` (comma-separated), and `FMSG_ALLOW_ALL_USERS` will also be supported. Loop protection is exposed as `maxAgentTurnsPerThread`/`FMSG_MAX_AGENT_TURNS_PER_THREAD` and `agentTurnWindowMs`/`FMSG_AGENT_TURN_WINDOW_MS`, defaulting to 8 automatic turns in 60,000 ms. Setting the maximum to `0` explicitly disables the circuit breaker; invalid or negative values fail configuration validation.

Access decisions are based on normalized, case-insensitive fmsg addresses:

- `allowAllUsers: true`: accept any syntactically valid sender.
- Non-empty `allowedUsers`: accept only listed senders.
- Empty allowlist plus `homeChannel`: use the home address as the effective sole allowlist entry and log a warning.
- Neither configured: reject every inbound message and log a clear default-deny line.

`homeChannel` never controls `from`; JWT `sub` always does. The public config name remains `allowedUsers` as requested, even though many native OpenClaw channels conventionally call the analogous field `allowFrom`.

## 6. Flags, safety, and untrusted content

### `important` and `no_reply`

- Surface both flags in provider-native event metadata and a concise system/context note.
- `no_reply` is a hard response suppression rule for this plugin: record/adopt the inbound event and mark it read, but do not start an automatic agent reply turn for it.
- This intentionally goes beyond Hermes, which surfaces `no_reply` but does not itself prevent downstream dispatch.

### Loop circuit breaker

Maintain a per-branch sliding window of successful plugin-generated automatic OpenClaw turns. Defaults are configurable at 8 turns in 60 seconds:

- Count one successful automatic OpenClaw turn, not each individual text/media chunk emitted within that turn.
- Inbound messages do not reset the window; otherwise two automatically responding agents could reset each other's counters forever.
- On the eighth allowed automatic turn within the window, set `no_reply: true` on its outbound fmsg message(s) so a compliant peer stops.
- Suppress additional automatic turns while 8 timestamps remain inside the sliding window and log the circuit-breaker reason without exposing content or credentials.
- As timestamps age past 60 seconds, capacity returns automatically. A new root or sibling branch starts with an independent empty window.
- `maxAgentTurnsPerThread` and `agentTurnWindowMs` are documented operator configuration. Setting the maximum to `0` disables this protection for deployments that deliberately rely only on agent discretion.

This is a last-resort automation/cost circuit breaker, not content moderation: the receiving agent remains free to stop earlier. fmsg does not provide a reliable human-versus-agent identity bit, so the rule is based only on automatic outbound activity rate.

### Credential redaction and input handling

- Treat message bodies, topics, filenames, addresses, and ancestry as untrusted data; delimit ancestry/context and never interpret it as configuration.
- Before creating every outbound text draft—including `fmsg_send`—redact `fmsgk_...` API-key shapes and compact three-segment JWT shapes.
- Scrub the same values from errors and structured logs. Never log auth headers, token response bodies, or WebSocket URLs containing tokens.
- Do not rewrite arbitrary binary attachments; credential redaction applies to outbound text and logs.

## 7. `fmsg_send` tool

Register `fmsg_send` from `registerFull` and declare it in `openclaw.plugin.json`. Initial parameters:

```text
to: string                    required @user@domain address
text: string                  required
fmsg_new_thread: boolean      optional, default false
topic: string                 optional; used for a new root
```

Behavior:

- Validate the address and use the active account's JWT `sub` as sender.
- By default, continue the most recent strict one-to-one thread with `to` using Hermes's inbox+sent lookup.
- If no suitable one-to-one thread exists, or `fmsg_new_thread` is true, create a new root.
- Never select a multi-party thread automatically.
- Apply credential redaction and the same draft/send transaction.
- Return the sent fmsg message ID and whether the operation created a root or replied to a parent.

This intentionally supplements OpenClaw's shared message tooling because the spec requires a directly invokable mid-task fmsg continuation/new-root operation.

## 8. Planned implementation layout

Using the decided TypeScript-source/prebuilt-JavaScript packaging:

```text
index.ts                         channel entrypoint and tool registration
openclaw.plugin.json             channel schema and tool contract
package.json                     ESM metadata, peer dependency, ws dependency
src/channel.ts                   ChannelPlugin composition
src/config.ts                    config/env resolution and access policy
src/client.ts                    typed REST and draft/send API
src/token-manager.ts             API-key exchange and JWT refresh
src/connection-manager.ts        WebSocket, rotation, reconnect/backoff
src/gateway.ts                   account lifecycle and catch-up orchestration
src/inbound.ts                   dedupe, flags, media, OpenClaw dispatch
src/outbound.ts                  reply parent, reply-all, chained sends
src/threading.ts                 root/branch assignment and ancestry
src/state.ts                     bounded durable routing/high-water state
src/redact.ts                    outbound/log secret filtering
src/tool.ts                      fmsg_send implementation
test/fake-fmsg-server.ts         in-memory HTTP + WebSocket Web API
test/*.test.ts                   unit/integration tests
test/fmsg-docker.e2e.test.ts     opt-in external e2e
README.md                        install, config, mapping, safety, testing
```

The package will have `openclaw` as a peer dependency only. Runtime dependencies will be pure JS/TS, principally `ws`; HTTP remains native `fetch`, and installation must remain compatible with `--ignore-scripts` once the packaging decision is made.

## 9. Verification plan

### In-memory fake fmsg Web API

Tests will cover:

- API-key exchange, token cache/rotation, REST `401` single refresh/retry, and sender from JWT `sub`.
- WebSocket auth, `new_msg`, reconnect/backoff, socket rotation, inbox catch-up, ordering, dedupe, and high-water persistence.
- Draft → attachment(s) → send ordering and failed-draft deletion.
- Full-body fallback from `short_text`, inbound attachment download, and outbound attachments.
- Default-deny, `homeChannel` allowlist seeding/warning, explicit allowed users, allow-all, and environment precedence.
- Root, first-child continuation, later-sibling fork, descendant inheritance, and bounded direct ancestry.
- Exact native session keys, `threadId`-first routing, and same-counterparty recovery.
- Reply-all across `from`, `to`, and `add_to`; self-exclusion and case-insensitive dedupe.
- Multiple outbound reply chaining and reset on new inbound.
- Recent strict one-to-one continuation and refusal to auto-select a group thread.
- `important`, hard `no_reply` suppression, the configurable sliding-window circuit breaker, expiry behavior, disabled behavior, and final allowed `no_reply` send.
- API-key/JWT redaction in normal channel replies, tool sends, errors, and logs.
- Entrypoint/manifest discovery and `fmsg_send` contract.

### Opt-in fmsg-docker e2e

An environment-gated test will start/use fmsg-docker, provision two fmsg identities/API keys, and exercise real token exchange, WebSocket delivery, catch-up, roots/replies/branches, reply-all, and attachments. It will skip with an explicit reason unless its opt-in variable and connection credentials are present.

### Live OpenClaw gateway acceptance

Before declaring implementation complete:

1. Install the built/selected package through the packaging path agreed below.
2. Configure a live OpenClaw gateway and fmsg account, restart it, and confirm `fmsg connected`.
3. Send a root from a peer and inspect the created native session key.
4. Send a first child and a later sibling, and verify continuation versus `R:br:M` session creation plus direct ancestry.
5. Add another participant, send inbound, and verify reply-all excludes the agent and includes the parent's complete participant set.
6. Trigger multiple replies in one turn and verify the fmsg `pid` chain.
7. Record commands, message IDs, session keys, and assertions in the completion report without exposing credentials.

Phase 2 supplied an isolated OpenClaw 2026.8.1 installation plus deterministic local model/fmsg services. The installed package passed gateway startup, root/linear/branch session creation, direct-ancestry delivery, outbound chaining, and reply-all acceptance. Real deployment credentials remain intentionally outside the repository.

## 10. Open questions and conflicts

1. **Resolved packaging choice:** author in TypeScript, publish prebuilt `dist` JavaScript, and run no installation scripts. Development uses `extensions: ["./index.ts"]`; managed installs use the corresponding `runtimeExtensions` JavaScript entry.
2. **Resolved loop policy:** use a documented, configurable per-branch sliding window, defaulting to 8 successful automatic OpenClaw turns per 60 seconds. Inbound does not reset it; capacity returns as timestamps expire. Operators may change both values or explicitly disable it with a maximum of `0`.
3. **Counterparty in multi-party threads:** Hermes keys the OpenClaw/Hermes chat by the current inbound sender. If a different participant replies within the same fmsg tree, that can produce a different outer peer session. This plan reproduces Hermes and the stated “counterparty address” semantics; confirm whether the intended counterparty is instead a stable conversation participant-set identity.
4. **“First child” ordering:** Hermes uses first observed child. Catch-up oldest-first normally makes that chronological, but out-of-order WebSocket delivery can make a later chronological child win. Exact Hermes compatibility says first observed; strict chronological behavior would require sibling discovery that the documented API does not directly expose.
5. **`no_reply` divergence:** Hermes only surfaces the flag; this spec says “honor no_reply (do not respond).” The plan follows the stricter spec and suppresses an automatic agent turn.
6. **Ancestry versus native inheritance:** `buildThreadAwareOutboundSessionRoute` fits the native key, but `parentSessionKey` cannot safely provide exact direct ancestry because the parent session may contain sibling history. The plugin must inject the PID-chain context itself.
7. **DingTalk API age:** the current DingTalk reference targets OpenClaw 2026.7.1 and uses older broad imports. Its lifecycle/connection architecture will be followed, while OpenClaw 2026.8.1 source and docs control SDK calls.
8. **Version naming:** current OpenClaw is date-versioned `2026.8.1`; the inspected package/docs do not expose a separate “v2.0” SDK line. This plan interprets “v2.0 (2026.8.1+)” as a minimum OpenClaw version of 2026.8.1.
9. **Config convention:** the requested public field is `allowedUsers`, while native OpenClaw channels commonly use `allowFrom`. The plugin can preserve `allowedUsers`, but generic setup/security UI assumptions around `allowFrom` may require an explicit adapter/setup contract.
10. **Tool attachments:** channel attachments are mapped both ways, but the requested `fmsg_send` signature mentions only destination, thread choice, and topic. Should the tool also accept OpenClaw media references in its first version?
11. **Server attachment limit:** Hermes defaults locally to about 10 MB, but fmsg server limits are deployment-specific and there is no discovered capability endpoint. The plugin can enforce the OpenClaw limit and surface server `413` clearly.
12. **Resolved live verification:** the final package was installed through OpenClaw's managed npm-pack path and exercised by a real OpenClaw 2026.8.1 gateway process. The acceptance harness uses local deterministic model and fmsg services so it remains credential-free and repeatable; the separate fmsg-docker test remains opt-in for real server deployments.

## Phase boundary

Phase 1 ends with this document. The packaging and loop-protection choices are resolved. Implementation must not begin until this revised plan is approved.
