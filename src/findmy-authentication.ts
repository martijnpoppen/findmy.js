import { CookieJar } from 'tough-cookie';
import {
    AUTH_ENDPOINT,
    AUTH_HEADERS,
    COOKIE_URL,
    DEFAULT_HEADERS,
    SETUP_ENDPOINT
} from './constants.js';
import {
    GSASRPAuthenticator,
    ServerSRPInitResponse,
} from './gsasrp-authenticator.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { ICloudRequestError } from './errors.js';
import { extractiCloudCookies, fetchOptions } from './utils.js';
import fetch, { Response } from 'node-fetch';

interface iCloudCookiesRequest {
    dsWebAuthToken: string;
    trustToken: string;
    extended_login: boolean;
    accountCountryCode?: string;
}

export interface AuthenticatedData {
    cookies: CookieJar;
    accountInfo: iCloudAccountInfo;
    /**
     * The `aasp` cookie Apple hands back on a successful sign-in. Feeding it
     * into the next sign-in marks that sign-in as coming from an already
     * trusted client, which is what keeps Apple from treating every
     * reconnect as a brand new web login worth alerting the user about.
     */
    trustToken: string;
    /**
     * The token accountLogin was minted from. Replaying it against
     * accountLogin mints fresh cookies without touching idmsa, which is the
     * difference between recovering silently and setting off a login alert.
     */
    sessionToken: string;
    accountCountry: string;
}

/**
 * Apple sends each cookie exactly once. `aasp` arrives on signin/init and is
 * NOT repeated on signin/complete once we start echoing it back, so session
 * state has to accumulate across the whole handshake instead of being read
 * off a single response.
 */
class AuthSession {
    cookies: Record<string, string> = {};
    scnt: string | null = null;
    sid: string | null = null;
    token: string | null = null;
    accountCountry: string | null = null;
    twosvTrustToken: string | null = null;

    absorb(res: Response): this {
        const raw: string[] = res.headers.raw()['set-cookie'] || [];

        for (const line of raw) {
            const pair = line.split(';')[0] ?? '';
            const i = pair.indexOf('=');
            if (i > 0) {
                this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
            }
        }

        this.scnt = res.headers.get('scnt') || this.scnt;
        this.sid = res.headers.get('X-Apple-ID-Session-Id') || this.sid;
        this.token = res.headers.get('X-Apple-Session-Token') || this.token;
        this.accountCountry =
            res.headers.get('X-Apple-ID-Account-Country') || this.accountCountry;
        this.twosvTrustToken =
            res.headers.get('X-Apple-TwoSV-Trust-Token') || this.twosvTrustToken;

        return this;
    }

    headers(): Record<string, string> {
        const h: Record<string, string> = {};
        if (this.scnt) h['scnt'] = this.scnt;
        if (this.sid) h['X-Apple-ID-Session-Id'] = this.sid;

        const cookie = Object.entries(this.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        if (cookie) h['Cookie'] = cookie;

        return h;
    }
}

export async function AuthenticateFindMy(
    username: string,
    password: string,
    trustToken?: string
): Promise<AuthenticatedData> {
    const authenticator = new GSASRPAuthenticator(username);
    const session = new AuthSession();

    const init = await AuthInit(authenticator, session);
    await AuthComplete(authenticator, password, init, session, trustToken);

    return AuthFinish(session, trustToken);
}

async function AuthInit(
    authenticator: GSASRPAuthenticator,
    session: AuthSession
): Promise<ServerSRPInitResponse> {
    const initData = await authenticator.getInit();

    const res = await fetch(AUTH_ENDPOINT + 'signin/init', {
        headers: AUTH_HEADERS,
        method: 'POST',
        body: JSON.stringify(initData),
        ...fetchOptions,
    });

    session.absorb(res);

    if (!res.ok) {
        throw new Error(`signin/init ${res.status}: ${await res.text()}`);
    }

    return await res.json() as ServerSRPInitResponse;
}

async function AuthComplete(
    authenticator: GSASRPAuthenticator,
    password: string,
    initResponse: ServerSRPInitResponse,
    session: AuthSession,
    trustToken?: string
): Promise<AuthSession> {
    const completeData = await authenticator.getComplete(password, initResponse);

    // Only opt into remember-me when we actually have a token to present.
    // Without one the previous behaviour is kept verbatim, so a first-time
    // sign-in behaves exactly as it did before.
    const remembered = !!trustToken;

    const res = await fetch(AUTH_ENDPOINT + 'signin/complete?isRememberMeEnabled=true', {
        headers: { ...AUTH_HEADERS, ...session.headers() },
        method: 'POST',
        body: JSON.stringify({
            ...completeData,
            trustTokens: remembered ? [trustToken] : [],
            rememberMe: remembered,
            pause2FA: true,
        }),
        ...fetchOptions,
    });

    session.absorb(res);

    // 200 = signed in outright.
    // 409 = 2FA would normally be required, but pause2FA still yields a token.
    if (!res.ok && res.status !== 409) {
        throw new Error(`signin/complete ${res.status}: ${await res.text()}`);
    }

    if (!session.token) {
        throw new Error(
            `signin/complete ${res.status}: no X-Apple-Session-Token ` +
            `(Apple is enforcing 2FA for this account)`
        );
    }

    return session;
}

async function AuthFinish(
    session: AuthSession,
    previousTrustToken?: string
): Promise<AuthenticatedData> {
    const trustToken =
        session.twosvTrustToken ?? session.cookies['aasp'] ?? previousTrustToken ?? '';

    const data: iCloudCookiesRequest = {
        dsWebAuthToken: session.token as string,
        trustToken,
        extended_login: true,
        ...(session.accountCountry
            ? { accountCountryCode: session.accountCountry }
            : {}),
    };

    const response = await fetch(SETUP_ENDPOINT, {
        headers: DEFAULT_HEADERS,
        method: 'POST',
        body: JSON.stringify(data),
        ...fetchOptions,
    });

    if (!response.ok) {
        throw new Error(`accountLogin ${response.status}: ${await response.text()}`);
    }

    session.absorb(response);

    const accountInfo = await response.json() as iCloudAccountInfo;

    const cookies = new CookieJar();
    for (const cookie of extractiCloudCookies(response)) {
        cookies.setCookieSync(cookie, COOKIE_URL);
    }

    return {
        cookies,
        accountInfo,
        trustToken: session.twosvTrustToken ?? trustToken,
        sessionToken: session.token ?? '',
        accountCountry: session.accountCountry ?? '',
    };
}

/**
 * Mint a fresh set of iCloud cookies from the token the current session was
 * built with, the way pyicloud and icloudpy recover from a 450. This never
 * touches idmsa, so it costs no SRP handshake and no Apple login alert.
 *
 * Returns null when Apple refuses the token — then, and only then, is a real
 * sign-in the answer. Transport failures are thrown so the caller can back off
 * instead of mistaking a flaky connection for a dead token.
 */
export async function RenewFindMySession(
    current: AuthenticatedData
): Promise<AuthenticatedData | null> {
    if (!current.sessionToken) return null;

    const data: iCloudCookiesRequest = {
        dsWebAuthToken: current.sessionToken,
        trustToken: current.trustToken ?? '',
        extended_login: true,
        ...(current.accountCountry
            ? { accountCountryCode: current.accountCountry }
            : {}),
    };

    const response = await fetch(SETUP_ENDPOINT, {
        headers: DEFAULT_HEADERS,
        method: 'POST',
        body: JSON.stringify(data),
        ...fetchOptions,
    });

    if (!response.ok) {
        if (RENEWAL_REFUSED.has(response.status)) return null;

        throw new ICloudRequestError(
            SETUP_ENDPOINT,
            response.status,
            await response.text().catch(() => '')
        );
    }

    const accountInfo = await response.json() as iCloudAccountInfo;

    const cookies = new CookieJar();
    for (const cookie of extractiCloudCookies(response)) {
        cookies.setCookieSync(cookie, COOKIE_URL);
    }

    return {
        cookies,
        accountInfo,
        trustToken:
            response.headers.get('X-Apple-TwoSV-Trust-Token') || current.trustToken,
        sessionToken:
            response.headers.get('X-Apple-Session-Token') || current.sessionToken,
        accountCountry:
            response.headers.get('X-Apple-ID-Account-Country') ||
            current.accountCountry,
    };
}

const RENEWAL_REFUSED = new Set([401, 403, 421, 450]);