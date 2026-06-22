export type GoogleLoginConfig = {
  clientId: string;
  clientSecret: string;
};

export type GoogleUserProfile = {
  email: string;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type UserInfoResponse = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  error?: string;
  error_description?: string;
};

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_LOGIN_SCOPE = "openid email profile";

export function hasGoogleLoginCredentials(config: GoogleLoginConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

export function buildGoogleLoginAuthUrl(config: GoogleLoginConfig, redirectUri: string, state: string): string {
  if (!hasGoogleLoginCredentials(config)) {
    throw new Error("請先設定 Google OAuth Client ID / Client Secret，才可啟用 Google 登入。");
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_LOGIN_SCOPE,
    access_type: "online",
    prompt: "select_account",
    state
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleLoginCode(config: GoogleLoginConfig, code: string, redirectUri: string): Promise<string> {
  if (!hasGoogleLoginCredentials(config)) {
    throw new Error("Google OAuth credentials are missing.");
  }
  const token = await postGoogleToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  if (!token.access_token) {
    throw new Error(token.error_description || token.error || "Google did not return an access token.");
  }
  return token.access_token;
}

export async function fetchGoogleUserProfile(accessToken: string): Promise<GoogleUserProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = (await response.json()) as UserInfoResponse;
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google userinfo failed with ${response.status}`);
  }
  if (!payload.email) {
    throw new Error("Google 沒有回傳 email，無法登入。");
  }
  return {
    email: payload.email.trim().toLowerCase(),
    name: payload.name || null,
    picture: payload.picture || null,
    emailVerified: payload.email_verified !== false
  };
}

async function postGoogleToken(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google token endpoint failed with ${response.status}`);
  }
  return payload;
}
