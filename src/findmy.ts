import { CookieJar } from 'tough-cookie';
import {
  COOKIE_URL,
  DEFAULT_HEADERS
} from './constants.js';
import { AuthenticatedData, AuthenticateFindMy } from './findmy-authentication.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { iCloudFindMyDeviceInfo } from './types/findmy.types.js';
import { extractiCloudCookies } from './utils.js';

type SerializedAuthenticatedData = {
  cookies: CookieJar.Serialized;
  accountInfo: iCloudAccountInfo;
};

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

  importAuthData(authData: SerializedAuthenticatedData) {
    this.authenticatedData = {
      cookies: CookieJar.deserializeSync(authData.cookies),
      accountInfo: authData.accountInfo,
    };
  }

  exportAuthData(): SerializedAuthenticatedData {
    if (!this.authenticatedData) {
      throw new Error('Unauthenticated');
    }
    return {
      cookies: this.authenticatedData.cookies.serializeSync(),
      accountInfo: this.authenticatedData.accountInfo,
    };
  }

  async getDevices(): Promise<Array<iCloudFindMyDeviceInfo>> {
    const result = await this.sendRequest(
      'findme',
      '/fmipservice/client/web/refreshClient',
      {
        clientContext: {
          fmly: true,
          shouldLocate: true,
          deviceListVersion: 1,
          selectedDevice: 'all',
        },
      },
    );
    if (!result || !result.content) {
      throw new Error('Failed to get devices');
    }
    return result.content as Array<iCloudFindMyDeviceInfo>;
  }

  async playSound(deviceId: string) {
    await this.sendRequest('findme', '/fmipservice/client/web/playSound', {
      device: deviceId,
      subject: 'Find My iPhone Alert',
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
    });
  }

  async sendMessage(deviceId: string, subject: string, text: string) {
    await this.sendRequest('findme', '/fmipservice/client/web/sendMessage', {
      device: deviceId,
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
      vibrate: true,
      userText: true,
      sound: false,
      subject,
      text,
    });
  }

  private async sendRequest(
    service: keyof iCloudAccountInfo['webservices'],
    endpoint: string,
    request: Record<string, unknown>,
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
}
