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

interface AccessLists {
    blacklist: Set<string>;
    version: number; // increments when reloaded
}

const access: AccessLists = { blacklist: new Set(), version: 0 };

function loadLists() {
    try {
        if (fs.existsSync(BLACKLIST_FILE)) {
            access.blacklist = new Set(
                fs.readFileSync(BLACKLIST_FILE, 'utf-8')
                    .split(/\r?\n/)
                    .map(l => l.trim())
                    .map(l => l.toLowerCase())
                    .filter(Boolean)
                    .filter(l => !l.startsWith('#'))
            );
        }
        access.version++;
        console.log(`Access lists reloaded v${access.version}: blacklist=${access.blacklist.size}`);
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
        blacklist: Array.from(access.blacklist)
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

    // Blacklist check (substring match) using lowercased host for comparisons
    for (const entry of access.blacklist) {
        if (hostHeaderLower.includes(entry)) {
            return res.status(403).send('Blocked by blacklist');
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
    console.log(`Lists: blacklist=${access.blacklist.size}`);
    console.log('Chrome MCP: launch with --proxyServer=http://localhost:' + PORT);
    console.log(`Config directory: ${CONFIG_DIR}`);
});

// Handle HTTP CONNECT (tunneling) so Chrome/clients can use this as an HTTP proxy for HTTPS
server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    try {
        const reqUrl = (req.url || ''); // expected form: host:port
        const [host, portStr] = reqUrl.split(':');
        const port = Number(portStr) || 443;

        const targetHostLower = String(host).toLowerCase();

        // Blacklist check (substring match) using lowercase comparison
        for (const entry of access.blacklist) {
            if (targetHostLower.includes(entry)) {
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