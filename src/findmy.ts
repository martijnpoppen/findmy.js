import { CookieJar } from 'tough-cookie';
import { COOKIE_URL, DEFAULT_HEADERS, VALIDATE_ENDPOINT } from './constants.js';
import { FindMyDevice } from './device.js';
import {
    AuthenticatedData,
    AuthenticateFindMy,
} from './findmy-authentication.js';
import {
    ICloudRequestError,
    SessionExpiredError,
    UnauthenticatedError,
} from './errors.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { iCloudFindMyResponse } from './types/findmy.types.js';
import { extractiCloudCookies, fetchOptions } from './utils.js';
import fetch from 'node-fetch';

export const SESSION_FORMAT_VERSION = 1;

type SerializedCookieJar = ReturnType<CookieJar['toJSON']>;

/**
 * A session in a shape that survives a restart. Every sign-in creates a new
 * iCloud web session and Apple alerts the account holder about it, so the
 * session has to outlive the process that made it.
 */
export interface SerializedSession {
    version: number;
    cookies: SerializedCookieJar;
    accountInfo: iCloudAccountInfo;
    trustToken: string;
    createdAt: number;
}

export class FindMy {
    private authenticatedData: AuthenticatedData | null = null;
    private sessionCreatedAt: number | null = null;

    async authenticate(
        username: string,
        password: string,
        trustToken?: string
    ): Promise<void> {
        this.authenticatedData = await AuthenticateFindMy(
            username,
            password,
            trustToken
        );
        this.sessionCreatedAt = Date.now();
    }

    deauthenticate() {
        this.authenticatedData = null;
        this.sessionCreatedAt = null;
    }

    /**
     * Dump the live session so the caller can store it and hand it back after
     * a restart instead of signing in again.
     */
    exportSession(): SerializedSession | null {
        if (!this.authenticatedData) return null;

        return {
            version: SESSION_FORMAT_VERSION,
            cookies: this.authenticatedData.cookies.toJSON(),
            accountInfo: this.authenticatedData.accountInfo,
            trustToken: this.authenticatedData.trustToken,
            createdAt: this.sessionCreatedAt ?? Date.now(),
        };
    }

    /**
     * Restore a previously exported session. This does not talk to Apple —
     * call `validateSession()` afterwards to confirm iCloud still accepts it.
     */
    importSession(session: SerializedSession): void {
        if (!session || session.version !== SESSION_FORMAT_VERSION) {
            throw new SessionExpiredError('Unsupported stored session format');
        }
        if (!session.cookies || !session.accountInfo?.webservices) {
            throw new SessionExpiredError('Stored session is incomplete');
        }

        this.authenticatedData = {
            cookies: CookieJar.fromJSON(session.cookies as any),
            accountInfo: session.accountInfo,
            trustToken: session.trustToken ?? '',
        };
        this.sessionCreatedAt = session.createdAt ?? Date.now();
    }

    /**
     * Cheap round trip that tells us whether the restored cookies are still
     * good, the same way pyicloud validates a stored token before falling
     * back to a credential sign-in. Returns false on 401/421/450; anything
     * else (a DNS failure, a 503) is rethrown so callers can back off rather
     * than mistake it for an expired session.
     */
    async validateSession(): Promise<boolean> {
        if (!this.authenticatedData) return false;

        try {
            const accountInfo = (await this.sendRequest(
                VALIDATE_ENDPOINT,
                null
            )) as iCloudAccountInfo;

            if (accountInfo?.webservices) {
                this.authenticatedData.accountInfo = accountInfo;
            }

            return true;
        } catch (error) {
            if (error instanceof ICloudRequestError && error.isAuthError) {
                return false;
            }
            throw error;
        }
    }

    /** Age of the current session in milliseconds, or null when there is none. */
    getSessionAge(): number | null {
        return this.sessionCreatedAt === null
            ? null
            : Date.now() - this.sessionCreatedAt;
    }

    getTrustToken(): string | null {
        return this.authenticatedData?.trustToken || null;
    }

    termsUpdateNeeded() {
        if (!this.authenticatedData) return false;
        return !!this.authenticatedData.accountInfo?.termsUpdateNeeded;
    }

    isAuthenticated(): boolean {
        return !!this.authenticatedData;
    }

    getRawAccountInfo() {
        return this.authOrThrow.accountInfo;
    }

    getUserInfo() {
        const data = this.authOrThrow.accountInfo;
        return {
            appleId: {
                main: data.dsInfo.appleId,
                alias: data.dsInfo.appleIdAliases,
            },
            email: data.dsInfo.primaryEmail,
            localization: {
                language: data.dsInfo.languageCode,
                locale: data.dsInfo.locale,
                country: data.dsInfo.countryCode,
            },
            name: {
                full: data.dsInfo.fullName,
                first: data.dsInfo.firstName,
                last: data.dsInfo.lastName,
            },
        };
    }

    async getDevices(shouldLocate = true): Promise<Array<FindMyDevice>> {
        const result = (await this.sendICloudRequest(
            'findme',
            '/fmipservice/client/web/refreshClient',
            {
                clientContext: {
                    fmly: true,
                    shouldLocate,
                    deviceListVersion: 1,
                    selectedDevice: 'all',
                },
            }
        )) as iCloudFindMyResponse;
        if (!result || !result.content) {
            throw new Error('Failed to get devices');
        }
        return result.content.map((device) => new FindMyDevice(this, device));
    }

    async sendICloudRequest(
        service: keyof iCloudAccountInfo['webservices'],
        endpoint: string,
        request: Record<string, unknown>
    ): Promise<any> {
        const serviceURI = this.authOrThrow.accountInfo.webservices[service].url;
        return this.sendRequest(serviceURI + endpoint, request);
    }

    private async sendRequest(
        fullEndpoint: string,
        request: Record<string, unknown> | null
    ): Promise<any> {
        const authenticatedData = this.authOrThrow;
        const headers = this.getHeaders(authenticatedData.cookies);

        const response = await fetch(fullEndpoint, {
            headers: headers,
            method: 'POST',
            body: request === null ? 'null' : JSON.stringify(request),
            ...fetchOptions,
        });

        if (!response.ok) {
            // Carry the status through. Without it callers cannot tell an
            // expired session (re-authenticate) from a server wobble (retry),
            // and re-authenticating on a wobble is what spams the account
            // holder with Apple login alerts.
            throw new ICloudRequestError(
                fullEndpoint,
                response.status,
                await response.text().catch(() => '')
            );
        }

        // /validate answers without cookies when nothing changed.
        try {
            for (const cookie of extractiCloudCookies(response)) {
                authenticatedData.cookies.setCookieSync(cookie, COOKIE_URL);
            }
        } catch {
            // No Set-Cookie on this response; the jar stays as it is.
        }

        return await response.json();
    }

    private getHeaders(jar: CookieJar): Record<string, string> {
        const cookies = jar.getCookiesSync(COOKIE_URL);
        return {
            ...DEFAULT_HEADERS,
            Cookie: cookies
                .filter((a) => a.value)
                .map((cookie) => cookie.cookieString())
                .join('; '),
        };
    }

    private get authOrThrow(): AuthenticatedData {
        if (!this.authenticatedData) {
            throw new UnauthenticatedError();
        }
        return this.authenticatedData;
    }
}
