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
import { RingAuthError } from './ring-api/ring-rest-client.js'
import { fetchAllLocations } from './ring-api/smoke-detector-api.js'
import { SmokeDetectorWebSocket } from './ring-api/websocket-connection.js'
import {
  SmokeDetectorDeviceData,
  RingLocation,
  isKiddeDeviceType,
  isSmokeOnly,
  IMPULSE_ALARM_TESTING,
} from './ring-api/types.js'
import {
  updateConfigRefreshToken,
  readConfigRefreshToken,
} from './ring-api/config-store.js'
import {
  CachedDevice,
  writeDeviceCache,
} from './ring-api/device-cache.js'
import {
  BaseAccessory,
  type AvailabilitySource,
} from './accessories/base-accessory.js'
import { SmokeCoDetectorAccessory } from './accessories/smoke-co-detector.js'
import { SmokeDetectorAccessory } from './accessories/smoke-detector.js'

/** First retry delay for a failed discovery run or location probe */
const INITIAL_RETRY_DELAY_MS = 30_000
/** Cap for discovery/location retry backoff */
const MAX_RETRY_DELAY_MS = 15 * 60_000

/** How often to re-probe locations that have no live connection */
const REDISCOVERY_INTERVAL_MS = 60 * 60_000

/** Window in which repeated test-button signals collapse into one log line */
const TEST_EVENT_DEDUPE_MS = 30_000

/** Outcome of probing one location */
type ProbeOutcome = 'ok' | 'partial' | 'failed'

/**
 * True when an error is a definitive auth rejection (not transient).
 * The REST client raises a typed error for this, so there is no need to
 * match on message text.
 */
function isAuthFailure(error: unknown): boolean {
  return error instanceof RingAuthError
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

  /**
   * Active WebSocket connections, keyed by location id. A connection stays
   * here while it reconnects internally, so rediscovery knows not to open a
   * second socket for the same location.
   */
  private readonly connections = new Map<string, SmokeDetectorWebSocket>()

  /** Location ids that could not be probed on the last pass */
  private failedLocationIds = new Set<string>()

  /** Device zids known per location, so connected locations stay accounted for */
  private readonly locationDeviceIds = new Map<string, Set<string>>()

  /** Guards against overlapping discovery passes */
  private discoveryRunning = false

  /** Periodic rediscovery timer */
  private rediscoveryTimer: ReturnType<typeof setInterval> | null = null

  /** zid to timestamp of the last logged test-button press (dedupe) */
  private readonly lastTestEvent = new Map<string, number>()

  /** When the last rediscovery pass started, for throttling */
  private lastRediscoveryAt = 0

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
      // Accessories restored from cache would otherwise keep answering with
      // last session's values, so a detector this plugin cannot reach would
      // still read as "no smoke".
      api.on('didFinishLaunching', () => {
        this.markUnhandledAccessoriesUnavailable()
      })
      return
    }

    // Wait for Homebridge to finish loading all plugins before we start
    // making network requests and creating accessories
    api.on('didFinishLaunching', () => {
      // Homebridge restores cached characteristic VALUES but not their error
      // state, so a restored detector answers HomeKit with the previous
      // session's reading until a live handler takes over. Start them all in
      // the not-responding state; discovery clears it as devices come up.
      this.markUnhandledAccessoriesUnavailable()

      this.discoverDevices(pluginConfig).catch((error) => {
        logError(`Device discovery failed: ${error}`)
      })
      this.startRediscovery(pluginConfig)
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

  /**
   * The shared REST client, created once and reused.
   *
   * Creating a second client would be actively harmful: Ring's refresh
   * tokens are single-use, so two clients rotating in parallel double-spend
   * one token and invalidate the other's. Existing websockets also hold a
   * reference to this client, so it must outlive individual discovery runs.
   */
  private ensureClient(config: RingSmokeDetectorsConfig): RestClientWrapper {
    if (this.client) return this.client

    // Start from the freshest token in config.json, so a re-login is picked
    // up without a restart.
    const refreshToken = this.getStartToken(config)
    this.client = new RestClientWrapper(refreshToken, (newToken, oldToken) => {
      // Ring rotates refresh tokens periodically. Write the new token back
      // into config.json so it survives restarts.
      logInfo('Ring refresh token updated')
      this.persistRefreshToken(newToken, oldToken)
    })
    return this.client
  }

  /**
   * Drop the REST client so the next discovery attempt rebuilds it from the
   * current config.json token. Used after a definitive auth rejection, which
   * is the one case where the in-memory token chain is worth abandoning.
   */
  private resetClient(): void {
    this.client?.restClient.clearTimeouts()
    this.client = null

    // Every live websocket captured the discarded client, so it can never
    // authenticate again. Tear them down and forget the locations; the next
    // discovery pass rebuilds them against the new client. Without this the
    // locations stay in `connections`, are skipped by every future pass, and
    // never recover even after the user re-authenticates.
    for (const connection of this.connections.values()) {
      connection.disconnect()
    }
    this.connections.clear()
    this.locationDeviceIds.clear()
    this.failedLocationIds.clear()
    for (const handler of this.activeAccessories.values()) {
      handler.destroy()
    }
    this.activeAccessories.clear()
    this.markUnhandledAccessoriesUnavailable()
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

    // Held for the WHOLE loop, including the backoff sleep. Releasing it
    // during the sleep would let a rediscovery pass run concurrently, and
    // because probeLocation only records a connection after connect()
    // resolves, that yields two websockets for the same location.
    this.discoveryRunning = true
    try {
      while (!this.shuttingDown) {
        try {
          await this.runDiscovery(config)
          return
        } catch (error) {
          if (this.shuttingDown) return

          if (isAuthFailure(error)) {
            // The token was rejected. A re-login writes a new token to
            // config; dropping the client makes the next attempt pick it up.
            // Until then, keep retrying slowly.
            logError(
              'Ring authentication failed. Your session may have been revoked or the token expired. ' +
                'Open the plugin settings and click Re-authenticate.',
            )
            this.resetClient()
          }

          // Discovery did not complete, so any cached accessory without a
          // live handler is reporting stale state. Mark it unavailable.
          this.markUnhandledAccessoriesUnavailable()

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
    } finally {
      this.discoveryRunning = false
    }
  }

  // ─── Rediscovery ───────────────────────────────────────────────────────

  /**
   * Periodically re-probe locations that have no live connection.
   *
   * This is how a detector added after startup gets picked up: a location
   * that reported zero Kidde assets is not kept as a connection, so without
   * a periodic re-probe its first detector would stay invisible until
   * Homebridge restarted. It also retries locations that could not be
   * reached, and the locations fetch re-exercises auth so a revoked token
   * surfaces as an actionable message.
   */
  private startRediscovery(config: RingSmokeDetectorsConfig): void {
    this.rediscoveryTimer = setInterval(() => {
      void this.requestRediscovery(config, 'periodic check')
    }, REDISCOVERY_INTERVAL_MS)
  }

  /**
   * Run a discovery pass unless one is already in flight.
   *
   * throttleMs skips the pass if one ran recently, so a flapping connection
   * cannot turn every drop into another round of Ring API calls.
   */
  private async requestRediscovery(
    config: RingSmokeDetectorsConfig,
    reason: string,
    throttleMs = 0,
  ): Promise<void> {
    if (this.shuttingDown || this.discoveryRunning) return
    if (
      throttleMs > 0 &&
      Date.now() - this.lastRediscoveryAt < throttleMs
    ) {
      return
    }
    this.lastRediscoveryAt = Date.now()
    this.discoveryRunning = true
    logDebug(`Running device rediscovery (${reason})`)
    try {
      await this.runDiscovery(config)
    } catch (error) {
      if (isAuthFailure(error)) {
        logError(
          'Ring authentication failed. Your session may have been revoked or the token expired. ' +
            'Open the plugin settings and click Re-authenticate.',
        )
        this.resetClient()
      } else {
        logDebug(`Rediscovery failed: ${error}`)
      }
    } finally {
      this.discoveryRunning = false
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
    // Track which devices this run sees, so a clean run can prune the cache
    this.cacheZidsThisRun = new Set()

    const client = this.ensureClient(config)

    // Fetch ALL locations. We need to probe each one via WebSocket
    // because we can't tell from the REST API which ones have Kidde devices.
    // This call also exercises authentication, so a revoked token surfaces
    // here as a RingAuthError even when every location is already connected.
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

    const discoveredDeviceIds = new Set<string>()
    const failedLocations: RingLocation[] = []
    let cleanProbe = true
    /** True only when every location was actually enumerated this pass */
    let fullyProbed = true

    for (const location of locations) {
      if (this.shuttingDown) return

      // Already connected (or reconnecting internally): leave the socket
      // alone, but carry its known devices forward so they are not mistaken
      // for removed ones. Treating this as "unclean" instead would make
      // stale cleanup dead code after the first pass, since a connected
      // location is never re-probed.
      const existing = this.connections.get(location.location_id)
      if (existing) {
        const known = this.locationDeviceIds.get(location.location_id)
        known?.forEach((zid) => discoveredDeviceIds.add(zid))
        // This location's devices were not re-enumerated this pass, so the
        // settings-UI cache has no fresh evidence for them and must not be
        // pruned against this run.
        fullyProbed = false
        // Only trustworthy while the socket is actually up with a full list
        if (!existing.connected || !existing.isDeviceListComplete) {
          cleanProbe = false
        }
        continue
      }

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
      // Pruning the settings-UI cache needs a pass that re-enumerated every
      // location; otherwise skipped locations look like they have no devices
      // and the whole cache gets emptied.
      if (fullyProbed) this.pruneDeviceCache()
    } else {
      logWarn(
        'Skipping stale accessory cleanup: some locations could not be fully probed.',
      )
    }

    // Any accessory left without a live handler belongs to a location we
    // could not reach, so it must not keep reporting its last known state.
    this.markUnhandledAccessoriesUnavailable()

    // Locations that failed get a faster retry than the hourly rediscovery,
    // so a single unreachable location doesn't hold the plugin back.
    const hadFailures = this.failedLocationIds.size > 0
    this.failedLocationIds = new Set(
      failedLocations.map((l) => l.location_id),
    )
    if (this.failedLocationIds.size > 0 && !hadFailures) {
      this.scheduleLocationRetry(config)
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
        this.ensureClient(config).restClient,
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
        // If THIS location previously had detectors, an empty asset list is
        // far more likely to be transient (Ring hiccup, detectors rebooting)
        // than the user having deleted them, so report an incomplete probe
        // and leave the existing accessories alone. Judged per location: a
        // location that genuinely has no Kidde devices must still count as a
        // clean probe, or cleanup would never run again on that account.
        return this.locationHadDevices(location.location_id) ? 'partial' : 'ok'
      }

      this.connections.set(location.location_id, ws)

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
      const known = new Set<string>()
      this.locationDeviceIds.set(location.location_id, known)
      for (const device of devices) {
        const before = discoveredDeviceIds.size
        this.handleDiscoveredDevice(device, config, discoveredDeviceIds, ws)
        // Record what this location owns (hidden/non-Kidde devices are
        // skipped by handleDiscoveredDevice and stay out of both sets)
        if (discoveredDeviceIds.size > before) known.add(device.zid)
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
          // Keep the per-location zid set current. A device discovered here
          // (rather than during the initial probe) must be recorded, or the
          // next cleanup pass would treat it as removed, unregister it, and
          // re-add it as a brand new accessory: the user would silently lose
          // its room, name and automations, once an hour.
          const knownNow =
            this.locationDeviceIds.get(location.location_id) ??
            new Set<string>()
          this.locationDeviceIds.set(location.location_id, knownNow)
          for (const device of updatedDevices) {
            const existing = this.activeAccessories.get(device.zid)
            if (existing) {
              knownNow.add(device.zid)
              // Merge, never replace: this document is the websocket's own
              // accumulation of poll responses and does not include alarm
              // deltas from the DataUpdate channel, so replacing could clear
              // an alarm that is still active.
              existing.updateData(device)
            } else {
              const before = discoveredDeviceIds.size
              this.handleDiscoveredDevice(
                device,
                config,
                discoveredDeviceIds,
                ws,
                location.location_id,
              )
              // Only track devices that actually became accessories; hidden
              // and non-Kidde devices are skipped and must stay untracked.
              if (discoveredDeviceIds.size > before) knownNow.add(device.zid)
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
            const previous = accessory.currentData
            accessory.updateData(updatedDevice)
            this.checkTestSignals(
              updatedDevice.zid,
              previous,
              accessory.currentData,
            )
          }
        },
        error: (error) => {
          logError(`Device update stream error for "${location.name}": ${error}`)
        },
      })

      // One-shot events, such as the physical test button being pressed.
      ws.onImpulse.subscribe({
        next: ({ zid, impulseTypes }) => {
          if (
            impulseTypes.some((t) => t.startsWith(IMPULSE_ALARM_TESTING))
          ) {
            this.noteTestButton(zid, `impulse ${impulseTypes.join(', ')}`)
          }
        },
        error: (error) => {
          logError(`Impulse stream error for "${location.name}": ${error}`)
        },
      })

      // A dropped connection can mean the token was revoked. The websocket
      // retries on its own, but only a REST call re-exercises auth, so kick
      // a discovery pass to surface an actionable message (and pick up a
      // token a re-login may have written) instead of reconnecting forever.
      ws.onConnected.subscribe({
        next: (connected) => {
          if (!connected && !this.shuttingDown) {
            logWarn(
              `Connection to "${location.name}" is down; its detectors report ` +
                'as not responding in HomeKit until it is back.',
            )
            void this.requestRediscovery(config, 'connection lost', 60_000)
          }
        },
      })

      return ws.isDeviceListComplete ? 'ok' : 'partial'
    } catch (error) {
      // A definitive auth rejection is not a per-location problem: let it
      // reach the caller so the client is rebuilt and the user gets the
      // actionable re-authenticate message once, instead of every location
      // silently failing and starting a doomed reconnect loop.
      this.dropConnection(location.location_id)
      if (isAuthFailure(error)) {
        throw error
      }
      logError(
        `Failed to connect to location "${location.name}": ${error}`,
      )
      return 'failed'
    }
  }

  /** Whether this location is known to have had detectors before */
  private locationHadDevices(locationId: string): boolean {
    if ((this.locationDeviceIds.get(locationId)?.size ?? 0) > 0) return true
    for (const accessory of this.cachedAccessories.values()) {
      if (accessory.context.locationId === locationId) return true
    }
    return false
  }

  /**
   * Forget a location's connection so a later pass re-probes it. Used when a
   * probe fails partway: leaving a half-built entry in `connections` would
   * make every future rediscovery skip that location for good.
   */
  private dropConnection(locationId: string): void {
    const ws = this.connections.get(locationId)
    if (!ws) return
    this.connections.delete(locationId)

    // Tear down this location's accessory handlers too. disconnect()
    // completes the connection subject without emitting false, so leaving
    // the handlers in place would keep them reporting "available" (and
    // therefore serving the last known reading) for a location we have
    // given up on.
    for (const zid of this.locationDeviceIds.get(locationId) ?? []) {
      this.activeAccessories.get(zid)?.destroy()
      this.activeAccessories.delete(zid)
    }
    this.locationDeviceIds.delete(locationId)

    try {
      ws.disconnect()
    } catch {
      // best effort
    }
    this.markUnhandledAccessoriesUnavailable()
  }

  /** Re-probe unreachable locations with exponential backoff, forever. */
  private scheduleLocationRetry(
    config: RingSmokeDetectorsConfig,
    attempt = 1,
  ): void {
    if (this.shuttingDown) return

    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    )
    logInfo(
      `Retrying ${this.failedLocationIds.size} unreachable location(s) in ${Math.round(delayMs / 1000)}s...`,
    )

    const timer = setTimeout(async () => {
      if (this.shuttingDown) return
      // Route through the shared entry point so a retry can never run
      // alongside a rediscovery pass and open a second socket per location.
      await this.requestRediscovery(config, 'retrying unreachable locations')
      if (!this.shuttingDown && this.failedLocationIds.size > 0) {
        this.scheduleLocationRetry(config, attempt + 1)
      }
    }, delayMs)
    this.retryTimers.push(timer)
  }

  /**
   * Unregister accessories whose devices no longer exist in the Ring
   * account. Only called after a fully successful discovery run.
   */
  private removeStaleAccessories(discoveredDeviceIds: Set<string>): void {
    // Floor guard: a run that found nothing is never trusted to mean "the
    // user deleted every detector". Ring transiently reports an empty asset
    // list (detectors rebooting after a power cut is the common case), and
    // unregistering everything destroys the user's rooms and automations.
    if (discoveredDeviceIds.size === 0 && this.cachedAccessories.size > 0) {
      logWarn(
        'Discovery returned no devices; keeping existing accessories rather than removing them.',
      )
      return
    }

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
    availability?: AvailabilitySource,
    locationId?: string,
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
    this.setupAccessory(forAccessory, availability, locationId)
  }

  /**
   * Note a test-button press, collapsing the several signals a single press
   * can produce (an impulse plus component updates) into one log line.
   */
  private noteTestButton(zid: string, source: string): void {
    const now = Date.now()
    const last = this.lastTestEvent.get(zid)
    if (last !== undefined && now - last < TEST_EVENT_DEDUPE_MS) return
    this.lastTestEvent.set(zid, now)

    const name =
      this.activeAccessories.get(zid)?.currentData.name ?? 'unknown device'
    logInfo(`Test button pressed on ${name} (${zid}) via ${source}`)
  }

  /**
   * Detect a test-button press from component state changes.
   *
   * pushToTest is confirmed to idle at "inactive" on real hardware; the
   * active value has never been captured publicly, so any other status
   * counts as a test press.
   */
  private checkTestSignals(
    zid: string,
    previous: SmokeDetectorDeviceData,
    current: SmokeDetectorDeviceData,
  ): void {
    const before = previous.components?.pushToTest?.status
    const after = current.components?.pushToTest?.status
    if (after !== undefined && after !== 'inactive' && after !== before) {
      this.noteTestButton(zid, `pushToTest status "${after}"`)
    }
  }

  /**
   * Mark cached accessories that have no live handler as not responding.
   *
   * Without this, an accessory restored from cache when discovery never
   * succeeded keeps serving its last stored characteristic values, so a
   * detector the plugin cannot reach still reads as "no smoke".
   */
  private markUnhandledAccessoriesUnavailable(): void {
    for (const accessory of this.cachedAccessories.values()) {
      const zid = accessory.context.zid as string | undefined
      if (zid && this.activeAccessories.has(zid)) continue

      for (const service of accessory.services) {
        if (service.UUID === hap.Service.AccessoryInformation.UUID) continue
        for (const characteristic of service.characteristics) {
          if (characteristic.UUID === hap.Characteristic.Name.UUID) continue
          characteristic.updateValue(
            new Error('Ring connection unavailable for this detector'),
          )
        }
      }
    }
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
  private setupAccessory(
    device: SmokeDetectorDeviceData,
    availability?: AvailabilitySource,
    locationId?: string,
  ): void {
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

    // Store device info in the accessory context for cache restoration.
    // locationId lets a later run tell which location an accessory belongs
    // to, so an empty result at one location cannot be judged using
    // accessories that live somewhere else.
    accessory.context.zid = device.zid
    accessory.context.deviceType = device.deviceType
    if (locationId) accessory.context.locationId = locationId

    // Create a BehaviorSubject with the initial device data.
    // The WebSocket will push updates to this subject via updateData().
    const deviceData = new BehaviorSubject<SmokeDetectorDeviceData>(device)

    // Choose the right accessory type based on whether the device has a CO sensor
    let handler: BaseAccessory
    if (isSmokeOnly(device.deviceType)) {
      handler = new SmokeDetectorAccessory(accessory, deviceData, availability)
    } else {
      handler = new SmokeCoDetectorAccessory(accessory, deviceData, availability)
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
    if (this.rediscoveryTimer) {
      clearInterval(this.rediscoveryTimer)
      this.rediscoveryTimer = null
    }
    for (const connection of this.connections.values()) {
      connection.disconnect()
    }
    for (const accessory of this.activeAccessories.values()) {
      accessory.destroy()
    }
    this.connections.clear()
    this.activeAccessories.clear()
    this.client?.restClient.clearTimeouts()
  }
}
