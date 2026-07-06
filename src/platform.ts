/**
 * Ring Smoke Detectors Platform
 *
 * This is the main Homebridge DynamicPlatformPlugin that orchestrates
 * the entire plugin lifecycle:
 *
 * 1. AUTHENTICATION: Uses our lean RingRestClient for OAuth
 * 2. LOCATION DISCOVERY: Fetches ALL Ring locations via REST API
 * 3. WEBSOCKET PROBING: For EVERY location, requests a WebSocket ticket
 *    and checks if sensor_bluejay_* assets are present
 * 4. DEVICE DISCOVERY: For locations with Kidde assets, establishes a
 *    WebSocket and receives full device data (alarm state, battery, etc.)
 * 5. HOMEKIT MAPPING: Creates SmokeSensor/CarbonMonoxideSensor accessories
 * 6. REAL-TIME UPDATES: Subscribes to WebSocket DataUpdate channel
 *
 * CRITICAL: We do NOT rely on the REST API to discover Kidde devices.
 * As @tsightler discovered (https://github.com/dgreif/ring/issues/1674):
 * "It seems these Kiddie smoke/co detectors only show up in the device
 * list via the websocket."
 *
 * The WebSocket is the ONLY reliable source for device discovery and
 * real-time state. We use the clap/tickets endpoint to determine which
 * locations have Kidde assets, then establish WebSocket connections.
 *
 * RESILIENCE: discovery failures are never fatal. If the locations fetch
 * or auth fails, the whole discovery is retried with exponential backoff.
 * If an individual location cannot be probed, the other locations still
 * come up and the failed one is re-probed on its own backoff schedule.
 * Stale-accessory removal only runs after a run in which EVERY location
 * was probed successfully with a complete device list, so a transient
 * Ring outage can never wipe out the user's accessories, rooms, and
 * automations.
 *
 * REFRESH TOKEN PERSISTENCE: Ring rotates refresh tokens periodically.
 * We persist the latest token to a file in the Homebridge storage directory
 * so it survives restarts. The file records which config token the rotation
 * chain started from: if the user re-logs-in through the UI (writing a new
 * token to the config), the config token wins and the stale persisted chain
 * is discarded. If auth with a persisted token fails outright, we fall back
 * to the config token automatically.
 *
 * NEW DEVICE DETECTION: When the WebSocket reconnects (after disconnection
 * or server-initiated reconnect), it re-requests a fresh ticket which may
 * include new assets. We subscribe to onDevices (not just onDeviceDataUpdate)
 * so newly discovered devices get HomeKit accessories automatically, and so
 * periodic device-list polls re-sync state for existing accessories.
 */

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { writeFile, readFile, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { BehaviorSubject } from 'rxjs'
import { hap } from './hap.js'
import {
  RingSmokeDetectorsConfig,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './config.js'
import { setLogger, logInfo, logWarn, logError, logDebug, delay } from './util.js'
import { RestClientWrapper } from './ring-api/rest-client-wrapper.js'
import { fetchAllLocations } from './ring-api/smoke-detector-api.js'
import { SmokeDetectorWebSocket } from './ring-api/websocket-connection.js'
import {
  SmokeDetectorDeviceData,
  RingLocation,
  isKiddeDeviceType,
  isSmokeOnly,
} from './ring-api/types.js'
import { BaseAccessory } from './accessories/base-accessory.js'
import { SmokeCoDetectorAccessory } from './accessories/smoke-co-detector.js'
import { SmokeDetectorAccessory } from './accessories/smoke-detector.js'

/** Filename for persisting the refresh token across restarts */
const TOKEN_FILE = 'ring-smoke-detectors.token'

/** First retry delay for a failed discovery run or location probe */
const INITIAL_RETRY_DELAY_MS = 30_000
/** Cap for discovery/location retry backoff */
const MAX_RETRY_DELAY_MS = 15 * 60_000

/** Persisted token file contents (JSON since v1.3.0, plain string before) */
interface PersistedToken {
  /** The config token this rotation chain started from */
  configToken: string
  /** The most recently rotated token */
  latestToken: string
}

/** Outcome of probing one location */
type ProbeOutcome = 'ok' | 'partial' | 'failed'

/** True when an error is a definitive auth rejection (not transient) */
function isAuthFailure(error: unknown): boolean {
  const message = String(error)
  return (
    message.includes('Failed to fetch oauth token from Ring') ||
    message.includes('Refresh token is not valid')
  )
}

export class RingSmokeDetectorsPlatform implements DynamicPlatformPlugin {
  /**
   * Accessories cached by Homebridge from previous runs.
   * Keyed by UUID (generated from device zid).
   */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>()

  /**
   * Active accessory handlers, keyed by device zid.
   * These manage the RxJS subscriptions that push WebSocket
   * updates to HomeKit characteristics.
   */
  private readonly activeAccessories = new Map<string, BaseAccessory>()

  /** Active WebSocket connections (one per location with Kidde devices) */
  private readonly connections: SmokeDetectorWebSocket[] = []

  /** Path to the Homebridge storage directory for persisting the refresh token */
  private readonly storagePath: string

  /** REST client for the current discovery run (kept for shutdown cleanup) */
  private client: RestClientWrapper | null = null

  /** Pending retry timers, cleared on shutdown */
  private readonly retryTimers: ReturnType<typeof setTimeout>[] = []

  /** The refresh token currently in the Homebridge config */
  private configToken = ''

  /** Whether getRefreshToken() chose the persisted token over the config one */
  private usedPersistedToken = false

  /** Set when Homebridge fires shutdown; stops all retry/discovery loops */
  private shuttingDown = false

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    const pluginConfig = config as RingSmokeDetectorsConfig
    setLogger(log, pluginConfig.debug === true)
    this.storagePath = api.user.storagePath()

    if (!pluginConfig.refreshToken) {
      logError(
        'No refresh token configured. Open the plugin settings in the Homebridge UI to log in.',
      )
      return
    }

    // Wait for Homebridge to finish loading all plugins before we start
    // making network requests and creating accessories
    api.on('didFinishLaunching', () => {
      this.discoverDevices(pluginConfig).catch((error) => {
        logError(`Device discovery failed: ${error}`)
      })
    })

    // Clean up WebSocket connections on Homebridge shutdown
    api.on('shutdown', () => {
      this.shutdown()
    })
  }

  /**
   * Called by Homebridge for each cached accessory on startup.
   * We store these so we can reuse them during discovery (preserving
   * HomeKit pairings and avoiding duplicate accessories).
   */
  configureAccessory(accessory: PlatformAccessory): void {
    logDebug(`Restoring cached accessory: ${accessory.displayName}`)
    this.cachedAccessories.set(accessory.UUID, accessory)
  }

  // ─── Refresh Token Persistence ─────────────────────────────────────────

  private get tokenFilePath(): string {
    return join(this.storagePath, TOKEN_FILE)
  }

  /**
   * Pick the refresh token to authenticate with.
   *
   * The persisted (rotated) token is only used when it descends from the
   * token currently in the config. If the config token changed, the user
   * re-logged-in through the UI, and that fresh token must win; the old
   * persisted chain is dead. Legacy plain-string files (plugin <= 1.2.x)
   * are treated as descending from the current config token, matching
   * their old behavior, and are upgraded to the new format on the next
   * rotation.
   */
  private async getRefreshToken(configToken: string): Promise<string> {
    this.usedPersistedToken = false
    try {
      const raw = (await readFile(this.tokenFilePath, 'utf-8')).trim()
      if (!raw) return configToken

      let stored: Partial<PersistedToken>
      try {
        const parsed = JSON.parse(raw)
        stored =
          parsed && typeof parsed === 'object'
            ? (parsed as Partial<PersistedToken>)
            : { configToken, latestToken: raw }
      } catch {
        // Legacy format: the file is the rotated token itself
        stored = { configToken, latestToken: raw }
      }

      if (stored.latestToken && stored.configToken === configToken) {
        logDebug('Using persisted refresh token')
        this.usedPersistedToken = true
        return stored.latestToken
      }

      logInfo(
        'Config refresh token changed (new login), using it instead of the persisted token',
      )
    } catch {
      // File doesn't exist yet: use config token
    }
    return configToken
  }

  /**
   * Persist the refresh token to disk so it survives Homebridge restarts.
   * Ring rotates tokens periodically. If we don't persist the new one,
   * the old token in the config becomes invalid and auth fails.
   * The file contains the token, so keep it owner-readable only.
   */
  private async persistRefreshToken(token: string): Promise<void> {
    try {
      const contents: PersistedToken = {
        configToken: this.configToken,
        latestToken: token,
      }
      await writeFile(this.tokenFilePath, JSON.stringify(contents), {
        encoding: 'utf-8',
        mode: 0o600,
      })
      // writeFile only applies mode on creation; fix up pre-existing files
      await chmod(this.tokenFilePath, 0o600)
      logDebug('Persisted refresh token to storage')
    } catch (error) {
      logError(`Failed to persist refresh token: ${error}`)
    }
  }

  /** Remove the persisted token (used when auth with it fails) */
  private async clearPersistedToken(): Promise<void> {
    try {
      await unlink(this.tokenFilePath)
      logInfo('Removed persisted refresh token, falling back to the config token')
    } catch {
      // Already gone
    }
  }

  // ─── Device Discovery ──────────────────────────────────────────────────

  /**
   * Discovery orchestrator. Retries the whole run with exponential
   * backoff on failure (auth error, locations fetch error) instead of
   * leaving the plugin dead until the next Homebridge restart. If the
   * persisted token turns out to be rejected, falls back to the config
   * token once before backing off.
   */
  private async discoverDevices(
    config: RingSmokeDetectorsConfig,
  ): Promise<void> {
    let attempt = 0

    while (!this.shuttingDown) {
      try {
        await this.runDiscovery(config)
        return
      } catch (error) {
        if (this.shuttingDown) return

        if (this.usedPersistedToken && isAuthFailure(error)) {
          logWarn(
            'Authentication failed with the persisted refresh token. Retrying with the token from the config.',
          )
          await this.clearPersistedToken()
          continue
        }

        attempt++
        const delayMs = Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
          MAX_RETRY_DELAY_MS,
        )
        logError(
          `Device discovery failed: ${error}. Retrying in ${Math.round(delayMs / 1000)}s...`,
        )
        await delay(delayMs)
      }
    }
  }

  /**
   * One discovery run.
   *
   * Discovery is WebSocket-driven, NOT REST-driven:
   * 1. Fetch ALL locations from REST (just to get location IDs and names)
   * 2. For EVERY location, try a WebSocket connection via clap/tickets
   * 3. The clap/tickets response tells us if there are sensor_bluejay_* assets
   * 4. If yes, the WebSocket returns the full device list with alarm state
   * 5. If no Kidde assets at a location, we skip it gracefully
   *
   * This approach is necessary because the REST API does NOT reliably
   * list Kidde smoke detectors. They may only appear in the WebSocket.
   */
  private async runDiscovery(
    config: RingSmokeDetectorsConfig,
  ): Promise<void> {
    this.configToken = config.refreshToken

    // Use the most recent refresh token (persisted rotation chain when it
    // descends from the current config token, the config token otherwise)
    const refreshToken = await this.getRefreshToken(config.refreshToken)

    // Replace any client left over from a failed previous run
    this.client?.restClient.clearTimeouts()

    // Create authenticated REST client (handles OAuth, token refresh, etc.)
    this.client = new RestClientWrapper(refreshToken, (newToken) => {
      // Ring rotates refresh tokens periodically. Persist the new token
      // to a file so the plugin can authenticate on next restart.
      logInfo('Ring refresh token updated')
      this.persistRefreshToken(newToken)
    })

    // Fetch ALL locations. We need to probe each one via WebSocket
    // because we can't tell from the REST API which ones have Kidde devices.
    let locations = await fetchAllLocations(this.client)

    // Allow users to limit which Ring locations this plugin manages
    if (config.locationIds?.length) {
      locations = locations.filter((loc) =>
        config.locationIds!.includes(loc.location_id),
      )
    }

    if (locations.length === 0) {
      logWarn('No Ring locations found for this account.')
      return
    }

    const discoveredDeviceIds = new Set<string>()
    const failedLocations: RingLocation[] = []
    let cleanProbe = true

    for (const location of locations) {
      if (this.shuttingDown) return
      const outcome = await this.probeLocation(
        location,
        config,
        discoveredDeviceIds,
      )
      if (outcome === 'failed') {
        failedLocations.push(location)
        cleanProbe = false
      } else if (outcome === 'partial') {
        cleanProbe = false
      }
    }

    if (discoveredDeviceIds.size === 0 && cleanProbe) {
      logWarn(
        'No Kidde/Ring smoke detectors found at any location. ' +
          'Ensure your devices are set up in the Ring app and online.',
      )
    }

    // Clean up accessories for devices that no longer exist (e.g., user
    // removed a detector from their Ring account). This is DESTRUCTIVE
    // for HomeKit configuration (rooms, automations), so it only runs
    // when every location was probed successfully with a complete device
    // list. A transient outage must never masquerade as a removed device.
    if (cleanProbe) {
      this.removeStaleAccessories(discoveredDeviceIds)
    } else {
      logWarn(
        'Skipping stale accessory cleanup: some locations could not be fully probed.',
      )
    }

    // Locations that failed get their own retry schedule so a single
    // unreachable location doesn't take the rest of the plugin down.
    if (failedLocations.length > 0) {
      this.scheduleLocationRetry(failedLocations, config, discoveredDeviceIds)
    }
  }

  /**
   * Probe one location: connect the WebSocket, discover devices, create
   * accessories, and wire up real-time updates.
   *
   * Returns 'ok' when the location was fully probed (even if it has no
   * Kidde devices), 'partial' when connected but some online asset never
   * returned its device list, and 'failed' when the location could not
   * be probed at all.
   */
  private async probeLocation(
    location: RingLocation,
    config: RingSmokeDetectorsConfig,
    discoveredDeviceIds: Set<string>,
  ): Promise<ProbeOutcome> {
    try {
      const ws = new SmokeDetectorWebSocket(
        location.location_id,
        location.name,
        this.client!.restClient,
      )

      // connect() throws on failure (so we can tell "no devices" apart
      // from "could not probe") and returns 'no-assets' when the location
      // genuinely has no Kidde detectors.
      const result = await ws.connect()

      if (result === 'no-assets') {
        logDebug(
          `Location "${location.name}": no Kidde smoke detector assets found, skipping`,
        )
        ws.disconnect()
        return 'ok'
      }

      this.connections.push(ws)

      // Wait for the online assets to respond with their device data.
      // Bounded by a timeout inside getDevices() so one silent asset
      // cannot stall discovery of the remaining locations.
      const devices = await ws.getDevices()

      logInfo(
        `Location "${location.name}": discovered ${devices.length} device(s) via websocket`,
      )

      // Create HomeKit accessories for each Kidde smoke/CO device
      for (const device of devices) {
        this.handleDiscoveredDevice(device, config, discoveredDeviceIds)
      }

      // Subscribe to the full device list observable. It fires on every
      // reconnect and on every periodic keepalive poll:
      // - unknown devices get accessories (user added a detector, no
      //   Homebridge restart needed)
      // - known devices get a state re-sync (covers DataUpdates missed
      //   while an asset or the connection was down)
      ws.onDevices.subscribe({
        next: (updatedDevices) => {
          for (const device of updatedDevices) {
            const existing = this.activeAccessories.get(device.zid)
            if (existing) {
              existing.updateData(device)
            } else {
              this.handleDiscoveredDevice(device, config, discoveredDeviceIds)
            }
          }
        },
        error: (error) => {
          logError(`Device list stream error for "${location.name}": ${error}`)
        },
      })

      // Subscribe to real-time state updates from the WebSocket.
      // When a smoke alarm triggers or battery level changes, the WebSocket
      // pushes a DataUpdate message. We route it to the matching accessory
      // handler, which merges it into the known state and updates HomeKit.
      ws.onDeviceDataUpdate.subscribe({
        next: (updatedDevice) => {
          const accessory = this.activeAccessories.get(updatedDevice.zid)
          if (accessory) {
            logDebug(
              `Device update: ${updatedDevice.name} (${updatedDevice.zid})`,
            )
            accessory.updateData(updatedDevice)
          }
        },
        error: (error) => {
          logError(`Device update stream error for "${location.name}": ${error}`)
        },
      })

      return ws.isDeviceListComplete ? 'ok' : 'partial'
    } catch (error) {
      logError(
        `Failed to connect to location "${location.name}": ${error}`,
      )
      return 'failed'
    }
  }

  /** Re-probe unreachable locations with exponential backoff, forever. */
  private scheduleLocationRetry(
    locations: RingLocation[],
    config: RingSmokeDetectorsConfig,
    discoveredDeviceIds: Set<string>,
    attempt = 1,
  ): void {
    if (this.shuttingDown) return

    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    )
    logInfo(
      `Retrying ${locations.length} unreachable location(s) in ${Math.round(delayMs / 1000)}s...`,
    )

    const timer = setTimeout(async () => {
      if (this.shuttingDown) return
      const stillFailed: RingLocation[] = []
      for (const location of locations) {
        if (this.shuttingDown) return
        const outcome = await this.probeLocation(
          location,
          config,
          discoveredDeviceIds,
        )
        if (outcome === 'failed') {
          stillFailed.push(location)
        }
      }
      if (stillFailed.length > 0) {
        this.scheduleLocationRetry(
          stillFailed,
          config,
          discoveredDeviceIds,
          attempt + 1,
        )
      }
    }, delayMs)
    this.retryTimers.push(timer)
  }

  /**
   * Unregister accessories whose devices no longer exist in the Ring
   * account. Only called after a fully successful discovery run.
   */
  private removeStaleAccessories(discoveredDeviceIds: Set<string>): void {
    for (const [uuid, accessory] of this.cachedAccessories) {
      const zid = accessory.context.zid as string | undefined
      if (zid && !discoveredDeviceIds.has(zid)) {
        logInfo(`Removing stale accessory: ${accessory.displayName}`)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ])
        this.cachedAccessories.delete(uuid)
        this.activeAccessories.get(zid)?.destroy()
        this.activeAccessories.delete(zid)
      }
    }
  }

  /**
   * Process a discovered device: filter, apply config overrides, and create
   * the HomeKit accessory. Shared by initial discovery and reconnect-time
   * new device detection.
   */
  private handleDiscoveredDevice(
    device: SmokeDetectorDeviceData,
    config: RingSmokeDetectorsConfig,
    discoveredDeviceIds: Set<string>,
  ): void {
    // Skip non-Kidde devices (e.g., security-panel devices that Ring creates
    // for monitored locations; they lack burglar-alarm capability and cause
    // HomeKit errors)
    if (!isKiddeDeviceType(device.deviceType)) {
      logDebug(
        `Skipping non-Kidde device: ${device.name} (${device.deviceType})`,
      )
      return
    }

    // Allow users to hide specific devices from HomeKit via the UI
    if (config.hiddenDevices?.includes(device.zid)) {
      logDebug(`Skipping hidden device: ${device.name} (${device.zid})`)
      return
    }

    // Apply custom display name from UI settings if configured
    if (config.deviceNames?.[device.zid]) {
      device.name = config.deviceNames[device.zid]
    }

    discoveredDeviceIds.add(device.zid)
    this.setupAccessory(device)
  }

  // ─── Accessory Management ──────────────────────────────────────────────

  /**
   * Create or restore a HomeKit accessory for a discovered device.
   *
   * Device type mapping:
   * - sensor_bluejay_ws  maps to SmokeDetectorAccessory (smoke only)
   * - sensor_bluejay_wsc maps to SmokeCoDetectorAccessory (smoke + CO)
   * - sensor_bluejay_sc  maps to SmokeCoDetectorAccessory (smoke + CO, battery)
   */
  private setupAccessory(device: SmokeDetectorDeviceData): void {
    // Generate a stable UUID from the device's zid (unique identifier)
    const uuid = this.api.hap.uuid.generate(device.zid)
    const displayName = device.name || 'Smoke Detector'

    // Reuse a cached accessory if one exists (preserves HomeKit pairings)
    let accessory = this.cachedAccessories.get(uuid)
    const restoredFromCache = Boolean(accessory)

    if (accessory) {
      logDebug(`Restoring accessory from cache: ${displayName}`)
      // Apply renames from the Ring app or the plugin's deviceNames config
      // to accessories restored from cache
      if (accessory.displayName !== displayName) {
        logInfo(
          `Renaming accessory "${accessory.displayName}" to "${displayName}"`,
        )
        accessory.displayName = displayName
        accessory
          .getService(hap.Service.AccessoryInformation)
          ?.updateCharacteristic(hap.Characteristic.Name, displayName)
      }
    } else {
      logInfo(`Adding new accessory: ${displayName} (${device.deviceType})`)
      accessory = new this.api.platformAccessory(displayName, uuid)
      accessory.context.zid = device.zid
      accessory.context.deviceType = device.deviceType
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ])
      this.cachedAccessories.set(uuid, accessory)
    }

    // Store device info in the accessory context for cache restoration
    accessory.context.zid = device.zid
    accessory.context.deviceType = device.deviceType

    // Create a BehaviorSubject with the initial device data.
    // The WebSocket will push updates to this subject via updateData().
    const deviceData = new BehaviorSubject<SmokeDetectorDeviceData>(device)

    // Choose the right accessory type based on whether the device has a CO sensor
    let handler: BaseAccessory
    if (isSmokeOnly(device.deviceType)) {
      handler = new SmokeDetectorAccessory(accessory, deviceData)
    } else {
      handler = new SmokeCoDetectorAccessory(accessory, deviceData)
    }

    // Clean up any previous handler for this device (e.g., on reconnect)
    this.activeAccessories.get(device.zid)?.destroy()
    this.activeAccessories.set(device.zid, handler)

    // Persist context/name changes on cached accessories back to Homebridge
    if (restoredFromCache) {
      this.api.updatePlatformAccessories([accessory])
    }
  }

  /** Gracefully shut down all WebSocket connections and clean up subscriptions */
  private shutdown(): void {
    logInfo('Shutting down...')
    this.shuttingDown = true
    for (const timer of this.retryTimers) {
      clearTimeout(timer)
    }
    this.retryTimers.length = 0
    for (const connection of this.connections) {
      connection.disconnect()
    }
    for (const accessory of this.activeAccessories.values()) {
      accessory.destroy()
    }
    this.connections.length = 0
    this.activeAccessories.clear()
    this.client?.restClient.clearTimeouts()
  }
}
