import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_BACKOFF,
    FindMySession,
    ICloudRequestError,
    RetryLaterError,
} from '../dist/index.js';

const dnsError = () =>
    Object.assign(new Error('getaddrinfo ENOTFOUND p111-fmipweb.icloud.com'), {
        type: 'system',
        code: 'ENOTFOUND',
        errno: 'ENOTFOUND',
    });

const storedSession = (trustToken = 'trust-me') => ({
    version: 1,
    cookies: { version: 'tough-cookie@4', storeType: 'MemoryCookieStore', cookies: [] },
    accountInfo: { webservices: { findme: { url: 'https://p111-fmipweb.icloud.com' } } },
    trustToken,
    createdAt: 0,
});

/** In-memory SessionStore, standing in for whatever the host persists to. */
function memoryStore(initial = {}) {
    const data = new Map(Object.entries(initial));
    const calls = { load: 0, save: 0, clear: 0 };

    return {
        data,
        calls,
        load(key) { calls.load += 1; return data.get(key) ?? null; },
        save(key, session) { calls.save += 1; data.set(key, session); },
        clear(key) { calls.clear += 1; data.delete(key); },
    };
}

/** Scriptable stand-in for the FindMy client. */
function fakeClient(script = {}) {
    const calls = { authenticate: 0, validate: 0, getDevices: 0 };
    let authenticated = false;

    return {
        calls,
        importSession() { authenticated = true; },
        isAuthenticated: () => authenticated,
        deauthenticate() { authenticated = false; },
        termsUpdateNeeded: () => false,
        exportSession: () => (authenticated ? storedSession() : null),
        async validateSession() {
            calls.validate += 1;
            const outcome = script.validate?.(calls.validate);
            if (outcome instanceof Error) throw outcome;
            if (outcome === false) authenticated = false;
            return outcome ?? true;
        },
        async authenticate(username, password, trustToken) {
            calls.authenticate += 1;
            calls.lastTrustToken = trustToken;
            const outcome = script.authenticate?.(calls.authenticate);
            if (outcome instanceof Error) throw outcome;
            authenticated = true;
        },
        async getDevices() {
            calls.getDevices += 1;
            const outcome = script.getDevices?.(calls.getDevices);
            if (outcome instanceof Error) throw outcome;
            return outcome ?? [{ id: 'device-1' }];
        },
    };
}

function makeSession({ store, script = {}, clock = { t: 1_000_000 }, ...rest } = {}) {
    const client = fakeClient(script);
    const session = new FindMySession({
        key: 'account-key',
        username: 'someone@example.com',
        password: 'hunter2',
        store,
        now: () => clock.t,
        createClient: () => client,
        ...rest,
    });

    return { session, client, clock };
}

test('a stored session is reused instead of signing in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store });

    const devices = await session.getDevices();

    assert.equal(client.calls.authenticate, 0, 'no sign-in, so no Apple login alert');
    assert.equal(client.calls.validate, 1, 'the stored session was checked first');
    assert.deepEqual(devices, [{ id: 'device-1' }]);
});

test('a rejected stored session falls back to a sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession('old-token') });
    const { session, client } = makeSession({ store, script: { validate: () => false } });

    await session.getDevices();

    assert.equal(client.calls.authenticate, 1);
    assert.equal(client.calls.lastTrustToken, 'old-token', 'the trust token is replayed');
    assert.equal(store.calls.save >= 1, true, 'the new session is stored');
});

test('a network failure while validating never causes a sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store, script: { validate: () => dnsError() } });

    await assert.rejects(() => session.getDevices(), RetryLaterError);

    assert.equal(client.calls.authenticate, 0, 'the network was down, not the session');
    assert.equal(store.calls.clear, 0, 'the stored session is left intact');
});

test('repeated network failures back off and never sign in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { getDevices: () => dnsError() },
    });

    const waits = [];
    for (let i = 0; i < 6; i++) {
        clock.t = session.nextAttemptAt || clock.t;
        const error = await session.getDevices().catch((e) => e);
        assert.ok(error instanceof RetryLaterError, 'reported as retry-later');
        waits.push(error.nextAttemptAt - clock.t);
    }

    assert.deepEqual(waits, [...DEFAULT_BACKOFF.transient, 900_000]);
    assert.equal(client.calls.authenticate, 0, 'six failures, zero login alerts');
    assert.equal(session.isConnected, true, 'the session was kept throughout');
});

test('an iCloud 5xx is treated as transient too', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: { getDevices: () => new ICloudRequestError('x', 503, 'busy') },
    });

    await assert.rejects(() => session.getDevices(), RetryLaterError);

    assert.equal(client.calls.authenticate, 0);
    assert.equal(store.calls.clear, 0);
});

test('a rejected session signs in again once, immediately', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: { getDevices: (n) => (n === 1 ? new ICloudRequestError('x', 450, '') : undefined) },
    });

    const devices = await session.getDevices();

    assert.equal(client.calls.authenticate, 1, 'exactly one sign-in');
    assert.equal(client.calls.getDevices, 2, 'and the call was retried');
    assert.deepEqual(devices, [{ id: 'device-1' }]);
});

test('a session rejected right after signing in does not sign in again', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { getDevices: () => new ICloudRequestError('x', 421, '') },
    });

    // The stored session is rejected, so one immediate sign-in is warranted.
    // iCloud rejects that brand new session too, and that is where it stops.
    const first = await session.getDevices().catch((e) => e);

    assert.ok(first instanceof RetryLaterError);
    assert.equal(client.calls.authenticate, 1, 'exactly one sign-in, not two');
    assert.equal(first.nextAttemptAt - clock.t, 300_000);

    const waits = [];
    for (let i = 0; i < 4; i++) {
        clock.t = session.nextAttemptAt;
        const error = await session.getDevices().catch((e) => e);
        waits.push(error.nextAttemptAt - clock.t);
    }

    assert.deepEqual(waits, [900_000, 1_800_000, 3_600_000, 3_600_000]);
    assert.equal(client.calls.authenticate, 5);
});

test('a permanently broken account is capped at one sign-in an hour', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 0 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { getDevices: () => new ICloudRequestError('x', 450, '') },
    });

    // Six hours of a 60s poll loop against an account iCloud keeps rejecting.
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    while (clock.t < SIX_HOURS) {
        await session.getDevices().catch(() => {});
        clock.t += 60_000;
    }

    // Sign-ins land at 0, 5m, 20m, 50m, then hourly: 9 over six hours. The
    // old loop signed in every ~5 minutes, which is ~72 Apple login alerts.
    assert.ok(
        client.calls.authenticate <= 10,
        `expected at most 10 sign-ins in six hours, got ${client.calls.authenticate}`
    );
});

test('a call made while backing off is refused without touching the network', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { getDevices: () => dnsError() },
    });

    await assert.rejects(() => session.getDevices(), RetryLaterError);
    const callsAfterFirst = client.calls.getDevices;

    assert.equal(session.isBackingOff, true);
    await assert.rejects(() => session.getDevices(), RetryLaterError);
    assert.equal(client.calls.getDevices, callsAfterFirst, 'no request was made');

    clock.t = session.nextAttemptAt;
    assert.equal(session.isBackingOff, false, 'the window reopens');
});

test('a success clears the error state', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session } = makeSession({
        store,
        clock,
        script: { getDevices: (n) => (n <= 2 ? dnsError() : undefined) },
    });

    await assert.rejects(() => session.getDevices(), RetryLaterError);
    clock.t = session.nextAttemptAt;
    await assert.rejects(() => session.getDevices(), RetryLaterError);
    clock.t = session.nextAttemptAt;

    await session.getDevices();

    assert.equal(session.nextAttemptAt, 0);
    assert.equal(session.lastError, null);
    assert.equal(session.isBackingOff, false);
});

test('session writes are throttled between saves', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session } = makeSession({ store, clock, sessionSaveInterval: 60_000 });

    await session.getDevices();
    const afterConnect = store.calls.save;

    await session.getDevices();
    assert.equal(store.calls.save, afterConnect, 'no write inside the window');

    clock.t += 60_001;
    await session.getDevices();
    assert.equal(store.calls.save, afterConnect + 1, 'one write after the window');
});

test('forget() drops the session so the next call signs in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store });

    await session.getDevices();
    assert.equal(client.calls.authenticate, 0);

    await session.forget();
    assert.equal(store.data.has('account-key'), false);

    await session.getDevices();
    assert.equal(client.calls.authenticate, 1);
});

test('a session works without a store, it just cannot survive a restart', async () => {
    const { session, client } = makeSession({ store: undefined });

    await session.getDevices();
    await session.getDevices();

    assert.equal(client.calls.authenticate, 1, 'signs in once and keeps it in memory');
});
