/**
 * REST Client Wrapper
 *
 * Thin wrapper around our own RingRestClient. Handles creating the client,
 * establishing a session, and persisting token updates.
 */

import { RingRestClient, clientApi, appApi, deviceApi } from './ring-rest-client.js'
import { logError } from '../util.js'

/** Re-export URL helpers for use by other modules */
export { clientApi, appApi, deviceApi }
/** Re-export the client class for use by websocket-connection.ts */
export { RingRestClient }

export class RestClientWrapper {
  /** The underlying RingRestClient, also used directly by SmokeDetectorWebSocket */
  public readonly restClient: RingRestClient

  constructor(
    refreshToken: string,
    onTokenUpdate?: (newToken: string, oldToken?: string) => void,
  ) {
    this.restClient = new RingRestClient({ refreshToken })

    // Establish a session immediately so requests can proceed
    this.restClient.refreshSession()

    // Ring periodically rotates refresh tokens. When this happens, we need to
    // persist the new token so the plugin can authenticate on next restart.
    // Both old and new are forwarded: the platform replaces the old token with
    // the new one inside config.json.
    this.restClient.onRefreshTokenUpdated.subscribe(
      ({
        oldRefreshToken,
        newRefreshToken,
      }: {
        oldRefreshToken?: string
        newRefreshToken: string
      }) => {
        onTokenUpdate?.(newRefreshToken, oldRefreshToken)
      },
    )
  }

  /**
   * Make an authenticated REST API request.
   * RingRestClient handles adding the OAuth bearer token, retrying on
   * rate limits (429), and refreshing expired tokens automatically.
   */
  async request<T>(url: string): Promise<T> {
    try {
      return await this.restClient.request<T>({ url })
    } catch (error) {
      logError(`REST request failed: ${url} - ${error}`)
      throw error
    }
  }
}
