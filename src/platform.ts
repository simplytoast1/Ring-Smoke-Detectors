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
 * REFRESH TOKEN PERSISTENCE: Ring rotates refresh tokens periodically.
 * We persist the latest token to a file in the Homebridge storage directory
 * so it survives restarts. On startup we check for a persisted token first,
 * falling back to the one in the Homebridge config.
 *
 * NEW DEVICE DETECTION: When the WebSocket reconnects (after disconnection
 * or server-initiated reconnect), it re-requests a fresh ticket which may
 * include new assets. We subscribe to onDevices (not just onDeviceDataUpdate)
 * so newly discovered devices get HomeKit accessories automatically.
 */

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BehaviorSubject } from 'rxjs'
import { hap } from './hap.js'
import {
  RingSmokeDetectorsConfig,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './config.js'
import { setLogger, logInfo, logWarn, logError, logDebug } from './util.js'
import { RestClientWrapper } from './ring-api/rest-client-wrapper.js'
import { fetchAllLocations } from './ring-api/smoke-detector-api.js'
import { SmokeDetectorWebSocket } from './ring-api/websocket-connection.js'
import {
  SmokeDetectorDeviceData,
  KiddeDeviceType,
  isKiddeDeviceType,
  isSmokeOnly,
} from './ring-api/types.js'
import { BaseAccessory } from './accessories/base-accessory.js'
import { SmokeCoDetectorAccessory } from './accessories/smoke-co-detector.js'
import { SmokeDetectorAccessory } from './accessories/smoke-detector.js'

/** Filename for persisting the refresh token across restarts */
const TOKEN_FILE = 'ring-smoke-detectors.token'

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

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    setLogger(log)
    this.storagePath = api.user.storagePath()

    const pluginConfig = config as RingSmokeDetectorsConfig

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

  /**
   * Get the most recent refresh token: check the persisted file first
   * (it may have been rotated since the config was written), then fall
   * back to the config value.
   */
  private async getRefreshToken(
    configToken: string,
  ): Promise<string> {
    try {
      const tokenPath = join(this.storagePath, TOKEN_FILE)
      const persisted = await readFile(tokenPath, 'utf-8')
      if (persisted.trim()) {
        logDebug('Using persisted refresh token')
        return persisted.trim()
      }
    } catch {
      // File doesn't exist yet — use config token
    }
    return configToken
  }

  /**
   * Persist the refresh token to disk so it survives Homebridge restarts.
   * Ring rotates tokens periodically — if we don't persist the new one,
   * the old token in the config becomes invalid and auth fails.
   */
  private async persistRefreshToken(token: string): Promise<void> {
    try {
      const tokenPath = join(this.storagePath, TOKEN_FILE)
      await writeFile(tokenPath, token, 'utf-8')
      logDebug('Persisted refresh token to storage')
    } catch (error) {
      logError(`Failed to persist refresh token: ${error}`)
    }
  }

  // ─── Device Discovery ──────────────────────────────────────────────────

  /**
   * Main discovery flow — called once Homebridge is ready.
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
  private async discoverDevices(
    config: RingSmokeDetectorsConfig,
  ): Promise<void> {
    // Use the most recent refresh token (persisted file takes priority
    // over config, since Ring may have rotated the token since last config save)
    const refreshToken = await this.getRefreshToken(config.refreshToken)

    // Create authenticated REST client (handles OAuth, token refresh, etc.)
    const client = new RestClientWrapper(
      refreshToken,
      (newToken) => {
        // Ring rotates refresh tokens periodically. Persist the new token
        // to a file so the plugin can authenticate on next restart.
        logInfo('Ring refresh token updated')
        this.persistRefreshToken(newToken)
      },
    )

    // Fetch ALL locations — we need to probe each one via WebSocket
    // because we can't tell from the REST API which ones have Kidde devices
    let locations = await fetchAllLocations(client)

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

    // For EVERY location, attempt a WebSocket connection.
    // The SmokeDetectorWebSocket class will:
    // 1. Request a ticket from clap/tickets
    // 2. Check if the response includes sensor_bluejay_* assets
    // 3. If yes: connect and request device data
    // 4. If no: log a debug message and return (no error)
    //
    // This is the ONLY reliable way to discover Kidde devices — they
    // may not appear in the REST API at all.
    const discoveredDeviceIds = new Set<string>()
    let totalDevicesFound = 0

    for (const location of locations) {
      try {
        const ws = new SmokeDetectorWebSocket(
          location.location_id,
          location.name,
          client.restClient,
        )

        // Connect to the WebSocket. If no Kidde assets exist at this location,
        // connect() returns early without error — it just logs a debug message.
        await ws.connect()

        // If the WebSocket found Kidde assets and is connected, get the device list
        if (!ws.hasAssets) {
          logDebug(
            `Location "${location.name}": no Kidde smoke detector assets found, skipping`,
          )
          ws.disconnect()
          continue
        }

        this.connections.push(ws)

        // Wait for all assets to respond with their device data.
        // This returns the complete list of devices at this location
        // with their current alarm state (smoke, CO, battery, etc.).
        const devices = await ws.getDevices()

        logInfo(
          `Location "${location.name}": discovered ${devices.length} device(s) via websocket`,
        )

        // Create HomeKit accessories for each Kidde smoke/CO device
        for (const device of devices) {
          this.handleDiscoveredDevice(device, config, discoveredDeviceIds)
          if (discoveredDeviceIds.has(device.zid)) totalDevicesFound++
        }

        // Subscribe to the full device list observable — this fires on EVERY
        // reconnect (not just the initial connection). When the WebSocket
        // reconnects, it re-requests a fresh ticket which may include new
        // assets if the user added a device. This ensures new devices get
        // HomeKit accessories without requiring a Homebridge restart.
        ws.onDevices.subscribe((updatedDevices) => {
          for (const device of updatedDevices) {
            if (!this.activeAccessories.has(device.zid)) {
              logInfo(
                `New device detected: ${device.name} (${device.deviceType})`,
              )
              this.handleDiscoveredDevice(device, config, discoveredDeviceIds)
            }
          }
        })

        // Subscribe to real-time state updates from the WebSocket.
        // When a smoke alarm triggers or battery level changes, the WebSocket
        // pushes a DataUpdate message. We route it to the matching accessory
        // handler, which updates the HomeKit characteristics.
        ws.onDeviceDataUpdate.subscribe((updatedDevice) => {
          const accessory = this.activeAccessories.get(updatedDevice.zid)
          if (accessory) {
            logDebug(
              `Device update: ${updatedDevice.name} (${updatedDevice.zid})`,
            )
            accessory.updateData(updatedDevice)
          }
        })
      } catch (error) {
        logError(
          `Failed to connect to location "${location.name}": ${error}`,
        )
      }
    }

    if (totalDevicesFound === 0) {
      logWarn(
        'No Kidde/Ring smoke detectors found at any location. ' +
          'Ensure your devices are set up in the Ring app and online.',
      )
    }

    // Clean up accessories for devices that no longer exist
    // (e.g., user removed a detector from their Ring account)
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
   * Process a discovered device — filter, apply config overrides, and create
   * the HomeKit accessory. Shared by initial discovery and reconnect-time
   * new device detection.
   */
  private handleDiscoveredDevice(
    device: SmokeDetectorDeviceData,
    config: RingSmokeDetectorsConfig,
    discoveredDeviceIds: Set<string>,
  ): void {
    // Skip non-Kidde devices (e.g., security-panel devices that Ring creates
    // for monitored locations — they lack burglar-alarm capability and cause
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
   * - sensor_bluejay_ws  → SmokeDetectorAccessory (smoke only)
   * - sensor_bluejay_wsc → SmokeCoDetectorAccessory (smoke + CO)
   * - sensor_bluejay_sc  → SmokeCoDetectorAccessory (smoke + CO, battery)
   */
  private setupAccessory(device: SmokeDetectorDeviceData): void {
    // Generate a stable UUID from the device's zid (unique identifier)
    const uuid = this.api.hap.uuid.generate(device.zid)
    const displayName = device.name || 'Smoke Detector'

    // Reuse a cached accessory if one exists (preserves HomeKit pairings)
    let accessory = this.cachedAccessories.get(uuid)

    if (accessory) {
      logDebug(`Restoring accessory from cache: ${displayName}`)
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
  }

  /** Gracefully shut down all WebSocket connections and clean up subscriptions */
  private shutdown(): void {
    logInfo('Shutting down...')
    for (const connection of this.connections) {
      connection.disconnect()
    }
    for (const accessory of this.activeAccessories.values()) {
      accessory.destroy()
    }
    this.connections.length = 0
    this.activeAccessories.clear()
  }
}
