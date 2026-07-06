/**
 * Homebridge Custom UI Server
 *
 * Handles the Ring authentication flow and device discovery within the
 * Homebridge UI. Three endpoints:
 *
 * /send-code  - Initiate login with email + password (may trigger 2FA)
 * /token      - Complete 2FA with verification code
 * /devices    - Discover Kidde devices via WebSocket (for the device list UI)
 */

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'
import { RingRestClient, deviceApi, appApi } from '../ring-api/ring-rest-client.js'
import { readDeviceCache } from '../ring-api/device-cache.js'
import { WebSocket } from 'undici'

interface LoginRequest {
  email: string
  password: string
}

interface TokenRequest {
  email: string
  password: string
  code: string
}

interface DevicesRequest {
  refreshToken: string
  /** Force a live WebSocket discovery instead of reading the plugin's cache */
  forceRefresh?: boolean
}

interface DiscoveredDevice {
  zid: string
  name: string
  deviceType: string
  locationName: string
  batteryLevel?: number
  batteryStatus?: string
}

/** Display name shown in Ring's authorized devices list */
const controlCenterDisplayName = 'homebridge-ring-smoke-detectors'

class RingSmokeDetectorsUiServer extends HomebridgePluginUiServer {
  private restClient: RingRestClient | null = null

  constructor() {
    super()

    this.onRequest('/send-code', this.generateCode.bind(this))
    this.onRequest('/token', this.generateToken.bind(this))
    this.onRequest('/devices', this.discoverDevices.bind(this))

    this.ready()
  }

  /**
   * Step 1: Initiate Ring login with email + password.
   * If 2FA is required, returns the prompt message for the UI.
   */
  async generateCode({ email, password }: LoginRequest) {
    if (!email || !password) {
      throw new RequestError('Email and password are required', { status: 400 })
    }

    this.restClient = new RingRestClient({
      email,
      password,
      controlCenterDisplayName,
    })

    try {
      const { refresh_token } = await this.restClient.getCurrentAuth()
      return { refreshToken: refresh_token }
    } catch (e: any) {
      if (this.restClient.promptFor2fa) {
        return { codePrompt: this.restClient.promptFor2fa }
      }
      throw e
    }
  }

  /**
   * Step 2: Complete 2FA with the verification code.
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

    this.restClient =
      this.restClient ||
      new RingRestClient({ email, password, controlCenterDisplayName })

    const authResponse = await this.restClient.getAuth(code)
    return { refreshToken: authResponse.refresh_token }
  }

  /**
   * Return the list of Kidde devices for the settings UI.
   *
   * By default this reads the cache the RUNNING PLUGIN writes after discovery,
   * which requires NO authentication and therefore does not rotate the Ring
   * token. That is the whole point: Ring's tokens are effectively single-use,
   * so if the settings page authenticated on every open it could rotate the
   * token out from under the running plugin and knock it offline. Reading the
   * plugin's cache keeps the plugin the sole token consumer.
   *
   * A live WebSocket discovery (which DOES authenticate and rotate) happens
   * only when the cache is empty (fresh setup, before the plugin has run) or
   * when the user explicitly asks to refresh. In that case the rotated token
   * is returned so the UI can persist it to config.json on Save.
   */
  async discoverDevices({ refreshToken, forceRefresh }: DevicesRequest) {
    if (!refreshToken) {
      throw new RequestError('Not authenticated', { status: 400 })
    }

    // Default path: read the plugin's cache. Never authenticate here, even if
    // the cache is empty, because authenticating would rotate the running
    // plugin's single-use token. An empty cache is reported so the UI can ask
    // the user to log in (an explicit, expected auth) instead.
    const storagePath = this.homebridgeStoragePath
    if (!forceRefresh) {
      const cached = storagePath ? await readDeviceCache(storagePath) : []
      return { devices: cached, fromCache: true, cacheEmpty: cached.length === 0 }
    }

    // forceRefresh: an explicit login-time live discovery. This authenticates
    // and rotates the token; the rotated token is returned so the UI persists
    // it immediately.
    const client = new RingRestClient({ refreshToken })

    // Capture the rotated token so it can be handed back to the UI
    let rotatedToken: string | undefined
    const tokenSub = client.onRefreshTokenUpdated.subscribe(
      ({ newRefreshToken }) => {
        rotatedToken = newRefreshToken
      },
    )

    try {
      client.refreshSession()

      // Fetch locations
      const { user_locations: locations } = await client.request<{
        user_locations: { location_id: string; name: string }[]
      }>({ url: deviceApi('locations') })

      const devices: DiscoveredDevice[] = []
      const failedLocations: string[] = []

      for (const location of locations) {
        try {
          // Request a WebSocket ticket
          const ticketUrl = appApi(
            `clap/tickets?locationID=${location.location_id}&enableExtendedEmergencyCellUsage=true&requestedTransport=ws`,
          )
          const ticketResponse = await client.request<{
            assets: { kind: string; uuid: string; status: string }[]
            ticket: string
            host: string
          }>({ url: ticketUrl })

          // Filter for Kidde assets
          const kiddeAssets = ticketResponse.assets.filter((a) =>
            a.kind.startsWith('sensor_bluejay'),
          )
          if (kiddeAssets.length === 0) continue

          // Connect to WebSocket and request device lists
          const wsUrl = `wss://${ticketResponse.host}/ws?authcode=${ticketResponse.ticket}&ack=false`
          const locationDevices = await this.fetchDevicesFromWebSocket(
            wsUrl,
            kiddeAssets,
            location.name,
          )
          devices.push(...locationDevices)
        } catch (error) {
          // Don't block the whole discovery on one bad location, but
          // don't swallow the failure either: the UI shows a warning so
          // an auth/connectivity problem doesn't masquerade as
          // "no devices found"
          console.error(
            `Device discovery failed for location "${location.name}":`,
            error,
          )
          failedLocations.push(location.name)
        }
      }

      return { devices, failedLocations, refreshToken: rotatedToken }
    } finally {
      tokenSub.unsubscribe()
      client.clearTimeouts()
    }
  }

  /**
   * Connect to a Ring WebSocket, request device lists for each asset,
   * and return the discovered Kidde devices. Times out after 10 seconds.
   * Waits for every asset to respond (the timeout backstops any that
   * don't); ticket status is not used to gate completion, because Ring
   * does not reliably report it as 'online'.
   */
  private fetchDevicesFromWebSocket(
    wsUrl: string,
    assets: { kind: string; uuid: string; status: string }[],
    locationName: string,
  ): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
      const devices: DiscoveredDevice[] = []
      const respondedAssets = new Set<string>()
      let seq = 1
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        try {
          socket.close()
        } catch {
          // ignore
        }
        resolve(devices)
      }

      const timeout = setTimeout(finish, 10000)

      const socket = new WebSocket(wsUrl)

      socket.addEventListener('open', () => {
        for (const asset of assets) {
          socket.send(
            JSON.stringify({
              channel: 'message',
              msg: { msg: 'DeviceInfoDocGetList', dst: asset.uuid, seq: seq++ },
            }),
          )
        }
      })

      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(String(event.data))
          const message = parsed.msg
          if (
            !message ||
            message.msg !== 'DeviceInfoDocGetList' ||
            !Array.isArray(message.body)
          ) {
            return
          }

          respondedAssets.add(message.src)

          for (const data of message.body) {
            const flat = Object.assign({}, data?.general?.v2, data?.device?.v1)
            if (!flat.deviceType?.includes('sensor_bluejay')) continue

            devices.push({
              zid: flat.zid,
              name: flat.name || 'Smoke Detector',
              deviceType: flat.deviceType,
              locationName,
              batteryLevel: flat.batteryLevel,
              batteryStatus: flat.batteryStatus,
            })
          }

          // If all assets have responded, we're done (the 10s timeout
          // backstops any that never answer)
          if (assets.every((a) => respondedAssets.has(a.uuid))) {
            finish()
          }
        } catch {
          // ignore malformed messages
        }
      })

      socket.addEventListener('error', finish)
      socket.addEventListener('close', finish)
    })
  }
}

new RingSmokeDetectorsUiServer()
