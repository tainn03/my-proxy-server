import http from 'http';

function request(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: Number(process.env.PORT || 8080), path, method: 'GET' }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    try {
        const res = await request('/health');
        console.log('Health response:', res);
    } catch (e) {
        console.error('Health check failed', e);
        process.exit(1);
    }
})();
