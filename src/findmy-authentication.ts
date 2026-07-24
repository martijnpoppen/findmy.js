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
    ServerSRPCompleteRequest,
    ServerSRPInitResponse,
} from './gsasrp-authenticator.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { extractiCloudCookies, fetchOptions } from './utils.js';
import fetch, { HeadersInit, Response } from 'node-fetch';

interface AuthData {
    sessionId: string;
    sessionToken: string;
    scnt: string;
    aasp: string;
}

interface iCloudCookiesRequest {
    dsWebAuthToken: string;
    trustToken: string;
}

export interface AuthenticatedData {
    cookies: CookieJar;
    accountInfo: iCloudAccountInfo;
}

export function collectSetCookie(res: { headers: { raw: () => { (): any; new(): any;[x: string]: any; }; getSetCookie: () => any; }; }): string {
    const raw = res.headers.raw ? res.headers.raw()['set-cookie']
        : res.headers.getSetCookie ? res.headers.getSetCookie()
            : [];
    return (raw || []).map((c: string) => c.split(';')[0]).join('; ');
}

export function sessionHeaders(res: any): Record<string, string> {
    const h: Record<string, string> = {};
    const scnt = res.headers.get('scnt');
    const sid = res.headers.get('X-Apple-ID-Session-Id');
    const cookie = collectSetCookie(res);
    if (scnt) h['scnt'] = scnt;
    if (sid) h['X-Apple-ID-Session-Id'] = sid;
    if (cookie) h['Cookie'] = cookie;
    return h;
}

export async function AuthenticateFindMy(username: string, password: string) {
    const auth = new GSASRPAuthenticator(username);
    const { init, session } = await AuthInit(auth);
    const complete = await AuthComplete(auth, password, init as ServerSRPInitResponse, session);
    return AuthFinish(complete);
}

async function AuthInit(authenticator: GSASRPAuthenticator) {
    const initData = await authenticator.getInit();
    const res = await fetch(AUTH_ENDPOINT + 'signin/init', {
        headers: AUTH_HEADERS,
        method: 'POST',
        body: JSON.stringify(initData),
        ...fetchOptions,
    });
    if (!res.ok) {
        throw new Error(`signin/init ${res.status}: ${await res.text()}`);
    }
    return { init: await res.json(), session: sessionHeaders(res) };
}

async function AuthComplete(authenticator: GSASRPAuthenticator, password: string, initResponse: ServerSRPInitResponse, session: HeadersInit) {
    const completeData = await authenticator.getComplete(password, initResponse);
    const res = await fetch(AUTH_ENDPOINT + 'signin/complete?isRememberMeEnabled=true', {
        headers: { ...AUTH_HEADERS, ...session },
        method: 'POST',
        body: JSON.stringify({ ...completeData, trustTokens: [], rememberMe: true, pause2FA: true, }),
        ...fetchOptions,
    });

    // Both 200 and 409 are valid responses
    if (!res.ok && res.status !== 409) {
        throw new Error('Failed to authenticate');
    }
    return extractAuthData(res);
}

function extractAuthData(response: Response) {
    const sessionId = response.headers.get('X-Apple-Session-Token');
    const scnt = response.headers.get('scnt');
    const cookies = response.headers.raw()['set-cookie'] || [];
    const aasp = cookies.find(c => c.startsWith('aasp='))?.split('aasp=')[1]?.split(';')[0];
console.log('Extracted auth data:', { sessionId, scnt, aasp, status: response.status });
    if (response.status === 409 && !response.headers.get('X-Apple-Session-Token')) throw new Error('2FA_REQUIRED');
    if (response.status === 412) throw new Error('ACCOUNT_REPAIR_REQUIRED');
    if (!sessionId || !scnt || !aasp) {
        throw new Error(`missing auth data (status ${response.status}) ` +
            `token=${!!sessionId} scnt=${!!scnt} aasp=${!!aasp}`);
    }
    return { sessionId, sessionToken: sessionId, scnt, aasp };
}

async function AuthFinish(authData: AuthData): Promise<AuthenticatedData> {
    const data: iCloudCookiesRequest = {
        dsWebAuthToken: authData.sessionId,
        trustToken: authData.aasp,
    };

    const response = await fetch(SETUP_ENDPOINT, {
        headers: DEFAULT_HEADERS,
        method: 'POST',
        body: JSON.stringify(data),
        ...fetchOptions
    });

    if (!response.ok || !response) {
        throw new Error('Failed to finish iCloud authentication');
    }

    // @ts-ignore
    const accountInfo: iCloudAccountInfo = await response.json();
    const cookies = new CookieJar();
    for (let cookie of extractiCloudCookies(response)) {
        cookies.setCookieSync(cookie, COOKIE_URL);
    }

    return {
        cookies,
        accountInfo,
    };
}
