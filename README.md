# My Proxy

An Express-based HTTP proxy with dynamic whitelist/blacklist access control intended to sit in front of a Chrome MCP server (or other upstream services). It provides hot-reloading of access lists and a health endpoint.

## Features

- Dynamic whitelist & blacklist loaded from `src/config/whitelist.txt` and `src/config/blacklist.txt`
- Automatic reload of lists on file changes
- Optional static upstream target via `TARGET_HOST` environment variable
- Fallback dynamic host mode (uses incoming `Host` header)
- Structured middleware (logging via morgan, access control, proxy handler, error handler)
- Health endpoint at `/health`

## Environment Variables

| Variable      | Description                                                                                              | Default |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `PORT`        | Port for proxy server                                                                                    | `8080`  |
| `TARGET_HOST` | Force all traffic to single upstream (e.g. `http://localhost:9000`). If unset dynamic host mode is used. | (unset) |

## Usage

Install dependencies:

```bash
npm install
```

Run in development (ts-node):

```bash
npm run dev
```

Build & start (production style):

```bash
npm run build
npm start
```

Health check:

```bash
curl http://localhost:8080/health
```

Chrome MCP launch flag example:

```
--proxyServer=http://localhost:8080
```

## Access Control Lists

- Whitelist: if non-empty, only hosts containing one of the whitelist entries are allowed.
- Blacklist: any host containing a blacklist entry is blocked.
- Substring matching (case-insensitive).

## Extending

Add new middleware before the proxy catch-all (`app.use('*', ...)`) in `src/proxy-server.ts`.

Potential enhancements:

- Rate limiting middleware
- Metrics / Prometheus endpoint
- Structured JSON logging option
- ETag / caching layer for static assets
- Configurable matching mode (exact, wildcard, regex)
- Unit tests (Jest) and integration tests with supertest

## License

ISC
