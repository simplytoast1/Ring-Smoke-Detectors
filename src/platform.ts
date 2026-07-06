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
 * REFRESH TOKEN PERSISTENCE: Ring rotates refresh tokens periodically and the
 * tokens are effectively single-use. We write each rotated token back into
 * config.json (the single source of truth, matching homebridge-ring), so a
 * fresh token always survives restarts. The plugin is the SOLE token consumer
 * at runtime: the settings UI reads a device cache instead of authenticating,
 * so opening the settings page never rotates the token. See config-store.ts
 * and device-cache.ts.
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
import {
  updateConfigRefreshToken,
  readConfigRefreshToken,
} from './ring-api/config-store.js'
import {
  CachedDevice,
  writeDeviceCache,
} from './ring-api/device-cache.js'
import { BaseAccessory } from './accessories/base-accessory.js'
import { SmokeCoDetectorAccessory } from './accessories/smoke-co-detector.js'
import { SmokeDetectorAccessory } from './accessories/smoke-detector.js'

/** First retry delay for a failed discovery run or location probe */
const INITIAL_RETRY_DELAY_MS = 30_000
/** Cap for discovery/location retry backoff */
const MAX_RETRY_DELAY_MS = 15 * 60_000

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

  /** Path to the Homebridge storage directory (for the device cache) */
  private readonly storagePath: string

  /** REST client for the current discovery run (kept for shutdown cleanup) */
  private client: RestClientWrapper | null = null

  /** Pending retry timers, cleared on shutdown */
  private readonly retryTimers: ReturnType<typeof setTimeout>[] = []

  /**
   * All Kidde devices discovered so far, keyed by zid, for the settings-UI
   * cache. Holds every device (including hidden ones) with its raw Ring name.
   */
  private readonly discoveredForCache = new Map<string, CachedDevice>()

  /** zids seen during the current discovery run, used to prune removed devices */
  private cacheZidsThisRun = new Set<string>()

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
  //
  // config.json is the single source of truth for the refresh token, matching
  // the reference homebridge-ring plugin. On each rotation we write the new
  // token back into config.json (config-store.ts), so a fresh token always
  // survives restarts without a second file that could drift out of sync.
  //
  // The plugin is the SOLE token consumer at runtime: the settings UI reads a
  // device cache instead of authenticating, so opening the settings page never
  // rotates the token. Because Ring's tokens are effectively single-use, that
  // single-consumer property is what keeps the running plugin from being
  // knocked offline by routine settings-page use.

  /**
   * The freshest refresh token: re-read from config.json on disk so a token a
   * re-login wrote to config is picked up on the next discovery attempt. Falls
   * back to the token Homebridge parsed at startup if the file can't be read.
   */
  private getStartToken(config: RingSmokeDetectorsConfig): string {
    return readConfigRefreshToken(this.api) ?? config.refreshToken
  }

  /**
   * Persist a rotated token by replacing the old one inside config.json.
   * Wrapped so a write failure (read-only storage, permissions) is logged
   * rather than surfacing as an unhandled rejection: this runs fire-and-forget
   * from the rotation callback, and an uncaught rejection would take down the
   * child bridge on modern Node.
   */
  private persistRefreshToken(newToken: string, oldToken?: string): void {
    try {
      updateConfigRefreshToken(this.api, oldToken, newToken)
    } catch (error) {
      logError(`Failed to persist refresh token: ${error}`)
    }
  }

  // ─── Device Discovery ──────────────────────────────────────────────────

  /**
   * Discovery orchestrator. Retries the whole run with exponential backoff on
   * failure instead of leaving the plugin dead until the next restart. Each
   * attempt re-reads the token from config.json, so a token written by a
   * re-login is picked up automatically. A definitive auth failure logs a
   * clear re-authenticate message and keeps retrying slowly.
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

        if (isAuthFailure(error)) {
          // The token was rejected. A re-login writes a new token to config,
          // which the next attempt re-reads. Until then, keep retrying slowly.
          logError(
            'Ring authentication failed. Your session may have been revoked or the token expired. ' +
              'Open the plugin settings and click Re-authenticate.',
          )
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
    // Start from the freshest token in config.json (re-read each attempt so a
    // re-login is picked up without a restart).
    const refreshToken = this.getStartToken(config)

    // Track which devices this run sees, so a clean run can prune the cache
    this.cacheZidsThisRun = new Set()

    // Replace any client left over from a failed previous run
    this.client?.restClient.clearTimeouts()

    // Create authenticated REST client (handles OAuth, token refresh, etc.).
    this.client = new RestClientWrapper(refreshToken, (newToken, oldToken) => {
      // Ring rotates refresh tokens periodically. Write the new token back
      // into config.json so it survives restarts.
      logInfo('Ring refresh token updated')
      this.persistRefreshToken(newToken, oldToken)
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
      this.pruneDeviceCache()
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

      // Publish to the settings-UI cache BEFORE creating accessories, since
      // handleDiscoveredDevice mutates device.name with the user's override
      // and the cache needs the raw Ring name.
      this.updateDeviceCache(devices, location.name)

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
          this.updateDeviceCache(updatedDevices, location.name)
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
   * Update the settings-UI device cache with the devices from one location.
   * Includes every Kidde device (hidden ones too, so the UI can show them)
   * with its raw Ring name. Writes the file only when something changed, so
   * routine reconnect polls don't churn the disk. Must be called with raw
   * device data before handleDiscoveredDevice applies the name override.
   */
  private updateDeviceCache(
    devices: SmokeDetectorDeviceData[],
    locationName: string,
  ): void {
    let changed = false
    for (const device of devices) {
      if (!isKiddeDeviceType(device.deviceType) || !device.zid) continue
      this.cacheZidsThisRun.add(device.zid)
      const entry: CachedDevice = {
        zid: device.zid,
        name: device.name || 'Smoke Detector',
        deviceType: device.deviceType,
        locationName,
        batteryLevel: device.batteryLevel,
        batteryStatus: device.batteryStatus,
      }
      const prev = this.discoveredForCache.get(device.zid)
      if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
        this.discoveredForCache.set(device.zid, entry)
        changed = true
      }
    }
    if (changed) this.writeCache()
  }

  /**
   * After a fully successful discovery run, drop cache entries for devices
   * that were not seen this run (removed from the Ring account). Guarded on a
   * clean run by the caller so a transient outage never wipes valid entries.
   */
  private pruneDeviceCache(): void {
    let changed = false
    for (const zid of this.discoveredForCache.keys()) {
      if (!this.cacheZidsThisRun.has(zid)) {
        this.discoveredForCache.delete(zid)
        changed = true
      }
    }
    if (changed) this.writeCache()
  }

  private writeCache(): void {
    writeDeviceCache(this.storagePath, [
      ...this.discoveredForCache.values(),
    ]).catch((error) => logError(`Failed to write device cache: ${error}`))
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

    // Apply the custom display name (if any) on a shallow copy rather than
    // mutating the shared device object, so the device cache keeps the raw
    // Ring name regardless of call ordering.
    const override = config.deviceNames?.[device.zid]
    const forAccessory = override ? { ...device, name: override } : device

    discoveredDeviceIds.add(device.zid)
    this.setupAccessory(forAccessory)
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
