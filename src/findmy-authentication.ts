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
import { extractiCloudCookies, fetchOptions } from './utils.js';
import fetch, { Response } from 'node-fetch';

interface iCloudCookiesRequest {
    dsWebAuthToken: string;
    trustToken: string;
    extended_login: boolean;
}

export interface AuthenticatedData {
    cookies: CookieJar;
    accountInfo: iCloudAccountInfo;
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
    password: string
): Promise<AuthenticatedData> {
    const authenticator = new GSASRPAuthenticator(username);
    const session = new AuthSession();

    const init = await AuthInit(authenticator, session);
    await AuthComplete(authenticator, password, init, session);

    return AuthFinish(session);
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
    session: AuthSession
): Promise<AuthSession> {
    const completeData = await authenticator.getComplete(password, initResponse);

    const res = await fetch(AUTH_ENDPOINT + 'signin/complete?isRememberMeEnabled=true', {
        headers: { ...AUTH_HEADERS, ...session.headers() },
        method: 'POST',
        body: JSON.stringify({
            ...completeData,
            trustTokens: [],
            rememberMe: false,
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

async function AuthFinish(session: AuthSession): Promise<AuthenticatedData> {
    const data: iCloudCookiesRequest = {
        dsWebAuthToken: session.token as string,
        trustToken: session.cookies['aasp'] ?? '',
        extended_login: true,
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

    const accountInfo = await response.json() as iCloudAccountInfo;

    const cookies = new CookieJar();
    for (const cookie of extractiCloudCookies(response)) {
        cookies.setCookieSync(cookie, COOKIE_URL);
    }

    return { cookies, accountInfo };
}