import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import morgan from 'morgan';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware';
import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';

// Accept config directory as a command-line argument
const CONFIG_DIR = path.resolve(process.argv[2]!);

const BLACKLIST_FILE = path.join(CONFIG_DIR, 'blacklist.txt');

// --- Expanded blacklist rule system ---
type RuleKind = 'host-substring' | 'host-exact-path' | 'host-subtree-path' | 'subdomain';

interface BlacklistRule {
    raw: string;
    kind: RuleKind;
    host: string; // lowercased host portion
    path?: string; // for path-based rules, includes leading '/'
    test(hostLower: string, pathPart: string): boolean;
}

interface AccessLists {
    blacklistRules: BlacklistRule[];
    version: number;
}

const access: AccessLists = { blacklistRules: [], version: 0 };

function buildRuleFromLine(line: string): BlacklistRule | null {
    const raw = line.trim();
    if (!raw) return null;
    // Subdomain rule: starts with *.
    if (raw.startsWith('*.')) {
        const host = raw.slice(2).toLowerCase();
        return {
            raw,
            kind: 'subdomain',
            host,
            test(hostLower) {
                // match a.b.example.com when rule is *.example.com (requires at least one label before host)
                return hostLower === host ? false : hostLower.endsWith('.' + host);
            }
        };
    }

    // Path-based rules: contain '/'
    const slashIndex = raw.indexOf('/');
    if (slashIndex !== -1) {
        const hostPart = raw.slice(0, slashIndex).toLowerCase();
        const pathPart = raw.slice(slashIndex); // includes leading '/'
        if (pathPart.endsWith('*')) {
            const prefix = pathPart.slice(0, -1);
            return {
                raw,
                kind: 'host-subtree-path',
                host: hostPart,
                path: prefix,
                test(hostLower, requestPath) {
                    return hostLower === hostPart && requestPath.startsWith(prefix);
                }
            };
        }
        // exact host+path match
        return {
            raw,
            kind: 'host-exact-path',
            host: hostPart,
            path: pathPart,
            test(hostLower, requestPath) {
                return hostLower === hostPart && requestPath === pathPart;
            }
        };
    }

    // Otherwise substring in host
    const hostNeedle = raw.toLowerCase();
    return {
        raw,
        kind: 'host-substring',
        host: hostNeedle,
        test(hostLower) {
            return hostLower.includes(hostNeedle);
        }
    };
}

function loadLists() {
    try {
        const rules: BlacklistRule[] = [];
        if (fs.existsSync(BLACKLIST_FILE)) {
            const lines = fs.readFileSync(BLACKLIST_FILE, 'utf-8')
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean)
                .filter(l => !l.startsWith('#'));
            for (const line of lines) {
                const rule = buildRuleFromLine(line);
                if (rule) rules.push(rule);
            }
        }
        access.blacklistRules = rules;
        access.version++;
        console.log(`Access lists reloaded v${access.version}: blacklistRules=${rules.length}`);
    } catch (e) {
        console.error('Failed to load access lists', e);
    }
}

loadLists();

fs.watch(CONFIG_DIR, (eventType, filename) => {
    if (filename && filename === 'blacklist.txt') {
        console.log(`[watcher] Detected change in ${filename}, reloading lists...`);
        loadLists();
    }
});

// Config
const PORT = Number(process.env.PORT || 8080);

// App
const app = express();

// Basic health endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        listsVersion: access.version,
        blacklistRules: access.blacklistRules.map(r => r.raw)
    });
});

// Logging
app.use(morgan('dev'));

// Access control middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    const hostHeaderRaw = req.headers.host || '';
    const hostHeaderLower = hostHeaderRaw.toLowerCase();

    if (!hostHeaderLower) {
        return res.status(400).send('Missing target host');
    }

    const pathPart = req.path || '/';

    // Evaluate rules
    for (const rule of access.blacklistRules) {
        try {
            if (rule.test(hostHeaderLower, pathPart)) {
                console.log(`[blacklist] blocked host="${hostHeaderLower}" path="${pathPart}" rule="${rule.raw}"`);
                return res.status(403).send('Blocked by blacklist');
            }
        } catch (e) {
            console.error('[blacklist:test:error]', rule.raw, (e as Error).message);
        }
    }

    // Attach chosen target info to request for downstream middleware
    // _targetHostRaw preserves original host:port as-sent by client (or static target host)
    (req as any)._targetHostRaw = hostHeaderRaw;
    // _targetHostLower is intended for logging/matching
    (req as any)._targetHostLower = hostHeaderLower;
    next();
});

// Proxy middleware (catch-all) - only after access control
app.use('*', (req: Request, res: Response, next: NextFunction) => {
    const targetHostRaw: string = (req as any)._targetHostRaw;
    const target = `${req.protocol}://${targetHostRaw}`;

    console.log(target);

    // Avoid proxying health endpoint (already handled) - should not reach here due to route order.
    if (req.path === '/health') return next();

    console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${target}`);

    // Create per-request proxy to allow dynamic target while preserving the original Host header
    const opts: Options = {
        target,
        changeOrigin: false,
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq) => {
                proxyReq.setHeader('x-proxy-by', 'my-proxy');
            },
            error: (err, _req, res) => {
                console.error('[proxy:error]', err.message);
                const r = res as Response;
                if (!(r as any).headersSent) {
                    r.status(502).send('Bad gateway');
                }
            }
        }
    };
    return createProxyMiddleware(opts)(req, res, next);
});

// Error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Proxy server listening on http://localhost:${PORT}`);
    console.log(`Rules loaded: ${access.blacklistRules.length}`);
    console.log('Chrome MCP: launch with --proxyServer=http://localhost:' + PORT);
    console.log(`Config directory: ${CONFIG_DIR}`);
    console.log('Blacklist syntax examples:');
    console.log('  # comment');
    console.log('  example.com                (substring match in host)');
    console.log('  realestate.yahoo.co.jp/rent     (exact host+path)');
    console.log('  realestate.yahoo.co.jp/rent*    (glob subtree)');
    console.log('  *.tracking.com             (glob)');
    console.log('  regex:pattern');
    console.log('  regex:/^api\\.example\\.com\\/v[0-9]+/i');
});

// Handle HTTP CONNECT (tunneling) so Chrome/clients can use this as an HTTP proxy for HTTPS
server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    try {
        const reqUrl = (req.url || ''); // expected form: host:port
        const [host, portStr] = reqUrl.split(':');
        const port = Number(portStr) || 443;

        const targetHostLower = String(host).toLowerCase();

        // Blacklist check for CONNECT (host-only rules; cannot inspect path for HTTPS)
        for (const rule of access.blacklistRules) {
            // skip rules that require path information (cannot inspect path on CONNECT tunnels)
            if (rule.kind === 'host-exact-path' || rule.kind === 'host-subtree-path') continue;
            try {
                if (rule.test(targetHostLower, '')) {
                    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    clientSocket.destroy();
                    console.log(`[blacklist][CONNECT] blocked host="${targetHostLower}" rule="${rule.raw}"`);
                    return;
                }
            } catch (e) {
                console.error('[blacklist:connect:test:error]', rule.raw, (e as Error).message);
            }
        }

        // Establish a TCP connection to the destination
        const serverSocket = net.connect(port, host, () => {
            // Inform client that the tunnel is established
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            // If there is leftover data from the client, forward it
            if (head && head.length) serverSocket.write(head);
            // Bi-directional pipe
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        });

        serverSocket.on('error', (err) => {
            console.error('[tunnel:error]', err.message);
            try { clientSocket.end(); } catch (e) { /* noop */ }
        });
    } catch (err: any) {
        console.error('[tunnel] failed to establish tunnel', err && err.message ? err.message : err);
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy(); } catch (e) { /* noop */ }
    }
});