/**
 * Ring REST Client — Lean OAuth + Authenticated Request Client
 *
 * This is our own implementation of the Ring REST client, replacing the
 * ring-client-api dependency. We only need OAuth authentication, session
 * management, and authenticated HTTP requests — not cameras, streaming,
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
 * API requests. We use crypto.randomUUID() — no need for the systeminformation
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

/**
 * Make an HTTP request with automatic retry on network failures.
 * On non-response errors (network timeouts, DNS failures, etc.),
 * retries indefinitely with a 5-second delay between attempts.
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
  private readonly authOptions: AuthOptions
  private readonly baseSessionMetadata: Record<string, unknown>

  /** Emits when Ring rotates the refresh token — listen to persist the new token */
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
          this.timeouts.push(timeout)
        })
        .catch(() => {
          // Errors are handled by the caller making the request
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
    throw new Error(
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
        // Refresh token failed — clear it and retry (will fall through
        // to email/password if available, or throw)
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
          throw new Error(responseError)
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

        throw new Error(
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
      throw new Error(errorMessage)
    }
  }

  /** Get the current auth token (triggers OAuth if needed) */
  getCurrentAuth(): Promise<OAuthResponse> {
    return this.authPromise
  }

  private async refreshAuth(): Promise<void> {
    this._authPromise = undefined
    await this.authPromise
  }

  // ─── Session Management ──────────────────────────────────────────────

  /**
   * Create a Ring session. This is required before making API requests —
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

  private getSession(): Promise<unknown> {
    return this.authPromise.then(async (authToken) => {
      try {
        return await this.fetchNewSession(authToken)
      } catch (e: any) {
        const response = e.response || {}
        if (response.status === 401) {
          await this.refreshAuth()
          return this.getSession()
        }
        if (response.status === 429) {
          const retryAfter = e.response.headers.get('retry-after')
          const waitSeconds = isNaN(retryAfter)
            ? 200
            : Number.parseInt(retryAfter, 10)
          logError(
            `Session response rate limited. Waiting to retry after ${waitSeconds} seconds`,
          )
          await delay((waitSeconds + 1) * 1000)
          return this.getSession()
        }
        throw e
      }
    })
  }

  refreshSession(): void {
    this.sessionPromise = this.getSession()
    this.sessionPromise
      .finally(() => {
        // Refresh the session every 12 hours to keep it alive
        const timeout = setTimeout(
          () => this.refreshSession(),
          12 * 60 * 60 * 1000,
        )
        this.timeouts.push(timeout)
      })
      .catch((e) => logError(e))
  }

  // ─── Authenticated Requests ──────────────────────────────────────────

  /**
   * Make an authenticated request to a Ring API endpoint.
   * Automatically adds the OAuth bearer token, creates a session if needed,
   * and handles 401/429/504 responses with appropriate retries.
   */
  async request<T>(options: { url: string }): Promise<T> {
    const { url } = options
    const initialSessionPromise = this.sessionPromise

    try {
      await initialSessionPromise
      const authToken = await this.authPromise

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

      if (response.status === 401) {
        await this.refreshAuth()
        return this.request<T>(options)
      }

      if (response.status === 504) {
        await delay(5000)
        return this.request<T>(options)
      }

      if (response.status === 404 && url.startsWith(clientApiBaseUrl)) {
        if (
          response.body?.error?.includes(this.hardwareId)
        ) {
          logError(
            'Session hardware_id not found. Creating a new session and trying again.',
          )
          if (this.sessionPromise === initialSessionPromise) {
            this.refreshSession()
          }
          return this.request<T>(options)
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

  /** Clean up timers on shutdown */
  clearTimeouts(): void {
    this.timeouts.forEach(clearTimeout)
  }
}
