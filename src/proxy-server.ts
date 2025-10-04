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

const WHITELIST_FILE = path.join(CONFIG_DIR, 'whitelist.txt');
const BLACKLIST_FILE = path.join(CONFIG_DIR, 'blacklist.txt');

interface AccessLists {
    whitelist: Set<string>;
    blacklist: Set<string>;
    version: number; // increments when reloaded
}

const access: AccessLists = { whitelist: new Set(), blacklist: new Set(), version: 0 };

function loadLists() {
    try {
        if (fs.existsSync(WHITELIST_FILE)) {
            access.whitelist = new Set(
                fs.readFileSync(WHITELIST_FILE, 'utf-8')
                    .split(/\r?\n/)
                    .map(l => l.trim().toLowerCase())
                    .filter(Boolean)
            );
        }
        if (fs.existsSync(BLACKLIST_FILE)) {
            access.blacklist = new Set(
                fs.readFileSync(BLACKLIST_FILE, 'utf-8')
                    .split(/\r?\n/)
                    .map(l => l.trim().toLowerCase())
                    .filter(Boolean)
            );
        }
        access.version++;
        console.log(`Access lists reloaded v${access.version}: whitelist=${access.whitelist.size}, blacklist=${access.blacklist.size}`);
    } catch (e) {
        console.error('Failed to load access lists', e);
    }
}

loadLists();

fs.watch(CONFIG_DIR, (eventType, filename) => {
    if (filename && (filename === 'whitelist.txt' || filename === 'blacklist.txt')) {
        console.log(`[watcher] Detected change in ${filename}, reloading lists...`);
        loadLists();
    }
});

// Config
const PORT = Number(process.env.PORT || 8080);
// If you want to force all traffic to specific upstream instead of dynamic host header, set TARGET_HOST.
const STATIC_TARGET = process.env.TARGET_HOST; // e.g. http://localhost:9000

// App
const app = express();

// Basic health endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', listsVersion: access.version, whitelist: access.whitelist.size, blacklist: access.blacklist.size });
});

// Logging
app.use(morgan('dev'));

// Access control middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    const hostHeader = req.headers.host?.toLowerCase() || '';
    const targetHost = STATIC_TARGET ? new URL(STATIC_TARGET).host : hostHeader;

    if (!targetHost) {
        return res.status(400).send('Missing target host');
    }

    // Blacklist check (substring match)
    for (const entry of access.blacklist) {
        if (targetHost.includes(entry)) {
            return res.status(403).send('Blocked by blacklist');
        }
    }
    // Whitelist check if whitelist not empty
    if (access.whitelist.size > 0) {
        let allowed = false;
        for (const entry of access.whitelist) {
            if (targetHost.includes(entry)) { allowed = true; break; }
        }
        if (!allowed) {
            return res.status(403).send('Not in whitelist');
        }
    }
    // Attach chosen target to request for downstream middleware
    (req as any)._targetHost = targetHost;
    next();
});

// Proxy middleware (catch-all) - only after access control
app.use('*', (req: Request, res: Response, next: NextFunction) => {
    const originalHost = req.headers.host;
    const targetHost: string = (req as any)._targetHost;
    const target = STATIC_TARGET ? STATIC_TARGET : `${req.protocol}://${targetHost}`;

    // Avoid proxying health endpoint (already handled) - should not reach here due to route order.
    if (req.path === '/health') return next();

    console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${target}`);

    // Create per-request proxy to allow dynamic target
    const opts: Options = {
        target,
        changeOrigin: true,
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq) => {
                proxyReq.setHeader('x-proxy-by', 'my-proxy');
                if (STATIC_TARGET && originalHost) {
                    proxyReq.setHeader('x-forwarded-host', originalHost);
                }
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Proxy server listening on http://localhost:${PORT}`);
    console.log(`Lists: whitelist=${access.whitelist.size}, blacklist=${access.blacklist.size}`);
    console.log('Chrome MCP: launch with --proxyServer=http://localhost:' + PORT);
    if (STATIC_TARGET) {
        console.log(`Static target mode: ${STATIC_TARGET}`);
    } else {
        console.log('Dynamic host mode: uses Host header from client requests.');
    }
    console.log(`Config directory: ${CONFIG_DIR}`);
});

// Handle HTTP CONNECT (tunneling) so Chrome/clients can use this as an HTTP proxy for HTTPS
server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    try {
        const reqUrl = (req.url || ''); // expected form: host:port
        const [host, portStr] = reqUrl.split(':');
        const port = Number(portStr) || 443;

        const targetHost = STATIC_TARGET ? new URL(STATIC_TARGET).host : host;

        // Blacklist check (substring match)
        for (const entry of access.blacklist) {
            if (String(targetHost).includes(entry)) {
                clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                clientSocket.destroy();
                return;
            }
        }
        // Whitelist check if whitelist not empty
        if (access.whitelist.size > 0) {
            let allowed = false;
            for (const entry of access.whitelist) {
                if (String(targetHost).includes(entry)) { allowed = true; break; }
            }
            if (!allowed) {
                clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                clientSocket.destroy();
                return;
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