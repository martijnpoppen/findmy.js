import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';

import {
    FindMy,
    ICloudRequestError,
    SESSION_FORMAT_VERSION,
    UnauthenticatedError,
    isAuthenticationError,
    isTransientNetworkError,
} from '../dist/index.js';

const COOKIE_URL = 'https://www.icloud.com';

function fakeSession() {
    const cookies = new CookieJar();
    cookies.setCookieSync('X-APPLE-WEBAUTH-TOKEN=abc; Path=/', COOKIE_URL);

    return {
        version: SESSION_FORMAT_VERSION,
        cookies: cookies.toJSON(),
        accountInfo: {
            webservices: { findme: { url: 'https://p111-fmipweb.icloud.com' } },
            dsInfo: { appleId: 'someone@example.com' },
        },
        trustToken: 'trust-token',
        createdAt: Date.now() - 1000,
    };
}

test('a DNS failure is transient, not an auth failure', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND p111-fmipweb.icloud.com'), {
        type: 'system',
        errno: 'ENOTFOUND',
        code: 'ENOTFOUND',
    });

    assert.equal(isTransientNetworkError(err), true);
    assert.equal(isAuthenticationError(err), false);
});

test('socket resets and timeouts are transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']) {
        assert.equal(isTransientNetworkError({ code }), true, code);
    }
});

test('iCloud 421/450/401 mean the session is gone', () => {
    for (const status of [401, 421, 450]) {
        const err = new ICloudRequestError('https://example.invalid', status, '');
        assert.equal(err.isAuthError, true, `${status} is an auth error`);
        assert.equal(err.isTransient, false, `${status} is not transient`);
        assert.equal(isAuthenticationError(err), true);
    }
});

test('iCloud 5xx and 429 are transient, so the session is kept', () => {
    for (const status of [429, 500, 503]) {
        const err = new ICloudRequestError('https://example.invalid', status, '');
        assert.equal(err.isTransient, true, `${status} is transient`);
        assert.equal(err.isAuthError, false, `${status} is not an auth error`);
        assert.equal(isAuthenticationError(err), false);
    }
});

test('the request error carries the status instead of a flat string', () => {
    const err = new ICloudRequestError('https://example.invalid/x', 503, 'busy');
    assert.equal(err.status, 503);
    assert.equal(err.body, 'busy');
    assert.match(err.message, /503/);
});

test('a session survives an export/import round trip', () => {
    const findmy = new FindMy();
    assert.equal(findmy.isAuthenticated(), false);
    assert.equal(findmy.exportSession(), null);

    const stored = fakeSession();
    findmy.importSession(stored);

    assert.equal(findmy.isAuthenticated(), true);
    assert.equal(findmy.getTrustToken(), 'trust-token');
    assert.ok(findmy.getSessionAge() >= 1000);

    const exported = findmy.exportSession();
    assert.equal(exported.version, SESSION_FORMAT_VERSION);
    assert.equal(exported.trustToken, 'trust-token');
    assert.deepEqual(
        exported.accountInfo.webservices,
        stored.accountInfo.webservices
    );

    const restored = CookieJar.fromJSON(exported.cookies);
    assert.match(restored.getCookieStringSync(COOKIE_URL), /X-APPLE-WEBAUTH-TOKEN=abc/);
});

test('an unusable stored session is rejected rather than half-loaded', () => {
    const findmy = new FindMy();

    assert.throws(() => findmy.importSession({ ...fakeSession(), version: 999 }), {
        name: 'SessionExpiredError',
    });
    assert.throws(() => findmy.importSession({ ...fakeSession(), accountInfo: {} }), {
        name: 'SessionExpiredError',
    });

    assert.equal(findmy.isAuthenticated(), false);
});

test('requests without a session throw UnauthenticatedError', async () => {
    const findmy = new FindMy();

    await assert.rejects(() => findmy.getDevices(), UnauthenticatedError);
    assert.equal(isAuthenticationError(new UnauthenticatedError()), true);
});

test('validateSession without a session is false, not a throw', async () => {
    assert.equal(await new FindMy().validateSession(), false);
});
