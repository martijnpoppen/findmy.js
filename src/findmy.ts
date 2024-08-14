import { Cookie } from 'tough-cookie';
import {
  AUTH_ENDPOINT,
  AUTH_HEADERS,
  DEFAULT_HEADERS,
  SETUP_ENDPOINT,
} from './constants.js';
import {
  GSASRPAuthenticator,
  ServerSRPCompleteRequest,
  ServerSRPInitResponse,
} from './gsasrp-authenticator.js';
import { iCloudAccountInfo } from './types/account.types.js';
import {
  iCloudFindMyDeviceInfo,
  iCloudFindMyResponse,
} from './types/findmy.types.js';

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

export class FindMy {
  private authenticator = new GSASRPAuthenticator(this.username);

  private authenticatedData: {
    headers: Record<string, string>;
    webServices: iCloudAccountInfo['webservices'];
  } | null = null;

  constructor(private username: string, private password: string) { }

  public async authenticate() {
    const init = await this.authInit();
    const complete = await this.authComplete(init);
    return await this.completeAuthentication(complete);
  }

  isAuthenticated() {
    return !!this.authenticatedData;
  }

  public setAuthData(authData: any) {
    this.authenticatedData = authData;
  }

  async getDevices(): Promise<Array<iCloudFindMyDeviceInfo>> {
    if (!this.authenticatedData) {
      throw new Error('Unauthenticated');
    }

    const serviceURI =
      this.authenticatedData.webServices.findme.url;
    const endpoint = serviceURI + '/fmipservice/client/web/refreshClient';

    const request = {
      clientContext: {
        fmly: true,
        shouldLocate: true,
        deviceListVersion: 1,
        selectedDevice: 'all',
      },
    };

    const response = await fetch(endpoint, {
      headers: this.authenticatedData.headers,
      method: 'POST',
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error('Failed to get devices');
    }

    const reply: iCloudFindMyResponse = await response.json();

    return reply.content;
  }

  public async playSound(deviceId: string) {
    if (!this.authenticatedData) {
      throw new Error('Unauthenticated');
    }

    const serviceURI =
      this.authenticatedData.webServices.findme.url;
    const endpoint = serviceURI + '/fmipservice/client/web/playSound';

    const request = {
      device: deviceId,
      subject: 'Find My iPhone Alert',
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
    };

    const response = await fetch(endpoint, {
      headers: this.authenticatedData.headers,
      method: 'POST',
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error('Failed to play sound');
    }
  }

  public async sendMessage(deviceId: string, subject: string, text: string) {
    if (!this.authenticatedData) {
      throw new Error('Unauthenticated');
    }

    const serviceURI =
      this.authenticatedData.webServices.findme.url;
    const endpoint = serviceURI + '/fmipservice/client/web/sendMessage';

    const request = {
      device: deviceId,
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
      vibrate: true,
      userText: true,
      sound: false,
      subject,
      text
    };

    const response = await fetch(endpoint, {
      headers: this.authenticatedData.headers,
      method: 'POST',
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error('Failed to send message');
    }
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

  private async completeAuthentication(authData: AuthData) {
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
      throw new Error('Failed to get iCloud cookies');
    }

    const accountInfo: iCloudAccountInfo = await response.json();
    const cookies = this.extractiCloudCookies(response);

    this.authenticatedData = { headers: this.getHeaders(cookies), webServices: accountInfo.webservices };

    return this.authenticatedData;
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

  private getHeaders(cookies: Cookie[]): Record<string, string> {
    return {
      ...DEFAULT_HEADERS,
      Cookie: cookies
        .filter((a) => a.value)
        .map((cookie) => cookie.cookieString())
        .join('; '),
    };
  }
}
