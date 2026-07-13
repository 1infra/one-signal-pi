# `@1infra/one-signal-pi`

Passive Pi telemetry for One Signal, delivered through the One Connector classic Langfuse ingest endpoint.

This package is a Pi native TypeScript extension. It observes final session, message, tool, and instruction-snapshot events, writes them to a durable local spool, and uploads them asynchronously. Telemetry failures never block or modify Pi behavior.

## Install

Official install:

```bash
pi install git:github.com/1infra/one-signal-pi
```

This package is not currently published to npm because release credentials are unavailable. npm may be used as a future distribution channel once publishing is enabled.

For development from a local checkout:

```bash
pi install ./one-signal-pi
```

For project-local development install:

```bash
pi install --local ./one-signal-pi
```

## Configuration

Persistent config is the recommended setup. By default, One Signal reads:

```text
~/.pi/agent/one-signal-pi/config.json
```

That path is equivalent to:

```text
${ONE_SIGNAL_STATE_DIR:-${PI_CODING_AGENT_DIR:-~/.pi/agent}/one-signal-pi}/config.json
```

Create the directory and file with restrictive permissions:

```bash
ONE_SIGNAL_CONFIG_DIR="${ONE_SIGNAL_STATE_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/one-signal-pi}"
mkdir -p "$ONE_SIGNAL_CONFIG_DIR"
chmod 700 "$ONE_SIGNAL_CONFIG_DIR"
cat > "$ONE_SIGNAL_CONFIG_DIR/config.json" <<'EOF'
{
  "ONE_SIGNAL_API_TOKEN": "oc_replace_me",
  "ONE_SIGNAL_BASE_URL": "https://connector.1infra.io"
}
EOF
chmod 600 "$ONE_SIGNAL_CONFIG_DIR/config.json"
```

Only these top-level string fields are read from `config.json`:

```json
{
  "ONE_SIGNAL_API_TOKEN": "oc_replace_me",
  "ONE_SIGNAL_BASE_URL": "https://connector.1infra.io"
}
```

`ONE_SIGNAL_BASE_URL` defaults to `https://connector.1infra.io` when it is absent or empty.

If you want the spool and `config.json` somewhere else, set `ONE_SIGNAL_STATE_DIR` first, then run the same example above so it creates the directory with `chmod 700` and `config.json` with `chmod 600` at:

```text
$ONE_SIGNAL_STATE_DIR/config.json
```

Environment variables still work and always override `config.json`. Treat them as a temporary or session-scoped alternative:

```bash
export ONE_SIGNAL_API_TOKEN=oc_replace_me
export ONE_SIGNAL_BASE_URL=https://connector.1infra.io
export ONE_SIGNAL_STATE_DIR=/custom/safe/state/dir
```

## What is captured

- Session lifecycle hints: start and terminal shutdown reason
- Final user messages
- Final assistant messages
- Final tool results
- Pi session id, per-agent-run turn identity, turn index, model/provider/api, usage, Pi-reported cost, and thinking level metadata when Pi exposes it
- Explicit `/skill:name` invocations
- Explicit MCP attribution from tool names such as `mcp__github__get_pull_request`
- Actual loaded `AGENTS.md` / `CLAUDE.md` snapshots from `before_agent_start.systemPromptOptions.contextFiles`

## What is excluded

- Streaming deltas
- Raw reasoning / thinking blocks
- Raw images, base64 blobs, and binary payloads
- Provider signatures such as `thinkingSignature` and `thoughtSignature`
- Raw provider requests, raw provider responses, and raw headers
- Unfiltered custom `details`
- Absolute client file paths in uploaded instruction snapshot metadata

## Privacy and limits

- Strings are centrally redacted before persistence and upload.
- Common bearer tokens, env-style secrets, private keys, and URL secrets are replaced.
- Queue items, message bodies, tool bodies, and snapshots are size-bounded and safely truncated.
- The API token is never written into spool files or logs.

## Spool behavior

- Pending events are stored as JSON files under the state directory.
- Writes use atomic temp-file rename.
- Pending files survive Pi restart.
- Accepted events are deleted only after the server accepts them.
- `401/403` pauses retries for the current runtime.
- `429`, `5xx`, network failures, and timeouts stay queued and retry with backoff.
- `207 Multi-Status` acknowledges only explicit success ids from the server response.

## Uninstall

Official uninstall:

```bash
pi remove git:github.com/1infra/one-signal-pi
```

For a local checkout install:

```bash
pi remove ./one-signal-pi
```

Optional cleanup:

```bash
rm -rf "${ONE_SIGNAL_STATE_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/one-signal-pi}"
```

## Development

Typecheck:

```bash
tsc -p tsconfig.json --noEmit
```

Tests:

```bash
npm test
```

Smoke:

```bash
npm run smoke
```
