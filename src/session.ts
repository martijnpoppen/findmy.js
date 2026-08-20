import { FindMyDevice } from './device.js';
import { isAuthenticationError, isTransientNetworkError } from './errors.js';
import { FindMy, SerializedSession } from './findmy.js';

/**
 * Where a session is kept between runs. The library does not care whether
 * that is a file, a database or a keychain — only the host knows how to
 * store secrets safely on its own platform.
 */
export interface SessionStore {
    load(key: string): Promise<SerializedSession | null> | SerializedSession | null;
    save(key: string, session: SerializedSession): Promise<void> | void;
    clear(key: string): Promise<void> | void;
}

export interface BackoffConfig {
    /** Waits after a failure that says nothing about the session. */
    transient: number[];
    /** Waits between sign-ins after iCloud rejected the session. */
    reauth: number[];
}

/**
 * Apple emails the account holder a login alert for every new iCloud web
 * session, which makes a sign-in the most expensive thing this library can
 * do. A network failure therefore waits and keeps the session, and repeated
 * sign-ins slow down hard so a wrong password cannot turn into a stream of
 * alerts.
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
    transient: [60_000, 120_000, 300_000, 600_000, 900_000],
    reauth: [0, 300_000, 900_000, 1_800_000, 3_600_000],
};

export const DEFAULT_SESSION_SAVE_INTERVAL = 30 * 60 * 1000;

const pick = (schedule: number[], attempt: number): number => {
    if (schedule.length === 0) return 0;
    const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
    return schedule[index] ?? 0;
};

/**
 * Thrown when the call could not be served but the session is still worth
 * keeping. Callers should skip this account until `nextAttemptAt` and must
 * not treat it as a reason to sign in again.
 */
export class RetryLaterError extends Error {
    readonly nextAttemptAt: number;
    readonly reason: unknown;

    constructor(message: string, nextAttemptAt: number, reason: unknown) {
        super(message);
        this.name = 'RetryLaterError';
        this.nextAttemptAt = nextAttemptAt;
        this.reason = reason;
    }
}

export interface FindMySessionOptions {
    /** Identifies this account in the store. Never logged by the library. */
    key: string;
    username: string;
    password: string;
    store?: SessionStore;
    backoff?: Partial<BackoffConfig>;
    sessionSaveInterval?: number;
    logger?: (...args: unknown[]) => void;
    /** Injectable clock, for tests. */
    now?: () => number;
    /** Injectable client factory, for tests. */
    createClient?: () => FindMy;
}

interface SessionHealth {
    errorCount: number;
    reauths: number;
    nextAttemptAt: number;
    lastSessionSave: number;
    lastError: string | null;
}

/**
 * A Find My connection that looks after itself: it restores a stored session
 * instead of signing in, tells an expired session apart from a flaky network,
 * and backs off rather than reconnecting in a loop.
 */
export class FindMySession {
    private readonly key: string;
    private readonly store: SessionStore | null;
    private readonly backoff: BackoffConfig;
    private readonly sessionSaveInterval: number;
    private readonly log: (...args: unknown[]) => void;
    private readonly now: () => number;
    private readonly createClient: () => FindMy;

    private username: string;
    private password: string;
    private findmy: FindMy | null = null;
    private credentialsUnproven = false;
    /**
     * Last trust token seen for this account. Held on the session rather than
     * read off the stored file, because a forced sign-in has no stored file to
     * read and would otherwise present itself to Apple as a brand new browser.
     */
    private trustToken: string | null = null;

    private health: SessionHealth = {
        errorCount: 0,
        reauths: 0,
        nextAttemptAt: 0,
        lastSessionSave: 0,
        lastError: null,
    };

    constructor(options: FindMySessionOptions) {
        this.key = options.key;
        this.username = options.username;
        this.password = options.password;
        this.store = options.store ?? null;
        this.backoff = {
            transient: options.backoff?.transient ?? DEFAULT_BACKOFF.transient,
            reauth: options.backoff?.reauth ?? DEFAULT_BACKOFF.reauth,
        };
        this.sessionSaveInterval =
            options.sessionSaveInterval ?? DEFAULT_SESSION_SAVE_INTERVAL;
        this.log = options.logger ?? (() => {});
        this.now = options.now ?? (() => Date.now());
        this.createClient = options.createClient ?? (() => new FindMy());
    }

    /** The underlying client, for calls this wrapper does not cover. */
    get client(): FindMy | null {
        return this.findmy;
    }

    get isConnected(): boolean {
        return !!this.findmy?.isAuthenticated();
    }

    get nextAttemptAt(): number {
        return this.health.nextAttemptAt;
    }

    get isBackingOff(): boolean {
        return this.health.nextAttemptAt > this.now();
    }

    get lastError(): string | null {
        return this.health.lastError;
    }

    setCredentials(username: string, password: string): void {
        if (username === this.username && password === this.password) return;

        this.username = username;
        this.password = password;

        // New credentials are new information. An account that was waiting
        // out a rejected password should not keep waiting on the old one.
        this.health.errorCount = 0;
        this.health.reauths = 0;
        this.health.nextAttemptAt = 0;
        this.health.lastError = null;

        // A stored session that still works would otherwise let a wrong
        // password pair successfully and fail later. Drop the live one too,
        // or the next call would just keep using it. The trust token is kept:
        // it identifies the client, not the password.
        this.credentialsUnproven = true;
        this.findmy = null;
    }

    termsUpdateNeeded(): boolean {
        return !!this.findmy?.termsUpdateNeeded();
    }

    /**
     * Restore the stored session, and sign in only when there is nothing to
     * restore. Whether iCloud still accepts it is answered by the first real
     * call rather than by a pre-flight, so a restore never costs a request and
     * never produces a false negative worth an Apple login alert.
     */
    async connect({ forceLogin = false } = {}): Promise<void> {
        const findmy = this.createClient();
        const skipStored = forceLogin || this.credentialsUnproven;
        const stored = skipStored ? null : await this.loadStored();

        if (stored) {
            try {
                findmy.importSession(stored);
                this.trustToken = stored.trustToken || this.trustToken;

                const ageHours = Math.round((this.now() - stored.createdAt) / 3_600_000);
                this.log(`findmy: reusing the stored session (${ageHours}h old), no sign-in needed`);

                // Deliberately not pre-flighted. Asking a second endpoint
                // whether the session works risks a false negative that costs
                // a sign-in and an Apple login alert, and the first real call
                // answers the same question for free: a rejected session comes
                // back 401/421/450 and getDevices() signs in and retries.
                this.findmy = findmy;
                this.markConnected();

                return;
            } catch (error) {
                this.log('findmy: stored session unusable', (error as Error).message);
            }
        }

        await this.clearStored();

        // Counted here because this is the only place a sign-in happens, and
        // the count is what paces them.
        this.health.reauths = this.health.reauths + 1;

        this.log(
            'findmy: signing in. This creates a new iCloud web session and ' +
            'Apple will send the account holder a login alert for it.'
        );

        try {
            // Replaying the previous trust token marks this as a client Apple
            // has already seen rather than a brand new browser.
            await findmy.authenticate(
                this.username,
                this.password,
                this.trustToken ?? undefined
            );
        } catch (error) {
            this.findmy = null;

            if (isTransientNetworkError(error)) {
                throw this.noteTransient(error, 'signin');
            }

            throw this.noteReauth(error, 'signin');
        }

        this.findmy = findmy;
        this.trustToken = findmy.getTrustToken() || this.trustToken;
        this.credentialsUnproven = false;
        this.markConnected();
        await this.persist({ force: true });
    }

    /**
     * Fetch the account's devices, connecting or reconnecting as needed.
     * Raises RetryLaterError when the caller should skip this round instead
     * of trying harder.
     */
    async getDevices(shouldLocate = true): Promise<Array<FindMyDevice>> {
        if (this.isBackingOff) {
            throw new RetryLaterError(
                'Still backing off',
                this.health.nextAttemptAt,
                this.health.lastError
            );
        }

        if (!this.isConnected) {
            await this.connect();
        }

        for (;;) {
            try {
                const devices = await this.findmy!.getDevices(shouldLocate);

                this.markHealthy();
                await this.persist();

                return devices;
            } catch (error) {
                if (!isAuthenticationError(error)) {
                    // Transient, or something we do not recognise. Either way
                    // the session is still the best one we have, so keep it.
                    throw this.noteTransient(error, 'refresh');
                }

                this.findmy = null;
                await this.clearStored();

                this.health.errorCount = this.health.errorCount + 1;
                this.health.lastError = describe(error);

                // A session that has been serving fine may simply have aged
                // out, so the first rejection buys an immediate sign-in. A
                // rejection right after one does not: that is iCloud refusing
                // a brand new session, and signing in again only produces
                // another login alert.
                const wait = pick(this.backoff.reauth, this.health.reauths);

                if (wait > 0) {
                    this.health.nextAttemptAt = this.now() + wait;

                    throw new RetryLaterError(
                        'Session rejected; waiting before signing in again',
                        this.health.nextAttemptAt,
                        error
                    );
                }

                this.log(
                    'findmy: session rejected by iCloud, signing in again',
                    this.health.lastError
                );

                await this.connect({ forceLogin: true });
            }
        }
    }

    /** Drop the in-memory session but keep the stored one. */
    disconnect(): void {
        this.findmy?.deauthenticate();
        this.findmy = null;
    }

    /** Drop the session and forget it, so the next connect signs in. */
    async forget(): Promise<void> {
        this.disconnect();
        await this.clearStored();
    }

    // ---------------- internals ----------------

    /** Connected, but not yet proven to actually serve data. */
    private markConnected(): void {
        this.health.errorCount = 0;
        this.health.nextAttemptAt = 0;
        this.health.lastError = null;
    }

    /**
     * A completed round trip. Only this clears the sign-in counter — clearing
     * it on connect would let a session that is rejected immediately after
     * every sign-in earn a fresh sign-in every round.
     */
    private markHealthy(): void {
        this.markConnected();
        this.health.reauths = 0;
    }

    private noteTransient(error: unknown, phase: string): RetryLaterError {
        this.health.errorCount = this.health.errorCount + 1;
        this.health.lastError = describe(error);
        this.health.nextAttemptAt =
            this.now() + pick(this.backoff.transient, this.health.errorCount - 1);

        this.log(
            `findmy: ${phase} failed, keeping the session`,
            this.health.lastError,
            `retrying in ${Math.round((this.health.nextAttemptAt - this.now()) / 1000)}s`
        );

        return new RetryLaterError(
            this.health.lastError,
            this.health.nextAttemptAt,
            error
        );
    }

    private noteReauth(error: unknown, phase: string): unknown {
        this.health.errorCount = this.health.errorCount + 1;
        this.health.lastError = describe(error);
        this.health.nextAttemptAt =
            this.now() + pick(this.backoff.reauth, this.health.reauths);

        this.log(`findmy: ${phase} failed`, this.health.lastError);

        return error;
    }

    private async loadStored(): Promise<SerializedSession | null> {
        if (!this.store) return null;

        try {
            return (await this.store.load(this.key)) ?? null;
        } catch (error) {
            this.log('findmy: could not read the stored session', describe(error));

            return null;
        }
    }

    private async persist({ force = false } = {}): Promise<boolean> {
        if (!this.store || !this.findmy) return false;

        if (!force && this.now() - this.health.lastSessionSave < this.sessionSaveInterval) {
            return false;
        }

        const session = this.findmy.exportSession();

        if (!session) return false;

        try {
            await this.store.save(this.key, session);
            this.health.lastSessionSave = this.now();

            return true;
        } catch (error) {
            this.log('findmy: could not store the session', describe(error));

            return false;
        }
    }

    private async clearStored(): Promise<void> {
        if (!this.store) return;

        try {
            await this.store.clear(this.key);
        } catch (error) {
            this.log('findmy: could not clear the stored session', describe(error));
        }
    }
}

const describe = (error: unknown): string =>
    (error instanceof Error && error.message) || String(error);
