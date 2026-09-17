import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountLockedError,
    DEFAULT_BACKOFF,
    DEFAULT_LOCKOUT_COOLDOWN,
    DEFAULT_LOCKOUT_THRESHOLD,
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
    sessionToken: 'ds-web-auth-token',
    accountCountry: 'NLD',
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
    const calls = { authenticate: 0, validate: 0, getDevices: 0, renew: 0, rebuild: 0 };
    let authenticated = false;

    return {
        calls,
        importSession() { authenticated = true; },
        isAuthenticated: () => authenticated,
        deauthenticate() { authenticated = false; },
        termsUpdateNeeded: () => false,
        getTrustToken: () => 'fresh-token',
        async renewFromTokens() {
            calls.rebuild += 1;
            const outcome = script.rebuild?.(calls.rebuild);
            if (outcome instanceof Error) throw outcome;
            return outcome ?? false;
        },
        async renewWithToken() {
            calls.renew += 1;
            const outcome = script.renew?.(calls.renew);
            if (outcome instanceof Error) throw outcome;
            return outcome ?? false;
        },
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

test('a stored session is used directly, with no sign-in and no pre-flight', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store });

    const devices = await session.getDevices();

    assert.equal(client.calls.authenticate, 0, 'no sign-in, so no Apple login alert');
    assert.equal(client.calls.validate, 0, 'and no extra round trip to ask if it works');
    assert.equal(client.calls.getDevices, 1, 'the real call is the check');
    assert.deepEqual(devices, [{ id: 'device-1' }]);
});

test('a stored session iCloud rejects falls back to a sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession('old-token') });
    const { session, client } = makeSession({
        store,
        script: { getDevices: (n) => (n === 1 ? new ICloudRequestError('x', 450, '') : undefined) },
    });

    await session.getDevices();

    assert.equal(client.calls.authenticate, 1);
    assert.equal(client.calls.lastTrustToken, 'old-token', 'the trust token is replayed');
    assert.equal(store.calls.save >= 1, true, 'the new session is stored');
});

test('a network failure against a stored session never causes a sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store, script: { getDevices: () => dnsError() } });

    await assert.rejects(() => session.getDevices(), RetryLaterError);

    assert.equal(client.calls.authenticate, 0, 'the network was down, not the session');
    assert.equal(store.calls.clear, 0, 'the stored session is left intact');
});

test('new credentials are proven rather than shadowed by a working session', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({ store });

    await session.getDevices();
    assert.equal(client.calls.authenticate, 0, 'the stored session serves the first call');

    // Someone re-paired with a different password. Reusing the old session
    // here would let a wrong password look correct and fail later.
    session.setCredentials('someone@example.com', 'a-different-password');
    await session.getDevices();

    assert.equal(client.calls.authenticate, 1, 'the new password is actually tried');
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

test('sign-ins stop once they stop helping', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { getDevices: () => new ICloudRequestError('x', 421, '') },
    });

    // The stored session is rejected, so one immediate sign-in is warranted.
    // iCloud rejects that brand new session too.
    const first = await session.getDevices().catch((e) => e);

    assert.ok(first instanceof RetryLaterError);
    assert.equal(client.calls.authenticate, 1, 'exactly one sign-in, not two');
    assert.equal(first.nextAttemptAt - clock.t, 300_000);

    // Each further round costs one more sign-in, spaced further apart.
    clock.t = session.nextAttemptAt;
    const second = await session.getDevices().catch((e) => e);

    assert.ok(second instanceof RetryLaterError);
    assert.equal(client.calls.authenticate, 2);
    assert.equal(second.nextAttemptAt - clock.t, 900_000);

    // The third is the last: signing in is clearly not what is wrong, so the
    // breaker stops rather than keep extending Apple's lockout.
    clock.t = session.nextAttemptAt;
    const third = await session.getDevices().catch((e) => e);

    assert.ok(third instanceof AccountLockedError, 'the breaker trips');
    assert.equal(client.calls.authenticate, DEFAULT_LOCKOUT_THRESHOLD);
    assert.equal(session.isLockedOut, true);
    assert.equal(third.until - clock.t, DEFAULT_LOCKOUT_COOLDOWN);
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

test('a failed sign-in still paces the next one', async () => {
    const store = memoryStore();
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { authenticate: () => new Error('signin/complete 401: bad password') },
    });

    await assert.rejects(() => session.getDevices());
    assert.equal(client.calls.authenticate, 1);

    // The failure has to stick to the session, or a caller that rebuilds it
    // every poll would retry the sign-in every poll.
    assert.equal(session.isBackingOff, true);
    assert.equal(session.nextAttemptAt - clock.t, 300_000);
});

test('new credentials clear the backoff', async () => {
    const store = memoryStore();
    const clock = { t: 1_000_000 };
    const { session, client } = makeSession({
        store,
        clock,
        script: { authenticate: (n) => (n === 1 ? new Error('signin/complete 401') : undefined) },
    });

    await assert.rejects(() => session.getDevices());
    assert.equal(session.isBackingOff, true);

    session.setCredentials('someone@example.com', 'the-right-one');
    assert.equal(session.isBackingOff, false, 'a corrected password is tried at once');

    await session.getDevices();
    assert.equal(client.calls.authenticate, 2);
});

test('re-setting the same credentials does not clear the backoff', async () => {
    const store = memoryStore();
    const clock = { t: 1_000_000 };
    const { session } = makeSession({
        store,
        clock,
        script: { authenticate: () => new Error('signin/complete 401') },
    });

    await assert.rejects(() => session.getDevices());

    session.setCredentials('someone@example.com', 'hunter2');
    assert.equal(session.isBackingOff, true, 'nothing changed, so nothing is reconsidered');
});

test('a 450 recovers by renewing the token, with no sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: {
            getDevices: (n) => (n === 1 ? new ICloudRequestError('x', 450, '') : undefined),
            renew: () => true,
        },
    });

    // The reported failure: a restart, a stored session, an immediate 450.
    const devices = await session.getDevices();

    assert.equal(client.calls.renew, 1, 'the stored token was replayed');
    assert.equal(client.calls.authenticate, 0, 'and no sign-in, so no Apple login alert');
    assert.equal(client.calls.getDevices, 2, 'the call was retried after renewing');
    assert.deepEqual(devices, [{ id: 'device-1' }]);
    assert.equal(store.calls.clear, 0, 'the stored session was never discarded');
});

test('the renewed session is written back', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: {
            getDevices: (n) => (n === 1 ? new ICloudRequestError('x', 421, '') : undefined),
            renew: () => true,
        },
    });

    const before = store.calls.save;
    await session.getDevices();

    assert.ok(store.calls.save > before, 'fresh cookies are persisted straight away');
    assert.equal(client.calls.authenticate, 0);
});

test('a refused token falls back to a sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: {
            getDevices: (n) => (n <= 1 ? new ICloudRequestError('x', 450, '') : undefined),
            renew: () => false,
        },
    });

    await session.getDevices();

    assert.equal(client.calls.renew, 1, 'renewal is tried first');
    assert.equal(client.calls.authenticate, 1, 'and only then a sign-in');
});

test('renewal is attempted once per call, not in a loop', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: {
            getDevices: () => new ICloudRequestError('x', 450, ''),
            renew: () => true,
        },
    });

    // Renewal keeps "succeeding" but the call keeps failing. Without a guard
    // this would renew forever.
    await assert.rejects(() => session.getDevices(), RetryLaterError);

    assert.equal(client.calls.renew, 1);
    assert.equal(client.calls.authenticate, 1, 'one sign-in, then it backs off');
});

test('a network failure during renewal backs off instead of signing in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const { session, client } = makeSession({
        store,
        script: {
            getDevices: () => new ICloudRequestError('x', 450, ''),
            renew: () => dnsError(),
        },
    });

    await assert.rejects(() => session.getDevices(), RetryLaterError);

    assert.equal(client.calls.authenticate, 0, 'the network was down, not the token');
    assert.equal(store.calls.clear, 0, 'the stored session is kept');
});

test('two days of 450s cost no sign-ins at all when the token still works', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 0 };
    let call = 0;
    const { session, client } = makeSession({
        store,
        clock,
        // Every other call is rejected; renewal always works.
        script: { getDevices: () => (++call % 2 ? new ICloudRequestError('x', 450, '') : undefined), renew: () => true },
    });

    while (clock.t < 2 * 24 * 60 * 60 * 1000) {
        await session.getDevices().catch(() => {});
        clock.t += 60_000;
    }

    assert.equal(client.calls.authenticate, 0, 'zero login alerts across two days');
    assert.ok(client.calls.renew > 100, 'recovered by renewing throughout');
});

// ---------------------------------------------------------------------------
// Restarts. A Homey restarts its apps on crash, update and reboot - which is
// exactly what happens during an internet outage. Every test above uses one
// long-lived object, so none of them covered this.
// ---------------------------------------------------------------------------

/** A new process: same store, same clock, brand new session object. */
function restart(store, clock, script = {}) {
    return makeSession({ store, clock, script });
}

test('a restart mid-backoff does not buy a free sign-in', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };

    const first = makeSession({
        store,
        clock,
        script: { getDevices: () => new ICloudRequestError('x', 450, '') },
    });

    await assert.rejects(() => first.session.getDevices(), RetryLaterError);
    assert.equal(first.client.calls.authenticate, 1);
    assert.ok(first.session.nextAttemptAt > clock.t, 'backing off');

    // The app restarts one minute later, still inside the backoff window.
    clock.t += 60_000;
    const second = restart(store, clock, { getDevices: () => new ICloudRequestError('x', 450, '') });

    const error = await second.session.getDevices().catch((e) => e);

    assert.ok(error instanceof RetryLaterError, 'the new process picks the backoff up');
    assert.equal(second.client.calls.authenticate, 0, 'and signs in exactly zero times');
});

test('an auth failure keeps the tokens so a restart can recover silently', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };

    const first = makeSession({
        store,
        clock,
        script: { getDevices: () => new ICloudRequestError('x', 450, '') },
    });

    await assert.rejects(() => first.session.getDevices(), RetryLaterError);

    // The record must still be there, and must still carry the token.
    const kept = store.data.get('account-key');

    assert.ok(kept, 'the stored record was not deleted');
    assert.equal(kept.sessionToken, 'ds-web-auth-token', 'the token survived');
    assert.equal(kept.trustToken, 'trust-me', 'so did the trust token');
    assert.equal(kept.cookies, null, 'only the dead cookies were dropped');

    // After the backoff, a restart rebuilds from that token instead of
    // signing in - this is the path that used to hit ENOENT.
    clock.t = first.session.nextAttemptAt;
    const second = restart(store, clock, { rebuild: () => true });

    const devices = await second.session.getDevices();

    assert.equal(second.client.calls.rebuild, 1, 'rebuilt from the stored token');
    assert.equal(second.client.calls.authenticate, 0, 'with no sign-in and no login alert');
    assert.deepEqual(devices, [{ id: 'device-1' }]);
});

test('the breaker survives a restart', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const reject = { getDevices: () => new ICloudRequestError('x', 450, '') };

    let current = makeSession({ store, clock, script: reject });

    // Drive it to the lockout.
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD; i++) {
        clock.t = Math.max(clock.t, current.session.nextAttemptAt);
        await current.session.getDevices().catch(() => {});
    }
    assert.equal(current.session.isLockedOut, true);

    // A restart must not shrug the lockout off.
    clock.t += 60_000;
    const after = restart(store, clock, reject);
    const error = await after.session.getDevices().catch((e) => e);

    assert.ok(error instanceof AccountLockedError, 'still locked in the new process');
    assert.equal(after.client.calls.authenticate, 0, 'no sign-in attempted');
    assert.match(error.message, /icloud\.com\/find/, 'and it says what to do about it');
});

test('the breaker releases after the cooldown and re-arms if still broken', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    const reject = { getDevices: () => new ICloudRequestError('x', 450, '') };

    const { session, client } = makeSession({ store, clock, script: reject });

    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD; i++) {
        clock.t = Math.max(clock.t, session.nextAttemptAt);
        await session.getDevices().catch(() => {});
    }

    const signInsBefore = client.calls.authenticate;
    assert.equal(session.isLockedOut, true);

    // Once the cooldown expires the account gets exactly one more probe.
    clock.t = session.lockedUntil;
    assert.equal(session.isLockedOut, false, 'the lock lifts on its own');

    await session.getDevices().catch(() => {});

    assert.equal(client.calls.authenticate, signInsBefore + 1, 'one probe, not a burst');
    assert.equal(session.isLockedOut, true, 're-armed immediately when it failed again');
});

test('a locked account recovers the moment iCloud accepts it again', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 1_000_000 };
    let broken = true;

    const { session } = makeSession({
        store,
        clock,
        script: { getDevices: () => (broken ? new ICloudRequestError('x', 450, '') : undefined) },
    });

    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD; i++) {
        clock.t = Math.max(clock.t, session.nextAttemptAt);
        await session.getDevices().catch(() => {});
    }
    assert.equal(session.isLockedOut, true);

    broken = false;
    clock.t = session.lockedUntil;

    await session.getDevices();

    assert.equal(session.isLockedOut, false);
    assert.equal(session.nextAttemptAt, 0, 'fully healthy again');
});

test('the reported scenario: an outage plus a restart every 10 minutes', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 0 };
    let signIns = 0;

    // iCloud rejects every session, the way it does for a throttled account.
    const reject = { getDevices: () => new ICloudRequestError('x', 450, '') };

    const DAY = 24 * 60 * 60 * 1000;
    let current = makeSession({ store, clock, script: reject });

    while (clock.t < DAY) {
        // A poll every 2 minutes, and a restart every 10.
        for (let i = 0; i < 5 && clock.t < DAY; i++) {
            await current.session.getDevices().catch(() => {});
            clock.t += 120_000;
        }

        signIns += current.client.calls.authenticate;
        current = restart(store, clock, reject);
    }

    signIns += current.client.calls.authenticate;

    // Before this change every restart signed in: 144 restarts, 144 alerts.
    console.log(`  → ${signIns} sign-ins across a day of 2min polls and 10min restarts`);
    assert.ok(signIns <= 6, `expected at most 6 sign-ins in a day, got ${signIns}`);
});

test('a deep outage backoff survives a restart', async () => {
    const store = memoryStore({ 'account-key': storedSession() });
    const clock = { t: 0 };
    const outage = { getDevices: () => dnsError() };

    const first = makeSession({ store, clock, script: outage });

    // Ride the transient ladder up past the five-minute mark.
    for (let i = 0; i < 4; i++) {
        clock.t = Math.max(clock.t, first.session.nextAttemptAt);
        await first.session.getDevices().catch(() => {});
    }

    const waitLeft = first.session.nextAttemptAt - clock.t;
    assert.ok(waitLeft >= 300_000, 'a meaningful backoff is in place');

    // The outage takes the Homey with it and the app comes back up.
    clock.t += 30_000;
    const second = restart(store, clock, outage);
    const error = await second.session.getDevices().catch((e) => e);

    assert.ok(error instanceof RetryLaterError);
    assert.equal(second.client.calls.authenticate, 0, 'a restart mid-outage signs in zero times');
    assert.ok(second.session.nextAttemptAt > clock.t, 'and keeps waiting');
});
