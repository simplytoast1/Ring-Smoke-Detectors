/**
 * Homebridge Custom UI Server
 *
 * Handles the Ring authentication flow and device discovery within the
 * Homebridge UI. Three endpoints:
 *
 * /send-code  — Initiate login with email + password (may trigger 2FA)
 * /token      — Complete 2FA with verification code
 * /devices    — Discover Kidde devices via WebSocket (for the device list UI)
 */

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'
import { RingRestClient, deviceApi, appApi } from '../ring-api/ring-rest-client.js'
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

/** Human-readable model names for device types */
function getModelName(deviceType: string): string {
  if (deviceType.includes('sensor_bluejay_wsc')) return 'Smoke + CO Alarm (Wired)'
  if (deviceType.includes('sensor_bluejay_ws')) return 'Smoke Alarm (Wired)'
  if (deviceType.includes('sensor_bluejay_sc')) return 'Smoke + CO Alarm (Battery)'
  return deviceType
}

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
    this.restClient =
      this.restClient || new RingRestClient({ email, password })

    const authResponse = await this.restClient.getAuth(code)
    return { refreshToken: authResponse.refresh_token }
  }

  /**
   * Discover Kidde devices by connecting to Ring's WebSocket for each location.
   * This runs the same discovery flow as the main plugin but returns the device
   * list to the UI so users can see, rename, and hide devices.
   */
  async discoverDevices({ refreshToken }: DevicesRequest) {
    const client = new RingRestClient({ refreshToken })
    client.refreshSession()

    // Fetch locations
    const { user_locations: locations } = await client.request<{
      user_locations: { location_id: string; name: string }[]
    }>({ url: deviceApi('locations') })

    const devices: DiscoveredDevice[] = []

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
        // Skip locations that fail — don't block the whole discovery
      }
    }

    client.clearTimeouts()
    return { devices }
  }

  /**
   * Connect to a Ring WebSocket, request device lists for each asset,
   * and return the discovered Kidde devices. Times out after 10 seconds.
   */
  private fetchDevicesFromWebSocket(
    wsUrl: string,
    assets: { kind: string; uuid: string }[],
    locationName: string,
  ): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
      const devices: DiscoveredDevice[] = []
      const respondedAssets = new Set<string>()
      let seq = 1

      const timeout = setTimeout(() => {
        try { socket.close() } catch {}
        resolve(devices)
      }, 10000)

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
          if (!message || message.msg !== 'DeviceInfoDocGetList' || !message.body) return

          respondedAssets.add(message.src)

          for (const data of message.body) {
            const flat = Object.assign({}, data.general?.v2, data.device?.v1)
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

          // If all assets have responded, we're done
          if (assets.every((a) => respondedAssets.has(a.uuid))) {
            clearTimeout(timeout)
            try { socket.close() } catch {}
            resolve(devices)
          }
        } catch {}
      })

      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        resolve(devices)
      })
    })
  }
}

new RingSmokeDetectorsUiServer()
