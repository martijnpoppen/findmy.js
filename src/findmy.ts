import { Cookie, CookieJar } from 'tough-cookie';
import {
  AUTH_ENDPOINT,
  AUTH_HEADERS,
  COOKIE_URL,
  DEFAULT_HEADERS,
  SETUP_ENDPOINT,
} from './constants.js';
import {
  GSASRPAuthenticator,
  ServerSRPCompleteRequest,
  ServerSRPInitResponse,
} from './gsasrp-authenticator.js';
import { iCloudAccountInfo } from './types/account.types.js';
import { iCloudFindMyDeviceInfo } from './types/findmy.types.js';

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

type AuthenticatedData = {
  cookies: CookieJar;
  accountInfo: iCloudAccountInfo;
};

type SerializedAuthenticatedData = {
  cookies: CookieJar.Serialized;
  accountInfo: iCloudAccountInfo;
};

export class FindMy {
  private authenticator = new GSASRPAuthenticator(this.username);

  private authenticatedData: AuthenticatedData | null = null;

  constructor(private username: string, private password: string) {}

  async authenticate(): Promise<void> {
    const init = await this.authInit();
    const complete = await this.authComplete(init);
    await this.completeAuthentication(complete);
  }

  isAuthenticated(): boolean {
    return !!this.authenticatedData;
  }

  setAuthData(authData: SerializedAuthenticatedData) {
    this.authenticatedData = {
      cookies: CookieJar.deserializeSync(authData.cookies),
      accountInfo: authData.accountInfo,
    };
  }

  getAuthData(): SerializedAuthenticatedData {
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

    const cookies = this.extractiCloudCookies(response);
    for (let cookie of cookies) {
      this.authenticatedData.cookies.setCookieSync(cookie, COOKIE_URL);
    }

    const reply = await response.json();

    return reply;
  }

  private async authInit(): Promise<ServerSRPInitResponse> {
    const initData = await this.authenticator.getInit();
    const initResponse = await fetch(AUTH_ENDPOINT + 'signin/init', {
      headers: AUTH_HEADERS,
      method: 'POST',
      body: JSON.stringify(initData),
    });

    if (!initResponse.ok) {
      throw new Error('Failed to authenticate');
    }

    return await initResponse.json();
  }

  private async authComplete(
    initData: ServerSRPInitResponse,
  ): Promise<AuthData> {
    const completeData = await this.authenticator.getComplete(
      this.password,
      initData,
    );

    const authData: ServerSRPCompleteRequest = {
      ...completeData,
      trustTokens: [],
      rememberMe: false,
      pause2FA: true,
    };

    const completeResponse = await fetch(
      AUTH_ENDPOINT + 'signin/complete?isRememberMeEnabled=true',
      {
        headers: AUTH_HEADERS,
        method: 'POST',
        body: JSON.stringify(authData),
      },
    );

    // Both 200 and 409 are valid responses
    if (!completeResponse.ok && completeResponse.status !== 409) {
      throw new Error('Failed to authenticate');
    }

    return this.extractAuthData(completeResponse);
  }

  private extractAuthData(response: Response): AuthData {
    try {
      const sessionId = response.headers.get('X-Apple-Session-Token');
      const sessionToken = sessionId;
      const scnt = response.headers.get('scnt');

      const headers = Array.from(response.headers.values());
      const aaspCookie = headers.find((v) => v.includes('aasp='));
      const aasp = aaspCookie?.split('aasp=')[1]?.split(';')[0];

      if (!sessionId || !sessionToken || !scnt || !aasp) {
        throw new Error('Failed to extract auth data');
      }

      return { sessionId, sessionToken, scnt, aasp } as AuthData;
    } catch (e) {
      throw new Error('Failed to extract auth data');
    }
  }

  private async completeAuthentication(
    authData: AuthData,
  ): Promise<void> {
    const data: iCloudCookiesRequest = {
      dsWebAuthToken: authData.sessionId,
      trustToken: authData.aasp,
    };

    const response = await fetch(SETUP_ENDPOINT, {
      headers: DEFAULT_HEADERS,
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error('Failed to finish iCloud authentication');
    }

    const accountInfo: iCloudAccountInfo = await response.json();
    const cookies = new CookieJar();
    for (let cookie of this.extractiCloudCookies(response)) {
      cookies.setCookieSync(cookie, COOKIE_URL);
    }

    const authenticatedData: AuthenticatedData = {
      cookies,
      accountInfo,
    };
    this.authenticatedData = authenticatedData;
  }

  private extractiCloudCookies(response: Response): Cookie[] {
    const cookies = Array.from(response.headers.entries())
      .filter((v) => v[0].toLowerCase() == 'set-cookie')
      .map((v) => v[1].split(', '))
      .reduce((a, b) => a.concat(b), [])
      .map((v) => Cookie.parse(v))
      .filter((v) => !!v);

    if (cookies.length === 0) {
      throw new Error('Failed to extract iCloud cookies');
    }

    return cookies;
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
