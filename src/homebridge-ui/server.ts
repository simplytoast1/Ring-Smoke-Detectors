/**
 * Homebridge Custom UI Server
 *
 * Handles the Ring login flow and the device list within the Homebridge UI.
 *
 * /send-code      - Log in with email + password (may ask for a 2FA code)
 * /token          - Complete a login with the 2FA code
 * /devices        - The devices the running plugin has discovered
 * /current-token  - The refresh token config.json holds right now
 *
 * TOKEN RULE: nothing here ever exchanges a refresh token. Ring's tokens are
 * single-use, and the running plugin is the only thing allowed to rotate the
 * one in config.json. A login scans for devices with the session it just
 * created (see login-discovery.ts); everything else reads the plugin's cache.
 */

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'
import { RingRestClient } from '../ring-api/ring-rest-client.js'
import { readCache } from '../ring-api/device-cache.js'
import { readRefreshTokenFromFile } from '../ring-api/config-store.js'
import { completeLogin } from './login-discovery.js'

interface LoginRequest {
  email: string
  password: string
}

interface TokenRequest {
  email: string
  password: string
  code: string
}

/** Display name shown in Ring's authorized devices list */
const controlCenterDisplayName = 'homebridge-ring-smoke-detectors'

class RingSmokeDetectorsUiServer extends HomebridgePluginUiServer {
  /** The login in progress, kept between the password and 2FA steps */
  private restClient: RingRestClient | null = null

  constructor() {
    super()

    this.onRequest('/send-code', this.generateCode.bind(this))
    this.onRequest('/token', this.generateToken.bind(this))
    this.onRequest('/devices', this.cachedDevices.bind(this))
    this.onRequest('/current-token', this.currentToken.bind(this))

    this.ready()
  }

  /**
   * Step 1: Log in to Ring with email + password.
   * If 2FA is required, returns the prompt message for the UI. Otherwise
   * returns the finished login (token plus discovered devices).
   */
  async generateCode({ email, password }: LoginRequest) {
    if (!email || !password) {
      throw new RequestError('Email and password are required', { status: 400 })
    }

    const client = new RingRestClient({
      email,
      password,
      controlCenterDisplayName,
    })
    this.restClient = client

    try {
      await client.getCurrentAuth()
    } catch (e: any) {
      if (client.promptFor2fa) {
        return { codePrompt: client.promptFor2fa }
      }
      throw e
    }
    return this.finishLogin(client)
  }

  /**
   * Step 2: Complete the login with the 2FA verification code.
   */
  async generateToken({ email, password, code }: TokenRequest) {
    if (!code) {
      throw new RequestError('Verification code is required', { status: 400 })
    }
    if (!this.restClient && (!email || !password)) {
      throw new RequestError('Please log in with email and password first', {
        status: 400,
      })
    }

    const client =
      this.restClient ||
      new RingRestClient({ email, password, controlCenterDisplayName })
    this.restClient = client

    // Keeps the resulting session on the client, so the device scan that
    // follows does not have to sign in a second time.
    await client.authenticateWithCode(code)
    return this.finishLogin(client)
  }

  private async finishLogin(client: RingRestClient) {
    this.restClient = null
    return completeLogin(client, this.homebridgeStoragePath)
  }

  /**
   * The devices the RUNNING PLUGIN has discovered, read from its cache,
   * along with every Ring location on the account.
   *
   * This never talks to Ring. Scanning from here would mean signing in with
   * the token in config.json, which is the running plugin's token: spending
   * it out from under the plugin knocks the plugin offline. An empty list is
   * reported as such so the page can explain what to do.
   */
  async cachedDevices() {
    const storagePath = this.homebridgeStoragePath
    const { devices, locations } = storagePath
      ? await readCache(storagePath)
      : { devices: [], locations: [] }
    return {
      devices,
      locations,
      fromCache: true,
      cacheEmpty: devices.length === 0,
    }
  }

  /**
   * The refresh token as it stands in config.json right now.
   *
   * The page asks for this immediately before saving. Its own copy of the
   * config dates from when the settings were opened, and the plugin rotates
   * the token about once an hour, so saving the page's copy would put a
   * spent token back into config.json.
   */
  async currentToken() {
    const configPath = this.homebridgeConfigPath
    const refreshToken = configPath
      ? readRefreshTokenFromFile(configPath)
      : undefined
    return { refreshToken: refreshToken ?? null }
  }
}

new RingSmokeDetectorsUiServer()
