import { CookieJar } from 'tough-cookie';
import { COOKIE_URL, DEFAULT_HEADERS } from './constants.js';
import { FindMyDevice } from './device.js';
import {
  AuthenticatedData,
  AuthenticateFindMy,
} from './findmy-authentication.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { iCloudFindMyResponse } from './types/findmy.types.js';
import { extractiCloudCookies } from './utils.js';

export class FindMy {
  private authenticatedData: AuthenticatedData | null = null;

  async authenticate(username: string, password: string): Promise<void> {
    this.authenticatedData = await AuthenticateFindMy(username, password);
  }

  deauthenticate() {
    this.authenticatedData = null;
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
    if (!this.authenticatedData) {
      throw new Error('Unauthenticated');
    }

    const serviceURI =
      this.authenticatedData.accountInfo.webservices[service].url;
    const fullEndpoint = serviceURI + endpoint;
    const headers = this.getHeaders(this.authenticatedData.cookies);

    const response = await fetch(fullEndpoint, {
      headers: headers,
      method: 'POST',
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error('Failed to send request');
    }

    const cookies = extractiCloudCookies(response);
    for (let cookie of cookies) {
      this.authenticatedData.cookies.setCookieSync(cookie, COOKIE_URL);
    }

    const reply = await response.json();

    return reply;
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
      throw new Error('Unauthenticated');
    }
    return this.authenticatedData;
  }
}
