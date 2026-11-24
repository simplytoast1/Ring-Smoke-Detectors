/**
 * Device scan for the settings page, done with the LOGIN session.
 *
 * Ring's refresh tokens are single-use, so the rule for the settings page is
 * simple: it never exchanges a refresh token. Not the running plugin's, and
 * not the one a login just produced.
 *
 * - A login already yields an access token. The scan below reuses that
 *   access token, so the refresh token handed back to the page is the one
 *   Ring just issued, untouched. (The page used to save the login token and
 *   then immediately spend it on a second sign-in to scan for devices,
 *   leaving config.json holding a spent token until a follow-up save landed.)
 * - Outside of a login there is nothing to scan with, by design: the page
 *   shows what the running plugin discovered (the device cache). To keep
 *   that from being a dead end right after a first login, when the plugin
 *   has not run yet, the login-time scan seeds the cache if it is empty.
 *
 * This lives apart from server.ts so it can be tested: server.ts starts the
 * UI server as a side effect of being imported.
 */

import {
  RingRestClient,
  deviceApi,
  appApi,
} from '../ring-api/ring-rest-client.js'
import {
  readDeviceCache,
  writeDeviceCache,
  type CachedDevice,
} from '../ring-api/device-cache.js'
import { openSocket } from '../ring-api/socket-factory.js'
import {
  flattenDeviceList,
  isKiddeAsset,
  isKiddeDeviceType,
  type RingLocation,
  type TicketAsset,
  type TicketResponse,
} from '../ring-api/types.js'

/** How long to wait for one location's detectors to answer */
const LOCATION_SCAN_TIMEOUT_MS = 10_000

export interface ScanResult {
  devices: CachedDevice[]
  /** Names of locations that could not be scanned at all */
  failedLocations: string[]
  /** True when every location answered in full */
  complete: boolean
}

export interface LoginResult {
  /** The token to save to config.json. Final: nothing spends it afterwards. */
  refreshToken: string
  devices: CachedDevice[]
  failedLocations: string[]
  /** True when the scan could not run at all. The login itself succeeded. */
  scanFailed: boolean
}

/**
 * Ask one location's detectors for their device documents.
 * Resolves with whatever arrived when every asset has answered, the socket
 * closes, or the timeout passes. Rejects if the socket fails outright.
 */
function scanLocation(
  wsUrl: string,
  assets: TicketAsset[],
  locationName: string,
): Promise<{ devices: CachedDevice[]; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const devices: CachedDevice[] = []
    const answered = new Set<string>()
    let seq = 1
    let settled = false

    const socket = openSocket(wsUrl)
    const allAnswered = () => assets.every((a) => answered.has(a.uuid))
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (error) reject(error)
      else resolve({ devices, complete: allAnswered() })
    }
    const timer = setTimeout(() => settle(), LOCATION_SCAN_TIMEOUT_MS)

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
        const message = JSON.parse(String(event.data))?.msg
        if (
          !message ||
          message.msg !== 'DeviceInfoDocGetList' ||
          !Array.isArray(message.body)
        ) {
          return
        }
        answered.add(message.src)

        for (const device of flattenDeviceList(message.body)) {
          if (!isKiddeDeviceType(device.deviceType)) continue
          devices.push({
            zid: device.zid,
            name: device.name || 'Smoke Detector',
            deviceType: device.deviceType,
            locationName,
            batteryLevel: device.batteryLevel,
            batteryStatus: device.batteryStatus,
          })
        }

        if (allAnswered()) settle()
      } catch {
        // ignore malformed messages
      }
    })

    socket.addEventListener('error', () =>
      settle(new Error(`WebSocket connection failed for "${locationName}"`)),
    )
    socket.addEventListener('close', () => settle())
  })
}

/**
 * Find every Kidde detector on the account, using a client that is already
 * authenticated. One unreachable location does not stop the others.
 */
export async function scanDevices(client: RingRestClient): Promise<ScanResult> {
  const response = await client.request<{ user_locations?: RingLocation[] }>({
    url: deviceApi('locations'),
  })
  const locations = Array.isArray(response?.user_locations)
    ? response.user_locations
    : []

  const byZid = new Map<string, CachedDevice>()
  const failedLocations: string[] = []
  let complete = true

  for (const location of locations) {
    try {
      const ticket = await client.request<TicketResponse>({
        url: appApi(
          `clap/tickets?locationID=${location.location_id}&enableExtendedEmergencyCellUsage=true&requestedTransport=ws`,
        ),
      })
      const assets = (ticket?.assets ?? []).filter(isKiddeAsset)
      if (assets.length === 0) continue

      const result = await scanLocation(
        `wss://${ticket.host}/ws?authcode=${ticket.ticket}&ack=false`,
        assets,
        location.name,
      )
      for (const device of result.devices) byZid.set(device.zid, device)
      if (!result.complete) complete = false
    } catch (error) {
      // Reported to the page as a warning, so a connectivity problem does
      // not masquerade as "no devices found"
      console.error(
        `Device discovery failed for location "${location.name}":`,
        error,
      )
      failedLocations.push(location.name)
      complete = false
    }
  }

  return { devices: [...byZid.values()], failedLocations, complete }
}

/**
 * Finish a login: scan for devices with the session the login produced, then
 * hand back the token for the page to save.
 *
 * The scan is a convenience. If it fails, the login still succeeds and the
 * running plugin does its own discovery after the next restart.
 */
export async function completeLogin(
  client: RingRestClient,
  storagePath?: string,
): Promise<LoginResult> {
  let scan: ScanResult = { devices: [], failedLocations: [], complete: false }
  let scanFailed = false
  try {
    client.refreshSession()
    scan = await scanDevices(client)
  } catch (error) {
    console.error('Device scan after login failed:', error)
    scanFailed = true
  } finally {
    client.clearTimeouts()
  }

  // Read the token only now. Normally it is exactly what the login returned;
  // if Ring forced a re-authentication mid-scan, this is the replacement.
  const refreshToken = client.refreshToken
  if (!refreshToken) {
    throw new Error(
      'Ring did not keep the new login active. Please log in again.',
    )
  }

  // Seed the device cache so the list is still there when the page is
  // reopened before the plugin has run. Only ever into an EMPTY cache: once
  // the plugin has written its own list, that list is the authority.
  if (storagePath && scan.complete && scan.devices.length > 0) {
    try {
      if ((await readDeviceCache(storagePath)).length === 0) {
        await writeDeviceCache(storagePath, scan.devices)
      }
    } catch (error) {
      console.error('Could not save the discovered device list:', error)
    }
  }

  return {
    refreshToken,
    devices: scan.devices,
    failedLocations: scan.failedLocations,
    scanFailed,
  }
}
