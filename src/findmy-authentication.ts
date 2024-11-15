import { CookieJar } from 'tough-cookie';
import fetch from 'cross-fetch';
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
import { extractiCloudCookies } from './utils.js';

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

export async function AuthenticateFindMy(
  username: string,
  password: string
): Promise<AuthenticatedData> {
  const gsasrpAuthenticator = new GSASRPAuthenticator(username);

  const init = await AuthInit(gsasrpAuthenticator);
  const complete = await AuthComplete(gsasrpAuthenticator, password, init);
  const result = await AuthFinish(complete);
  return result;
}

async function AuthInit(
  authenticator: GSASRPAuthenticator
): Promise<ServerSRPInitResponse> {
  const initData = await authenticator.getInit();
  const initResponse = await fetch(AUTH_ENDPOINT + 'signin/init', {
    headers: AUTH_HEADERS,
    method: 'POST',
    body: JSON.stringify(initData),
  });

  if (!initResponse.ok) {
    console.log('authInit failed', initResponse);
    throw new Error('Failed to authenticate');
  }

  return await initResponse.json();
}

async function AuthComplete(
  authenticator: GSASRPAuthenticator,
  password: string,
  initResponse: ServerSRPInitResponse
): Promise<AuthData> {
  const completeData = await authenticator.getComplete(password, initResponse);

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
    }
  );

  // Both 200 and 409 are valid responses
  if (!completeResponse.ok && completeResponse.status !== 409) {
    console.log('authComplete failed', completeResponse);
    throw new Error('Failed to authenticate');
  }

  return extractAuthData(completeResponse);
}

function extractAuthData(response: Response): AuthData {
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

async function AuthFinish(authData: AuthData): Promise<AuthenticatedData> {
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
  for (let cookie of extractiCloudCookies(response)) {
    cookies.setCookieSync(cookie, COOKIE_URL);
  }

  return {
    cookies,
    accountInfo,
  };
}
