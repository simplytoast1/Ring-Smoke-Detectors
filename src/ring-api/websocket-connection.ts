/**
 * Custom WebSocket Connection for Kidde/Ring Smoke Detectors
 *
 * THIS IS THE CORE OF THE PLUGIN, the key innovation that makes hubless
 * Kidde smoke detectors work with HomeKit.
 *
 * Background (from https://github.com/dgreif/ring/issues/1674):
 *
 * The existing ring-client-api library only creates WebSocket connections
 * when a location has a Ring hub (base_station or beams_bridge). The library's
 * isWebSocketSupportedAsset() function filters out everything except
 * base_station* and beams_bridge* asset kinds. And the Location.getConnection()
 * method refuses to connect at all if hasHubs is false.
 *
 * However, @tsightler discovered that the clap/tickets endpoint DOES return
 * sensor_bluejay_* assets even for hubless locations. And when you connect
 * to the WebSocket and send DeviceInfoDocGetList for those assets, you get
 * back the full device data including real-time alarm state. @jbettcher
 * confirmed this with a working prototype.
 *
 * This class reimplements the WebSocket connection logic from ring-client-api's
 * Location.createConnection(), with two critical changes:
 * 1. We accept sensor_bluejay_* assets (not just base_station/beams_bridge)
 * 2. We don't require a hub to exist before connecting
 *
 * The WebSocket protocol is identical to what ring-client-api uses:
 * - Request ticket from clap/tickets endpoint
 * - Connect to wss://{host}/ws?authcode={ticket}&ack=false
 * - Send DeviceInfoDocGetList for each asset UUID
 * - Receive device data and state updates
 *
 * RELIABILITY: this connection must stay healthy for months. Three mechanisms
 * keep it that way:
 * - Periodic polling: every POLL_INTERVAL_MS we re-request the device list
 *   from every asset. This doubles as a keepalive and as a state re-sync in
 *   case a DataUpdate was missed (e.g. an asset was briefly offline).
 * - Watchdog: if no message of any kind arrives within STALE_CONNECTION_MS,
 *   the connection is assumed half-open (dead TCP without a close event) and
 *   is forcibly reconnected.
 * - Reconnect with jittered exponential backoff that never gives up. A
 *   transiently empty asset list during reconnect is retried, not treated
 *   as "no devices".
 */

import { WebSocket } from 'undici'
import {
  Subject,
  BehaviorSubject,
  Observable,
  firstValueFrom,
  of,
} from 'rxjs'
import {
  filter,
  map,
  scan,
  distinctUntilChanged,
  concatMap,
  shareReplay,
  timeout,
  catchError,
} from 'rxjs/operators'
import type { RingRestClient } from './ring-rest-client.js'
import { appApi } from './ring-rest-client.js'
import {
  TicketResponse,
  TicketAsset,
  SocketIoMessage,
  SmokeDetectorDeviceData,
  isKiddeAsset,
  flattenDeviceData,
} from './types.js'
import { logInfo, logWarn, logError, logDebug, delay } from '../util.js'

/** Max delay between reconnection attempts (caps exponential backoff) */
const MAX_RECONNECT_DELAY_MS = 60_000
/** Initial delay before first reconnection attempt */
const INITIAL_RECONNECT_DELAY_MS = 5_000
/** How often to poll assets for their device list (keepalive + state re-sync) */
const POLL_INTERVAL_MS = 60_000
/** How often the watchdog checks for a stale connection */
const WATCHDOG_INTERVAL_MS = 30_000
/**
 * If no message arrives within this window despite polling, the TCP
 * connection is considered half-open and gets forcibly reconnected.
 */
const STALE_CONNECTION_MS = 180_000
/** How long getDevices() waits before settling with whatever it has */
const GET_DEVICES_TIMEOUT_MS = 20_000

/** Outcome of a connection attempt */
export type ConnectResult = 'connected' | 'no-assets'

export class SmokeDetectorWebSocket {
  /**
   * Internal subjects for routing WebSocket messages.
   * onMessage receives ALL messages; onDataUpdate receives only DataUpdate channel messages.
   */
  private onMessage = new Subject<SocketIoMessage>()
  private onDataUpdate = new Subject<SocketIoMessage>()
  private onConnectedSubject = new BehaviorSubject<boolean>(false)

  /** Observable that emits true/false when connection status changes */
  public readonly onConnected: Observable<boolean> =
    this.onConnectedSubject.asObservable()

  /**
   * Observable that emits individual device data updates in real-time.
   * These arrive on the WebSocket's "DataUpdate" channel whenever a device's
   * state changes (e.g., smoke alarm triggered, battery level changed).
   *
   * NOTE: DataUpdate payloads are PARTIAL. Consumers must merge them into
   * previously known device state (BaseAccessory.updateData does this).
   */
  public readonly onDeviceDataUpdate: Observable<SmokeDetectorDeviceData>

  /**
   * Observable that emits the complete accumulated device list.
   * Emits once every asset has responded to DeviceInfoDocGetList. An asset
   * that never answers is bounded by the timeout in getDevices() rather
   * than by pre-filtering on ticket status (Ring's status is not a
   * reliable predictor of whether an asset will respond).
   */
  public readonly onDevices: Observable<SmokeDetectorDeviceData[]>

  /** Assets from the ticket response that we're tracking */
  private assets: TicketAsset[] = []

  /**
   * Whether this location has any Kidde smoke detector assets.
   * Populated after connect() completes; used by the platform to decide
   * whether to proceed with device discovery or skip this location.
   */
  get hasAssets(): boolean {
    return this.assets.length > 0
  }

  /**
   * Whether every asset has answered DeviceInfoDocGetList.
   * The platform uses this to decide if the device list is trustworthy
   * enough to base stale-accessory removal on. If an asset timed out,
   * this stays false and stale cleanup is skipped (the safe choice).
   */
  get isDeviceListComplete(): boolean {
    return (
      this.assets.length > 0 &&
      this.assets.every((a) =>
        this.receivedAssetDeviceLists.includes(a.uuid),
      )
    )
  }

  /** Track which assets have responded to our device list request */
  private receivedAssetDeviceLists: string[] = []
  /** Latest accumulated device list (kept for timeout fallbacks) */
  private latestDevices: SmokeDetectorDeviceData[] = []
  /** Sequence number for WebSocket messages (incremented per message) */
  private seq = 1
  private socket: WebSocket | null = null
  private reconnecting = false
  private disconnected = false
  private consecutiveFailures = 0
  /** True once an initial connect() found assets and opened a socket */
  private initialConnectDone = false
  /** Timestamp of the last message received (for the watchdog) */
  private lastMessageAt = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly locationId: string,
    private readonly locationName: string,
    private readonly restClient: RingRestClient,
  ) {
    /**
     * Real-time device data updates pipeline:
     * 1. Filter for DeviceInfoDocType messages with a well-formed body array
     * 2. Flatten the body array into individual device entries
     * 3. Merge general.v2 + device.v1 into a flat object
     * 4. Drop entries without a zid (malformed or unexpected shapes)
     *
     * Shape validation matters: an error thrown inside this pipeline would
     * error the shared observable permanently, and RxJS 7 rethrows errors
     * from subscribers without error callbacks as uncaught exceptions,
     * which would crash the whole Homebridge process.
     */
    this.onDeviceDataUpdate = this.onDataUpdate.pipe(
      filter(
        (m) => m.datatype === 'DeviceInfoDocType' && Array.isArray(m.body),
      ),
      concatMap((m) => m.body),
      filter((data) => data !== null && typeof data === 'object'),
      map((data) => flattenDeviceData(data)),
      filter((flat) => typeof flat.zid === 'string' && flat.zid.length > 0),
      shareReplay(1),
    )

    /**
     * Initial device discovery pipeline:
     * Accumulates device lists from DeviceInfoDocGetList responses.
     * We may have multiple assets (one per physical detector), each
     * returning its own device list. We merge them into a single array
     * and only emit once all online assets have responded.
     *
     * This mirrors the onDevices observable in ring-client-api's Location class.
     */
    const onDeviceList = this.onMessage.pipe(
      filter((m) => m.msg === 'DeviceInfoDocGetList'),
    )

    this.onDevices = onDeviceList.pipe(
      // Accumulate devices from multiple assets into one array
      scan(
        (
          devices: SmokeDetectorDeviceData[],
          message: SocketIoMessage,
        ) => {
          const { body: deviceList, src } = message
          if (!Array.isArray(deviceList)) return devices

          // Track that this asset has responded
          if (!this.receivedAssetDeviceLists.includes(src)) {
            this.receivedAssetDeviceLists.push(src)
          }

          // Merge new devices into accumulated list (update existing, add new)
          const merged = deviceList.reduce(
            (acc: SmokeDetectorDeviceData[], data: any) => {
              if (data === null || typeof data !== 'object') return acc
              const flat = flattenDeviceData(data)
              if (typeof flat.zid !== 'string' || !flat.zid) return acc
              const existingIndex = acc.findIndex(
                (d) => d.zid === flat.zid,
              )
              if (existingIndex >= 0) {
                acc[existingIndex] = { ...acc[existingIndex], ...flat }
                return acc
              }
              return [...acc, flat]
            },
            [...devices],
          )
          this.latestDevices = merged
          return merged
        },
        [] as SmokeDetectorDeviceData[],
      ),
      // Emit once every asset has responded. A non-responding asset is
      // bounded by the timeout in getDevices(), not by pre-filtering on
      // ticket status: Ring does not reliably report status as 'online',
      // and gating on it can complete discovery early with no devices
      // (an empty online set makes every() vacuously true).
      filter(() =>
        this.assets.every((a) =>
          this.receivedAssetDeviceLists.includes(a.uuid),
        ),
      ),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      shareReplay(1),
    )
  }

  /**
   * Establish the initial WebSocket connection.
   *
   * Returns 'connected' when a socket is open and device lists have been
   * requested, or 'no-assets' when the location has no Kidde assets.
   * THROWS on failure (ticket request error, socket open error) so the
   * platform can tell "location has no devices" apart from "location could
   * not be probed". That distinction protects cached accessories from
   * being removed as stale during a transient outage.
   *
   * After a successful initial connect, connection drops are handled
   * internally with reconnect(); connect() is not meant to be called again.
   */
  async connect(): Promise<ConnectResult> {
    const result = await this.doConnect()
    if (result === 'connected') {
      this.initialConnectDone = true
    }
    return result
  }

  /**
   * One connection attempt.
   *
   * Protocol (same as ring-client-api's Location.createConnection()):
   * 1. GET clap/tickets, which returns assets, host, and auth ticket
   * 2. Filter assets for sensor_bluejay_* kinds (THIS IS THE KEY DIFFERENCE)
   * 3. Connect to wss://{host}/ws?authcode={ticket}&ack=false
   * 4. Send DeviceInfoDocGetList for each asset UUID
   * 5. Listen for responses and DataUpdate channel messages
   */
  private async doConnect(): Promise<ConnectResult> {
    if (this.disconnected) return 'no-assets'

    // Step 1: Request a WebSocket ticket from Ring's clap/tickets endpoint.
    // This is the same endpoint ring-client-api uses. It returns the WebSocket
    // host, an auth ticket, and a list of "assets" (devices at this location
    // that support WebSocket communication).
    const ticketUrl = appApi(
      `clap/tickets?locationID=${this.locationId}&enableExtendedEmergencyCellUsage=true&requestedTransport=ws`,
    )
    const ticketResponse = await this.restClient.request<TicketResponse>({
      url: ticketUrl,
    })
    const { assets, ticket, host } = ticketResponse

    if (this.disconnected) return 'no-assets'

    // Step 2: Filter for Kidde smoke detector assets.
    //
    // THIS IS THE KEY DIFFERENCE from ring-client-api:
    // ring-client-api's isWebSocketSupportedAsset() only accepts:
    //   kind.startsWith('base_station') || kind.startsWith('beams_bridge')
    //
    // We instead accept: kind.startsWith('sensor_bluejay')
    //
    // This is what @tsightler discovered: the clap/tickets endpoint returns
    // sensor_bluejay_* assets even for hubless locations, and the WebSocket
    // works perfectly with them.
    const supportedAssets = (assets ?? []).filter(isKiddeAsset)

    if (supportedAssets.length === 0) {
      if (this.initialConnectDone) {
        // Reconnect path: an empty asset list here is almost always
        // transient (e.g. detectors rebooting after the same power cut
        // that dropped our socket). Keep the known assets and let the
        // caller schedule another attempt instead of going silent forever.
        logWarn(
          `Ticket for location "${this.locationName}" transiently returned no Kidde assets, will retry`,
        )
      } else {
        logDebug(
          `No Kidde smoke detector assets found via websocket for location "${this.locationName}"`,
        )
        this.assets = []
      }
      return 'no-assets'
    }

    this.assets = supportedAssets
    this.receivedAssetDeviceLists = []

    const offline = supportedAssets.filter((a) => a.status !== 'online')
    if (offline.length > 0) {
      // Informational only. We still request device lists from these
      // assets, because Ring's ticket status is often stale and the
      // asset frequently responds anyway; the getDevices() timeout is
      // the real backstop if one truly never answers.
      logDebug(
        `Location "${this.locationName}": ${offline.length} asset(s) report non-online ticket status; requesting their device lists anyway: ` +
          offline.map((a) => a.uuid).join(', '),
      )
    }
    logDebug(
      `Location "${this.locationName}": ${supportedAssets.length} websocket asset(s): ` +
        supportedAssets
          .map((a) => `${a.uuid} (${a.kind}, ${a.status})`)
          .join(', '),
    )

    // Step 3: Create the WebSocket connection.
    // Same URL format as ring-client-api: wss://{host}/ws?authcode={ticket}&ack=false
    // The ack=false parameter disables message acknowledgment (simpler protocol).
    const wsUrl = `wss://${host}/ws?authcode=${ticket}&ack=false`
    const socket = new WebSocket(wsUrl)
    this.socket = socket

    // Wait for the connection to open before proceeding
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }

      const onError = () => {
        cleanup()
        reject(
          new Error(
            `WebSocket connection failed for "${this.locationName}"`,
          ),
        )
      }

      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }

      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })

    // The platform may have shut down while we were connecting
    if (this.disconnected) {
      try {
        socket.close()
      } catch {
        // ignore
      }
      this.socket = null
      return 'no-assets'
    }

    this.onConnectedSubject.next(true)
    this.consecutiveFailures = 0
    logInfo(`WebSocket connected for location "${this.locationName}"`)

    // Step 5: Set up ongoing message handling for the lifetime of the connection.
    //
    // Messages arrive as JSON with structure: { msg: SocketIoMessage, channel: string }
    // - Initial device list responses come with msg.msg === 'DeviceInfoDocGetList'
    // - Real-time state updates come on channel === 'DataUpdate'
    // - HubDisconnectionEventType means the server wants us to reconnect
    socket.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now()
      try {
        const parsed = JSON.parse(String(event.data))
        const message: SocketIoMessage = parsed?.msg
        const channel: string = parsed?.channel

        if (!message || typeof message !== 'object') return

        // Ring server tells us to reconnect (same handling as ring-client-api)
        if (message.datatype === 'HubDisconnectionEventType') {
          logWarn(
            `Hub disconnection event for location "${this.locationName}", reconnecting...`,
          )
          this.reconnect()
          return
        }

        // Route to the onMessage subject (for device list accumulation)
        this.onMessage.next(message)

        // Real-time state updates (alarm triggered, battery changed, etc.)
        // come on the "DataUpdate" channel. These are what drive HomeKit
        // characteristic updates for smoke/CO detection.
        if (channel === 'DataUpdate') {
          this.onDataUpdate.next(message)
        }
      } catch (error) {
        logDebug(`Failed to parse websocket message: ${error}`)
      }
    })

    // Auto-reconnect on connection loss
    socket.addEventListener('close', () => {
      logDebug(`WebSocket closed for location "${this.locationName}"`)
      this.reconnect()
    })

    socket.addEventListener('error', () => {
      logDebug(`WebSocket error for location "${this.locationName}"`)
      this.reconnect()
    })

    // Step 4: Request device lists for all smoke detector assets.
    // Each asset responds with its devices (including component state
    // like alarm.smoke, alarm.co, battery level, etc.).
    for (const asset of supportedAssets) {
      this.requestList('DeviceInfoDocGetList', asset.uuid)
    }

    this.startKeepalive()
    return 'connected'
  }

  // ─── Keepalive / Watchdog ─────────────────────────────────────────────

  /**
   * Periodically re-poll every asset's device list and watch for silence.
   *
   * The poll serves two purposes: it generates guaranteed request/response
   * traffic so a dead connection is detectable, and it re-syncs device
   * state in case a DataUpdate was missed while an asset was offline.
   *
   * The watchdog detects half-open TCP connections: the socket looks open,
   * no close event ever fires, but nothing can actually be received. For a
   * life-safety device, silently missing alarms is the worst failure mode,
   * so we force a reconnect after STALE_CONNECTION_MS without traffic.
   */
  private startKeepalive(): void {
    this.stopKeepalive()
    this.lastMessageAt = Date.now()

    this.pollTimer = setInterval(() => {
      for (const asset of this.assets) {
        this.requestList('DeviceInfoDocGetList', asset.uuid)
      }
    }, POLL_INTERVAL_MS)

    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > STALE_CONNECTION_MS) {
        logWarn(
          `No websocket traffic for location "${this.locationName}" in ${STALE_CONNECTION_MS / 1000}s, forcing reconnect`,
        )
        this.reconnect()
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  private stopKeepalive(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ─── Reconnection ─────────────────────────────────────────────────────

  /**
   * Reconnect with jittered exponential backoff.
   * Starts at 5s, doubles each attempt, caps at 60s, and NEVER gives up:
   * for a smoke detector integration, a plugin that quietly stops trying
   * is worse than one that retries once a minute forever.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.disconnected) return
    this.reconnecting = true
    this.stopKeepalive()
    this.onConnectedSubject.next(false)

    try {
      this.socket?.close()
    } catch {
      // ignore close errors during cleanup
    }
    this.socket = null

    this.consecutiveFailures++
    const baseDelay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1),
      MAX_RECONNECT_DELAY_MS,
    )
    // +-20% jitter so multiple locations don't stampede Ring in sync
    const delayMs = Math.round(baseDelay * (0.8 + Math.random() * 0.4))

    logInfo(
      `Reconnecting websocket for "${this.locationName}" in ${Math.round(delayMs / 1000)}s (attempt ${this.consecutiveFailures})...`,
    )

    await delay(delayMs)
    this.reconnecting = false

    if (this.disconnected) return

    try {
      const result = await this.doConnect()
      if (result === 'no-assets' && !this.disconnected) {
        // Transient empty asset list during reconnect: keep trying
        this.reconnect()
      }
    } catch (error) {
      logError(`Reconnect failed for "${this.locationName}": ${error}`)
      this.reconnect()
    }
  }

  // ─── Messaging ────────────────────────────────────────────────────────

  /**
   * Send a message over the WebSocket.
   * Uses the same wire format as ring-client-api:
   * { channel: 'message', msg: { msg, dst, seq } }
   */
  private sendMessage(message: Record<string, any>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      logDebug('Cannot send message: websocket not open')
      return
    }
    message.seq = this.seq++
    this.socket.send(JSON.stringify({ channel: 'message', msg: message }))
  }

  /**
   * Request a device list from a specific asset.
   * The "dst" field targets the asset by UUID.
   */
  private requestList(listType: string, assetId: string): void {
    this.sendMessage({ msg: listType, dst: assetId })
  }

  /**
   * Get the initial device list (waits for all assets to respond).
   * If responses don't arrive within GET_DEVICES_TIMEOUT_MS, settles with
   * whatever has accumulated so far instead of hanging discovery forever.
   * Callers can check isDeviceListComplete to know which case occurred.
   */
  async getDevices(): Promise<SmokeDetectorDeviceData[]> {
    return firstValueFrom(
      this.onDevices.pipe(
        timeout({ first: GET_DEVICES_TIMEOUT_MS }),
        catchError(() => {
          logWarn(
            `Timed out waiting for device list at location "${this.locationName}" ` +
              `(${this.receivedAssetDeviceLists.length}/${this.assets.length} asset(s) responded)`,
          )
          return of(this.latestDevices)
        }),
      ),
    )
  }

  /** Clean shutdown: close the WebSocket and complete all observables. */
  disconnect(): void {
    this.disconnected = true
    this.stopKeepalive()
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
    this.socket = null
    this.onMessage.complete()
    this.onDataUpdate.complete()
    this.onConnectedSubject.complete()
  }
}
