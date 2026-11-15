import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import fetch from 'node-fetch';

import { isTransientNetworkError } from '../dist/index.js';
import { REQUEST_TIMEOUT_MS, fetchOptions } from '../dist/utils.js';

test('every request gets its own timeout signal', () => {
    const a = fetchOptions();
    const b = fetchOptions();

    assert.ok(a.signal instanceof AbortSignal);
    assert.notEqual(a.signal, b.signal);
    assert.ok(REQUEST_TIMEOUT_MS > 0);
});

// The production timeout is 30s; the same mechanism is exercised with a short
// signal so the test stays fast.
test('a stalled request is aborted and counts as a transient failure', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/body') {
            res.writeHead(200);
            res.write('{');
        }
        // '/headers': never respond at all
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        for (const route of ['/headers', '/body']) {
            await assert.rejects(
                async () => {
                    const res = await fetch(base + route, { signal: AbortSignal.timeout(100) });
                    await res.json();
                },
                (error) => {
                    assert.equal(error.name, 'AbortError');
                    assert.equal(isTransientNetworkError(error), true);
                    return true;
                }
            );
        }
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
