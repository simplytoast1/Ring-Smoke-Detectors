/**
 * Ring REST Client: Lean OAuth + Authenticated Request Client
 *
 * This is our own implementation of the Ring REST client, replacing the
 * ring-client-api dependency. We only need OAuth authentication, session
 * management, and authenticated HTTP requests, not cameras, streaming,
 * push notifications, or any of the other heavy features that come with
 * the full ring-client-api package.
 *
 * By implementing this ourselves, we avoid installing ~10 transitive
 * dependencies (systeminformation, werift, @eneris/push-receiver,
 * @homebridge/camera-utils, etc.) that are completely irrelevant to
 * a smoke detector plugin.
 *
 * The auth protocol is straightforward:
 * 1. Exchange refresh token (or email+password) for an OAuth access token
 *    via https://oauth.ring.com/oauth/token
 * 2. Create a session via POST to clients_api/session
 * 3. Use the access token as a Bearer token on all subsequent requests
 * 4. When the token expires (~1hr), refresh it automatically
 *
 * The refresh token is a base64-encoded JSON: { rt: "actual_token", hid: "hardware_id" }
 */

import { ReplaySubject } from 'rxjs'
import { logInfo, logError, logDebug, delay } from '../util.js'

// ─── URL Helpers ─────────────────────────────────────────────────────────────
// Same base URLs as ring-client-api. These are Ring's production API endpoints.

const clientApiBaseUrl = 'https://api.ring.com/clients_api/'
const deviceApiBaseUrl = 'https://api.ring.com/devices/v1/'
const appApiBaseUrl = 'https://prd-api-us.prd.rings.solutions/api/v1/'

export function clientApi(path: string): string {
  return clientApiBaseUrl + path
}

export function deviceApi(path: string): string {
  return deviceApiBaseUrl + path
}

export function appApi(path: string): string {
  return appApiBaseUrl + path
}

// ─── Error Types ─────────────────────────────────────────────────────────────
//
// Callers need to tell "Ring definitively rejected our credentials" (only a
// fresh login fixes it) apart from "Ring is having a moment" (retrying with
// the same token will work). Matching on error message text is fragile, so
// the distinction is carried by the error class.

/** Generic Ring API failure (network trouble, server errors). Retryable. */
export class RingApiError extends Error {}

/** Ring definitively rejected the credentials or refresh token. */
export class RingAuthError extends RingApiError {}

/** Ring wants a 2FA verification code before it will issue a token. */
export class Ring2FARequired extends RingAuthError {}

// ─── Types ───────────────────────────────────────────────────────────────────

interface AuthConfig {
  /** The actual OAuth refresh token */
  rt: string
  /** Hardware ID used for device identification with Ring's servers */
  hid?: string
}

interface OAuthResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

export interface RingAuthOptions {
  refreshToken: string
  controlCenterDisplayName?: string
}

export interface RingCredentialOptions {
  email: string
  password: string
  controlCenterDisplayName?: string
}

type AuthOptions = RingAuthOptions | RingCredentialOptions

// ─── Helper Functions ────────────────────────────────────────────────────────

function fromBase64(input: string): string {
  return Buffer.from(input, 'base64').toString('ascii')
}

function toBase64(input: string): string {
  return Buffer.from(input).toString('base64')
}

function stringify(data: unknown): string {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && Buffer.isBuffer(data)) return data.toString()
  return JSON.stringify(data) + ''
}

/**
 * Parse a refresh token into its components.
 * Ring's refresh tokens are base64-encoded JSON containing the actual
 * token and a hardware ID. Older/raw tokens are just the token string.
 */
function parseAuthConfig(rawRefreshToken?: string): AuthConfig | undefined {
  if (!rawRefreshToken) return undefined
  try {
    const config = JSON.parse(fromBase64(rawRefreshToken))
    if (config?.rt) return config as AuthConfig
    return { rt: rawRefreshToken }
  } catch {
    return { rt: rawRefreshToken }
  }
}

/**
 * Generate a hardware ID. Ring uses this to identify the "device" making
 * API requests. We use crypto.randomUUID(); no need for the systeminformation
 * package that ring-client-api uses.
 */
function generateHardwareId(): string {
  return crypto.randomUUID()
}

// ─── HTTP Request with Retry ─────────────────────────────────────────────────

interface RequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  json?: Record<string, unknown>
  body?: string
  timeout?: number
  allowNoResponse?: boolean
}

/** Max retry attempts for network-level failures (no HTTP response at all) */
const MAX_NETWORK_RETRIES = 5

/**
 * Longest rate-limit wait we honor, in seconds. Ring can return very large
 * retry-after values; sleeping that long would stall discovery, so cap it and
 * let the caller's own retry loop handle a longer outage.
 */
const MAX_RATE_LIMIT_WAIT_S = 60

/**
 * Make an HTTP request with automatic retry on network failures.
 * On non-response errors (network timeouts, DNS failures, etc.),
 * retries up to MAX_NETWORK_RETRIES times with a 5-second delay,
 * then throws. A bounded retry keeps callers (websocket connect,
 * discovery) from hanging forever during a total outage; their own
 * backoff loops handle longer outages.
 */
async function requestWithRetry<T>(
  options: RequestOptions,
  retryCount = 0,
): Promise<T> {
  try {
    const headers: Record<string, string> = { ...options.headers }

    // Set up JSON content type and serialize body
    if (options.json || !options.body) {
      headers['Content-Type'] = 'application/json'
      headers['Accept'] = 'application/json'
    }

    const fetchOptions: RequestInit & { signal?: AbortSignal } = {
      method: options.method || 'GET',
      headers,
      body: options.json ? JSON.stringify(options.json) : options.body,
    }

    // Apply timeout via AbortSignal
    const timeout = options.timeout || 20000
    fetchOptions.signal = AbortSignal.timeout(timeout)

    const response = await fetch(options.url, fetchOptions)

    if (!response.ok) {
      const error: any = new Error()
      error.response = {
        headers: response.headers,
        status: response.status,
        body: null,
      }
      try {
        const bodyText = await response.text()
        try {
          error.response.body = JSON.parse(bodyText)
        } catch {
          error.response.body = bodyText
        }
      } catch {
        // ignore
      }
      throw error
    }

    // Parse response as JSON
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  } catch (e: any) {
    if (!e.response && !options.allowNoResponse) {
      if (retryCount >= MAX_NETWORK_RETRIES) {
        logError(
          `Failed to reach Ring server at ${options.url} after ${retryCount + 1} attempts. ${e.message}`,
        )
        throw e
      }
      if (retryCount > 0) {
        logError(
          `Retry #${retryCount} failed to reach Ring server at ${options.url}. ${e.message}. Trying again in 5 seconds...`,
        )
      }
      await delay(5000)
      return requestWithRetry<T>(options, retryCount + 1)
    }
    throw e
  }
}

// ─── Ring REST Client ────────────────────────────────────────────────────────

const API_VERSION = 11

export class RingRestClient {
  refreshToken: string | undefined
  private authConfig: AuthConfig | undefined
  private hardwareId: string
  private _authPromise: Promise<OAuthResponse> | undefined
  private sessionPromise: Promise<unknown> | undefined
  private timeouts: ReturnType<typeof setTimeout>[] = []
  /** Set by clearTimeouts(); stops a discarded client resurrecting itself */
  private destroyed = false
  private readonly authOptions: AuthOptions
  private readonly baseSessionMetadata: Record<string, unknown>

  /** Emits when Ring rotates the refresh token; listen to persist the new token */
  onRefreshTokenUpdated = new ReplaySubject<{
    oldRefreshToken?: string
    newRefreshToken: string
  }>(1)

  /**
   * 2FA prompt message, set when Ring requires a verification code.
   * The Homebridge UI checks this after a login attempt to know
   * whether to show the 2FA code input.
   */
  promptFor2fa: string | undefined

  /** Whether the current auth flow is using 2FA */
  using2fa = false

  constructor(authOptions: AuthOptions) {
    this.authOptions = authOptions
    this.refreshToken =
      'refreshToken' in authOptions ? authOptions.refreshToken : undefined
    this.authConfig = parseAuthConfig(this.refreshToken)

    // Use the hardware ID from the auth config if available (preserves
    // the ID across restarts), otherwise generate a new one
    this.hardwareId = this.authConfig?.hid || generateHardwareId()

    this.baseSessionMetadata = {
      api_version: API_VERSION,
      device_model:
        authOptions.controlCenterDisplayName ?? 'ring-client-api',
    }
  }

  // ─── OAuth Token Management ──────────────────────────────────────────

  private get authPromise(): Promise<OAuthResponse> {
    if (!this._authPromise) {
      const authPromise = this.getAuth()
      this._authPromise = authPromise

      // Clear the cached auth 1 minute before it expires so the next
      // request triggers a fresh token exchange
      authPromise
        .then(({ expires_in }) => {
          const timeout = setTimeout(
            () => {
              if (this._authPromise === authPromise) {
                this._authPromise = undefined
              }
            },
            ((expires_in || 3600) - 60) * 1000,
          )
          // unref: an hour-long token timer must not hold the process open
          timeout.unref()
          this.timeouts.push(timeout)
        })
        .catch(() => {
          // Auth failed. Clear the cached promise so the NEXT request
          // attempts a fresh token exchange instead of being stuck on
          // this rejected promise until restart. The error itself is
          // handled by the caller making the request.
          if (this._authPromise === authPromise) {
            this._authPromise = undefined
          }
        })
    }
    return this._authPromise
  }

  private getGrantData(twoFactorAuthCode?: string) {
    if (this.authConfig?.rt && !twoFactorAuthCode) {
      return {
        grant_type: 'refresh_token',
        refresh_token: this.authConfig.rt,
      }
    }
    if ('email' in this.authOptions) {
      return {
        grant_type: 'password',
        password: this.authOptions.password,
        username: this.authOptions.email,
      }
    }
    throw new RingAuthError(
      'Refresh token is not valid. Unable to authenticate with Ring servers.',
    )
  }

  /**
   * Exchange credentials for an OAuth token.
   * Handles 2FA challenges (412 response) and invalid 2FA codes (400).
   */
  async getAuth(twoFactorAuthCode?: string): Promise<OAuthResponse> {
    const grantData = this.getGrantData(twoFactorAuthCode)

    try {
      const response = await requestWithRetry<OAuthResponse>({
        url: 'https://oauth.ring.com/oauth/token',
        json: {
          client_id: 'ring_official_android',
          scope: 'client',
          ...grantData,
        },
        method: 'POST',
        headers: {
          '2fa-support': 'true',
          '2fa-code': twoFactorAuthCode || '',
          hardware_id: this.hardwareId,
          'User-Agent': 'android:com.ringapp',
        },
      })

      const oldRefreshToken = this.refreshToken

      // Store the new auth config with the rotated token and hardware ID
      this.authConfig = {
        ...this.authConfig,
        rt: response.refresh_token,
        hid: this.hardwareId,
      }
      this.refreshToken = toBase64(JSON.stringify(this.authConfig))

      // Notify listeners so the new token can be persisted
      this.onRefreshTokenUpdated.next({
        oldRefreshToken,
        newRefreshToken: this.refreshToken,
      })

      return {
        ...response,
        refresh_token: this.refreshToken,
      }
    } catch (requestError: any) {
      if (grantData.refresh_token) {
        const status = requestError.response?.status

        // Transient failures (network error, Ring 5xx, rate limiting) do
        // NOT mean the refresh token is bad. Keep the credentials so the
        // next attempt can retry with the same token. Wiping them here
        // would leave the plugin permanently unauthenticated until restart
        // over a hiccup on Ring's side.
        if (status === undefined || status >= 500 || status === 429) {
          logError(
            `Failed to refresh Ring auth token (${status ?? 'network error'}). Will retry with the same refresh token.`,
          )
          throw requestError
        }

        // Definitive rejection (4xx): the token really is invalid.
        // Clear it and retry, which falls through to email/password
        // if available, or throws a helpful error. The recursion is
        // bounded: with the token cleared, getGrantData throws
        // synchronously unless email/password credentials exist.
        this.refreshToken = undefined
        this.authConfig = undefined
        logError(requestError)
        return this.getAuth()
      }

      const response = requestError.response || {}
      const responseData = response.body || {}
      const responseError =
        'error' in responseData && typeof responseData.error === 'string'
          ? responseData.error
          : ''

      // 412 = 2FA required, 400 with "Verification Code" = invalid 2FA code
      if (
        response.status === 412 ||
        (response.status === 400 &&
          responseError.startsWith('Verification Code'))
      ) {
        this.using2fa = true

        if (response.status === 400) {
          this.promptFor2fa = 'Invalid code entered. Please try again.'
          throw new Ring2FARequired(responseError)
        }

        if ('tsv_state' in responseData) {
          const { tsv_state, phone } = responseData
          const prompt =
            tsv_state === 'totp'
              ? 'from your authenticator app'
              : `sent to ${phone} via ${tsv_state}`
          this.promptFor2fa = `Please enter the code ${prompt}`
        } else {
          this.promptFor2fa =
            'Please enter the code sent to your text/email'
        }

        throw new Ring2FARequired(
          'Your Ring account is configured to use 2-factor authentication.',
        )
      }

      const authTypeMessage =
        'refreshToken' in this.authOptions
          ? 'refresh token is'
          : 'email and password are'
      const errorMessage =
        'Failed to fetch oauth token from Ring. ' +
        ('error_description' in responseData &&
        responseData.error_description ===
          'too many requests from dependency service'
          ? 'You have requested too many 2fa codes. Ring limits 2fa to 10 codes within 10 minutes. Please try again in 10 minutes.'
          : `Verify that your ${authTypeMessage} correct.`) +
        ` (error: ${responseError})`

      logError(errorMessage)
      throw new RingAuthError(errorMessage)
    }
  }

  /** Get the current auth token (triggers OAuth if needed) */
  getCurrentAuth(): Promise<OAuthResponse> {
    return this.authPromise
  }

  /**
   * Force a fresh token exchange, replacing the given stale attempt.
   *
   * Ring's refresh tokens are effectively single-use, so two concurrent
   * exchanges of the same token would double-spend it: whichever Ring
   * processes second is a reuse of an already-rotated token, which fails and
   * can invalidate the whole chain. The compare-and-swap makes concurrent
   * 401 handlers share ONE exchange: only the caller whose attempt is still
   * the cached one invalidates it; the others simply await the replacement.
   */
  private async refreshAuth(
    staleAuth?: Promise<OAuthResponse>,
  ): Promise<void> {
    if (!staleAuth || this._authPromise === staleAuth) {
      this._authPromise = undefined
    }
    await this.authPromise
  }

  // ─── Session Management ──────────────────────────────────────────────

  /**
   * Create a Ring session. This is required before making API requests;
   * it registers this "device" with Ring's servers.
   */
  private async fetchNewSession(
    authToken: OAuthResponse,
  ): Promise<unknown> {
    return requestWithRetry({
      url: clientApi('session'),
      json: {
        device: {
          hardware_id: this.hardwareId,
          metadata: this.baseSessionMetadata,
          os: 'android',
        },
      },
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken.access_token}`,
      },
    })
  }

  private getSession(attempt = 1): Promise<unknown> {
    // Capture the exact auth attempt used, so a 401 only invalidates that one
    // and cannot clobber a fresh exchange another caller already started.
    const authAttempt = this.authPromise
    return authAttempt.then(async (authToken) => {
      try {
        return await this.fetchNewSession(authToken)
      } catch (e: any) {
        const response = e.response || {}
        if (response.status === 401 && attempt <= 2) {
          await this.refreshAuth(authAttempt)
          return this.getSession(attempt + 1)
        }
        if (response.status === 429) {
          // Bounded: the wait is capped AND the attempts are counted. Capping
          // the wait without bounding the retries would turn a long server
          // backoff into a 61-second hammer loop, and because every request
          // awaits this session promise, it would never settle.
          if (attempt > 3) {
            throw new RingApiError(
              'Ring rate limited the session request repeatedly; giving up for now',
            )
          }
          // headers.get() returns null when the header is absent, and
          // parseInt(null) is NaN, so guard on the PARSED value. The old
          // isNaN(null) check was false, which produced delay(NaN), i.e.
          // an instant zero-delay retry loop against a rate limiter.
          //
          // Ring can also send very large retry-after values when it rate
          // limits an account; honoring those verbatim would stall discovery
          // for hours, so the wait is capped and the caller's own retry loop
          // owns any longer wait.
          const retryAfter = e.response.headers.get('retry-after')
          const parsed = Number.parseInt(retryAfter ?? '', 10)
          const waitSeconds = Math.min(
            Number.isNaN(parsed) ? MAX_RATE_LIMIT_WAIT_S : parsed,
            MAX_RATE_LIMIT_WAIT_S,
          )
          logError(
            `Session response rate limited. Waiting to retry after ${waitSeconds} seconds`,
          )
          await delay((waitSeconds + 1) * 1000)
          return this.getSession(attempt + 1)
        }
        throw e
      }
    })
  }

  refreshSession(): void {
    if (this.destroyed) return
    this.sessionPromise = this.getSession()
    this.sessionPromise
      .finally(() => {
        // Refresh the session every 12 hours to keep it alive.
        // unref: a 12-hour timer would otherwise keep the child bridge
        // process alive long after Homebridge asked it to shut down.
        const timeout = setTimeout(
          () => this.refreshSession(),
          12 * 60 * 60 * 1000,
        )
        timeout.unref()
        this.timeouts.push(timeout)
      })
      .catch((e) => logError(e))
  }

  // ─── Authenticated Requests ──────────────────────────────────────────

  /**
   * Make an authenticated request to a Ring API endpoint.
   * Automatically adds the OAuth bearer token, creates a session if needed,
   * and handles 401/429/504 responses with bounded retries. Retries are
   * capped (with backoff) so a persistent failure surfaces as an error the
   * caller can handle instead of recursing forever, and each 401 retry is
   * limited because every one performs a full token exchange.
   */
  async request<T>(options: { url: string }, attempt = 1): Promise<T> {
    const { url } = options
    const initialSessionPromise = this.sessionPromise
    let authAttempt: Promise<OAuthResponse> | undefined

    try {
      // A failed session should not brick every request: proceed with the
      // bearer token and let the hardware_id-not-found path below recover
      // the session if an endpoint genuinely requires one.
      await initialSessionPromise?.catch(() => {})
      // Capture the exact auth attempt so a 401 replaces only this one
      authAttempt = this.authPromise
      const authToken = await authAttempt

      return await requestWithRetry<T>({
        ...options,
        headers: {
          authorization: `Bearer ${authToken.access_token}`,
          hardware_id: this.hardwareId,
          'User-Agent': 'android:com.ringapp',
        },
      })
    } catch (e: any) {
      const response = e.response || {}

      if (response.status === 401 && attempt <= 2) {
        await this.refreshAuth(authAttempt)
        return this.request<T>(options, attempt + 1)
      }

      if (response.status === 504 && attempt <= 5) {
        await delay(5000 * attempt)
        return this.request<T>(options, attempt + 1)
      }

      if (response.status === 404 && url.startsWith(clientApiBaseUrl)) {
        if (response.body?.error?.includes(this.hardwareId) && attempt <= 2) {
          logError(
            'Session hardware_id not found. Creating a new session and trying again.',
          )
          if (this.sessionPromise === initialSessionPromise) {
            this.refreshSession()
          }
          return this.request<T>(options, attempt + 1)
        }
        throw new Error(
          'Not found with response: ' + stringify(response.body),
        )
      }

      if (response.status) {
        logError(
          `Request to ${url} failed with status ${response.status}. Response body: ${stringify(response.body)}`,
        )
      }

      throw e
    }
  }

  /**
   * Clean up timers and retire this client.
   *
   * The retirement flag matters: the session refresh reschedules itself from
   * a `.finally()`, so a session request still in flight when this is called
   * would otherwise arm a fresh 12-hour timer on a client that has already
   * been discarded. That zombie would later re-authenticate with a stale
   * refresh token and could overwrite the good token in config.json.
   */
  clearTimeouts(): void {
    this.destroyed = true
    this.timeouts.forEach(clearTimeout)
    this.timeouts = []
  }
}
