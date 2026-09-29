/**
 * Auth Service for SmoothyEdit Electron App
 * Handles optional Studio authentication + local/cloud feature gating.
 * All local features are free forever (MIT, no account).
 * Only cloud AI features (Best Shorts, export-audio) require Studio Pro.
 */

import Store from 'electron-store';

const isDev = process.env.NODE_ENV === 'development';
const API_BASE = isDev ? 'http://localhost:3000' : 'https://smoothyedit.com';

interface User {
  id: string;
  email: string;
  name: string | null;
  tier: 'free' | 'pro' | 'anonymous';
  isAdmin: boolean;
}

interface AuthState {
  user: User | null;
  jwt: string | null;
  isLoggedIn: boolean;
}

interface LoginResult {
  success: boolean;
  requires2FA?: boolean;
  error?: string;
  user?: User;
}

interface TrialStatus {
  isInTrial: boolean;
  daysRemaining: number;
  hasExpired: boolean;
  startDate: number | null;
}

interface FeatureAccess {
  allowed: boolean;
  reason?: 'login-required' | 'pro-required';
}

// Feature definitions — new vision: all local free forever, cloud AI gated.
// Local (free, no account): autocut/multicam, silence-removal, captions, compressor, sequence-info
// Cloud (Studio Pro): bestshorts, export-audio
const CLOUD_AI_FEATURES = ['bestshorts', 'export-audio'];
const LOCAL_FREE_FEATURES = ['autocut', 'silence-removal', 'sequence-info', 'captions', 'compressor'];

// Store instance
const store = new Store();

// Callbacks for notifying renderer of auth changes
let authChangeCallback: ((state: AuthState) => void) | null = null;

export function setAuthChangeCallback(callback: (state: AuthState) => void): void {
  authChangeCallback = callback;
}

function notifyAuthChange(): void {
  if (authChangeCallback) {
    authChangeCallback(getAuthState());
  }
}

/**
 * Initialize trial tracking on first app launch
 * @deprecated Trials removed — all local features are free forever. Kept as no-op for compat.
 */
export function initializeTrial(): void {
  // No-op: previously set trialStartDate. Local tools no longer gated.
}

/**
 * Get current authentication state
 */
export function getAuthState(): AuthState {
  const user = store.get('user') as User | null;
  const jwt = store.get('jwt') as string | null;

  return {
    user: user || null,
    jwt: jwt || null,
    isLoggedIn: !!user && !!jwt
  };
}

/**
 * Login with email and password
 * Uses the existing /api/auth/login endpoint
 */
export async function login(
  email: string,
  password: string,
  totpCode?: string
): Promise<LoginResult> {
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password, totpCode })
    });

    const data = await response.json();

    if (!response.ok) {
      if (data.requires2FA) {
        return { success: false, requires2FA: true };
      }
      return { success: false, error: data.error || 'Login failed' };
    }

    // The existing endpoint returns { user: {...} }
    const user = data.user;
    if (!user) {
      return { success: false, error: 'Invalid response from server' };
    }

    // Store user data. The signed `sessionToken` is the verified credential for
    // API calls (sent as a Bearer header); `jwt` is kept for older code paths.
    store.set('user', user);
    if (data.sessionToken) {
      store.set('sessionToken', data.sessionToken);
    }
    store.set('jwt', user.id);

    console.log('[Auth] Login successful:', user.email);
    notifyAuthChange();

    return { success: true, user };
  } catch (error) {
    console.error('[Auth] Login error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Logout the current user
 */
export function logout(): void {
  store.delete('user');
  store.delete('jwt');
  store.delete('sessionToken');
  console.log('[Auth] Logged out');
  notifyAuthChange();
}

/**
 * Refresh user data from the API
 */
export async function refreshUserData(): Promise<boolean> {
  const jwt = store.get('jwt') as string | null;
  const user = store.get('user') as User | null;

  if (!jwt || !user) {
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) {
      // Token expired or invalid
      if (response.status === 401) {
        logout();
        return false;
      }
      return false;
    }

    const data = await response.json();

    // Update stored user data
    store.set('user', {
      id: data.user.id,
      email: data.user.email,
      name: data.user.name,
      tier: data.user.tier,
      isAdmin: data.user.isAdmin
    });

    console.log('[Auth] User data refreshed');
    notifyAuthChange();
    return true;
  } catch (error) {
    console.error('[Auth] Refresh error:', error);
    return false;
  }
}

/**
 * Check if trial period has expired
 * @deprecated Trials removed. Always returns false.
 */
export function isTrialExpired(): boolean {
  return false;
}

/**
 * Get remaining trial days
 * @deprecated Trials removed. Returns 0.
 */
export function getTrialDaysRemaining(): number {
  return 0;
}

/**
 * Get trial status
 * @deprecated Trials removed. Returns free-forever status for compat.
 */
export function getTrialStatus(): TrialStatus {
  return {
    isInTrial: false,
    daysRemaining: 0,
    hasExpired: false,
    startDate: null
  };
}

/**
 * Check if a feature can be used — new vision:
 * local tools always allowed, cloud AI requires Studio Pro.
 */
export function canUseFeature(feature: string): FeatureAccess {
  const { user } = getAuthState();

  // Pro users always have full access
  if (user?.tier === 'pro') {
    return { allowed: true };
  }

  // Local features free forever, no account needed
  if (LOCAL_FREE_FEATURES.includes(feature)) {
    return { allowed: true };
  }

  // Cloud AI features require a Studio account. Free accounts can use them with
  // their monthly credits (100) — only anonymous users are blocked. Pro lifts
  // the credit cap. Credits are only ever spent on cloud calls.
  if (CLOUD_AI_FEATURES.includes(feature)) {
    if (!user) {
      return { allowed: false, reason: 'login-required' };
    }
    return { allowed: true };
  }

  // Unknown feature - allow by default (local-first)
  return { allowed: true };
}

/**
 * Get stored JWT for API calls
 */
export function getStoredJWT(): string | null {
  return store.get('jwt') as string | null;
}

/**
 * The signed session token returned by `/api/auth/login`. Preferred over the
 * legacy `jwt` (which is just the user id) for authenticating API calls.
 */
export function getSessionToken(): string | null {
  return store.get('sessionToken') as string | null;
}

/**
 * Headers for authenticated requests to the Smoothy web API. Sends the verified
 * Bearer token when available, and always includes `x-member-id` so legacy
 * server paths (rate limiting) keep identifying the user.
 */
export function getAuthHeaders(): Record<string, string> {
  const userId = getStoredUserId();
  const sessionToken = getSessionToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userId) headers['x-member-id'] = userId;
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  else if (userId) headers['Authorization'] = `Bearer ${userId}`;
  return headers;
}

/**
 * Get stored user ID
 */
export function getStoredUserId(): string | null {
  const user = store.get('user') as User | null;
  return user?.id || null;
}

/**
 * Generate connection token after login
 * This allows the app to connect to the Railway WebSocket server
 */
export async function generateConnectionToken(): Promise<string | null> {
  const jwt = getStoredJWT();
  const userId = getStoredUserId();

  if (!jwt || !userId) {
    console.error('[Auth] Cannot generate token: not logged in');
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/api/connection/token`, {
      method: 'POST',
      headers: getAuthHeaders()
    });

    if (!response.ok) {
      console.error('[Auth] Failed to generate connection token');
      return null;
    }

    const data = await response.json();
    return data.token;
  } catch (error) {
    console.error('[Auth] Connection token error:', error);
    return null;
  }
}
