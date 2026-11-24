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
 *
 * AVAILABILITY IS PER DETECTOR, not per connection. Each detector is its own
 * asset, so the socket can be perfectly healthy while one detector has fallen
 * off wifi. A detector only counts as available once it has delivered state
 * on the CURRENT connection, and stops counting if it then goes silent for
 * DEVICE_STALE_MS. Otherwise it would keep presenting its last "no smoke"
 * reading as current for as long as any other detector kept answering.
 */

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
import { openSocket, SOCKET_OPEN, type RingSocket } from './socket-factory.js'
import {
  TicketResponse,
  TicketAsset,
  SocketIoMessage,
  SmokeDetectorDeviceData,
  isKiddeAsset,
  flattenDeviceData,
  flattenDeviceList,
  extractImpulses,
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
/**
 * How long one detector may go without delivering any state before it is
 * reported as not responding, even though the location's socket is up.
 *
 * Deliberately the same window as STALE_CONNECTION_MS. The watchdog already
 * bets that a healthy location produces traffic within this window (every
 * asset is polled once a minute); this applies the same bet to each detector
 * individually instead of letting one talkative detector vouch for the rest.
 */
const DEVICE_STALE_MS = STALE_CONNECTION_MS
/** How long getDevices() waits before settling with whatever it has */
const GET_DEVICES_TIMEOUT_MS = 20_000

/** Outcome of a connection attempt */
export type ConnectResult = 'connected' | 'no-assets'

/** Whether one detector is currently delivering state */
export interface DeviceAvailability {
  readonly connected: boolean
  readonly onConnected: Observable<boolean>
}

export class SmokeDetectorWebSocket {
  /**
   * Internal subjects for routing WebSocket messages.
   * onMessage receives ALL messages; onDataUpdate receives only DataUpdate channel messages.
   */
  private onMessage = new Subject<SocketIoMessage>()
  private onDataUpdate = new Subject<SocketIoMessage>()
  private onConnectedSubject = new BehaviorSubject<boolean>(false)
  private onImpulseSubject = new Subject<{
    zid: string
    impulseTypes: string[]
  }>()

  /** Observable that emits true/false when connection status changes */
  public readonly onConnected: Observable<boolean> =
    this.onConnectedSubject.asObservable()

  /**
   * One-shot device events (such as a physical test button press) that arrive
   * in the raw message body's impulse section, which flattening discards.
   */
  public readonly onImpulse: Observable<{
    zid: string
    impulseTypes: string[]
  }> = this.onImpulseSubject.asObservable()

  /** Whether the websocket is currently established (synchronous check) */
  get connected(): boolean {
    return this.onConnectedSubject.value
  }

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
   * Observable of the accumulated device list, emitted on every change.
   *
   * It deliberately does NOT wait for all assets: each detector is its own
   * asset, so an all-or-nothing gate would let one silent detector suppress
   * state re-sync for every other detector at the location. Callers that
   * need a complete list (initial discovery) use getDevices(), which waits
   * for completeness with a timeout.
   */
  public readonly onDevices: Observable<SmokeDetectorDeviceData[]>

  /**
   * The devices contained in ONE device-list answer, emitted as it arrives.
   *
   * THIS is the stream to sync state from: every entry was just reported by
   * the asset that answered. onDevices, by contrast, re-emits the accumulated
   * document of EVERY device at the location whenever ANY asset answers, so
   * applying it replays old state onto detectors that did not answer. With
   * two detectors that replay overwrote a live alarm (delivered on the
   * DataUpdate channel) with the pre-alarm "inactive" from the last poll, as
   * soon as the other detector answered its own poll.
   */
  public readonly onDeviceListUpdate: Observable<SmokeDetectorDeviceData[]>

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
  private socket: RingSocket | null = null
  private reconnecting = false
  /**
   * Set whenever a reconnect is requested, including while a reconnect loop
   * is already running, so a drop that happens inside that loop's own
   * discovery window is not lost (the loop re-checks before declaring
   * success).
   */
  private reconnectRequested = false
  private disconnected = false
  private consecutiveFailures = 0
  /** True once an initial connect() found assets and opened a socket */
  private initialConnectDone = false
  /** Timestamp of the last message received (for the watchdog) */
  private lastMessageAt = 0
  /**
   * True between a socket opening and the first device document arriving.
   * Availability is only announced once fresh state is in hand.
   */
  private awaitingFirstDocument = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  /** When each device (zid) last delivered state on the CURRENT connection */
  private readonly deviceLastSeen = new Map<string, number>()
  /** Per-device availability handed to accessories, keyed by zid */
  private readonly deviceAvailability = new Map<
    string,
    BehaviorSubject<boolean>
  >()
  /** Devices flagged as silent while the socket itself was up (for logging) */
  private readonly quietDevices = new Set<string>()

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
     * returning its own device list, merged into a single array and emitted
     * on every change. getDevices() owns the wait-for-completeness step.
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
          // An empty body is not a usable answer, so it must not count as
          // this asset having reported: treating it as complete would let a
          // zero-device result look like an authoritative "nothing here".
          if (!Array.isArray(deviceList) || deviceList.length === 0) {
            return devices
          }

          // Track that this asset has responded
          if (!this.receivedAssetDeviceLists.includes(src)) {
            this.receivedAssetDeviceLists.push(src)
          }

          // Merge new devices into accumulated list (update existing, add new)
          const merged = [...devices]
          for (const flat of flattenDeviceList(deviceList)) {
            const existingIndex = merged.findIndex((d) => d.zid === flat.zid)
            if (existingIndex >= 0) {
              merged[existingIndex] = { ...merged[existingIndex], ...flat }
            } else {
              merged.push(flat)
            }
          }
          this.latestDevices = merged
          return merged
        },
        [] as SmokeDetectorDeviceData[],
      ),
      // Emit on every accumulated change rather than only once every asset
      // has answered. Each detector is its own asset, so an all-or-nothing
      // gate would let one silent detector permanently suppress the state
      // re-sync (and new-device detection) for every other detector at the
      // location. getDevices() owns the wait-for-completeness behavior.
      //
      // The responded-asset count is part of the distinctness key: two assets
      // can report the same device, so the response that COMPLETES the list
      // may be byte-identical to the previous emission. Comparing devices
      // alone would swallow it and leave getDevices() waiting for a value
      // that never comes.
      map((devices) => ({
        devices,
        responded: this.receivedAssetDeviceLists.length,
      })),
      distinctUntilChanged(
        (a, b) =>
          a.responded === b.responded &&
          JSON.stringify(a.devices) === JSON.stringify(b.devices),
      ),
      map(({ devices }) => devices),
      shareReplay(1),
    )

    // Fresh, per-answer view of the same messages (see the property docs).
    this.onDeviceListUpdate = onDeviceList.pipe(
      map((message) => flattenDeviceList(message.body)),
      filter((devices) => devices.length > 0),
    )
  }

  /**
   * Availability of ONE detector, for binding to its HomeKit accessory.
   *
   * True only while the socket is up AND this detector has delivered state on
   * the current connection within DEVICE_STALE_MS. The returned object stays
   * valid across reconnects.
   */
  availabilityFor(zid: string): DeviceAvailability {
    let subject = this.deviceAvailability.get(zid)
    if (!subject) {
      subject = new BehaviorSubject<boolean>(
        this.isDeviceFresh(zid, Date.now()),
      )
      this.deviceAvailability.set(zid, subject)
    }
    const current = subject
    return {
      get connected() {
        return current.value
      },
      onConnected: current.asObservable(),
    }
  }

  private isDeviceFresh(zid: string, now: number): boolean {
    if (this.disconnected || !this.onConnectedSubject.value) return false
    const seen = this.deviceLastSeen.get(zid)
    return seen !== undefined && now - seen <= DEVICE_STALE_MS
  }

  /** Record that these devices just delivered state on this connection. */
  private noteDevicesSeen(devices: SmokeDetectorDeviceData[]): void {
    if (devices.length === 0) return
    const now = Date.now()
    for (const { zid } of devices) this.deviceLastSeen.set(zid, now)
    this.refreshDeviceAvailability(now)
  }

  /**
   * Recompute every detector's availability and publish the changes. Runs
   * when state arrives, when the connection changes, and on each watchdog
   * tick (which is what notices a detector that has simply gone quiet).
   */
  private refreshDeviceAvailability(now = Date.now()): void {
    for (const [zid, subject] of this.deviceAvailability) {
      const fresh = this.isDeviceFresh(zid, now)
      if (fresh === subject.value) continue

      if (!fresh && this.onConnectedSubject.value) {
        // The socket is fine; this one detector stopped answering.
        this.quietDevices.add(zid)
        logWarn(
          `Detector "${this.deviceName(zid)}" at "${this.locationName}" has not reported in ` +
            `${DEVICE_STALE_MS / 1000}s. It will show as not responding in HomeKit until it reports again.`,
        )
      } else if (fresh && this.quietDevices.delete(zid)) {
        logInfo(
          `Detector "${this.deviceName(zid)}" at "${this.locationName}" is reporting again`,
        )
      }
      subject.next(fresh)
    }
  }

  private deviceName(zid: string): string {
    return this.latestDevices.find((d) => d.zid === zid)?.name || zid
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
    try {
      const result = await this.doConnect()
      if (result === 'connected') {
        this.initialConnectDone = true
      }
      return result
    } catch (error) {
      // Clean up a partially established connection so no open socket or
      // keepalive timer outlives a failed connect.
      this.teardownSocket()
      throw error
    }
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
    const socket = openSocket(wsUrl)
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

    // Backoff is NOT reset here. A socket that opens and is immediately
    // dropped would otherwise keep resetting the counter and retry every 5s
    // forever; the counter is cleared in announceAvailable(), once the
    // connection has proved itself by delivering data.
    //
    // Availability is NOT announced yet either. An open socket does not mean the
    // device state is known: it is announced once the first device document
    // for this connection arrives, so HomeKit never sees pre-outage values
    // presented as current.
    this.awaitingFirstDocument = true
    logInfo(`WebSocket connected for location "${this.locationName}"`)

    // Step 5: Set up ongoing message handling for the lifetime of the connection.
    //
    // Every listener is bound to THIS socket and ignores events once the
    // socket has been replaced or torn down. Without that guard, closing a
    // socket during teardown fires its own close handler, which re-arms the
    // reconnect request the loop just cleared, producing an endless
    // connect/teardown flap.
    //
    // Messages arrive as JSON with structure: { msg: SocketIoMessage, channel: string }
    // - Initial device list responses come with msg.msg === 'DeviceInfoDocGetList'
    // - Real-time state updates come on channel === 'DataUpdate'
    // - HubDisconnectionEventType means the server wants us to reconnect
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return
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

        // Fresh device state has arrived, so this connection can now be
        // treated as available for reporting to HomeKit. The devices in
        // this answer are marked as seen only AFTER the data above has
        // propagated, so a detector never flips to available while HomeKit
        // still holds its pre-outage values.
        if (message.msg === 'DeviceInfoDocGetList') {
          this.announceAvailable()
          this.noteDevicesSeen(flattenDeviceList(message.body))
        }

        // Real-time state updates (alarm triggered, battery changed, etc.)
        // come on the "DataUpdate" channel. These are what drive HomeKit
        // characteristic updates for smoke/CO detection.
        if (channel === 'DataUpdate') {
          // Also fresh state. Announcing here matters: if a connection only
          // ever delivered DataUpdates and never answered the device-list
          // request, availability would stay false and a genuine alarm
          // arriving on this channel would be suppressed as "No Response".
          this.announceAvailable()
          this.onDataUpdate.next(message)
          this.emitImpulses(message)
          // A pushed update is proof of life for that detector too
          this.noteDevicesSeen(flattenDeviceList(message.body))
        }
      } catch (error) {
        logDebug(`Failed to parse websocket message: ${error}`)
      }
    })

    // Auto-reconnect on connection loss (ignored for a superseded socket)
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return
      logDebug(`WebSocket closed for location "${this.locationName}"`)
      this.reconnect()
    })

    socket.addEventListener('error', () => {
      if (socket !== this.socket) return
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

  /**
   * Emit any one-shot impulse events carried by a DataUpdate message.
   *
   * Impulses live in the raw body's impulse section, which flattening drops,
   * so they are read here before the flattening pipeline sees the message.
   */
  private emitImpulses(message: SocketIoMessage): void {
    if (!Array.isArray(message.body)) return
    for (const entry of message.body) {
      const impulseTypes = extractImpulses(entry)
      if (impulseTypes.length === 0) continue
      const { zid } = flattenDeviceData(entry)
      if (!zid) continue
      // No public capture of a real test-button press exists yet, so keep the
      // raw payload available at debug level to pin the enums down later.
      logDebug(
        `Impulse(s) ${impulseTypes.join(', ')} for device ${zid}: ${JSON.stringify(entry)}`,
      )
      this.onImpulseSubject.next({ zid, impulseTypes })
    }
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

    // unref: keepalive must never hold the process open during shutdown
    this.pollTimer = setInterval(() => {
      for (const asset of this.assets) {
        this.requestList('DeviceInfoDocGetList', asset.uuid)
      }
    }, POLL_INTERVAL_MS)
    this.pollTimer.unref()

    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > STALE_CONNECTION_MS) {
        logWarn(
          `No websocket traffic for location "${this.locationName}" in ${STALE_CONNECTION_MS / 1000}s, forcing reconnect`,
        )
        this.reconnect()
        return
      }
      // The socket is alive; check whether any single detector went quiet
      this.refreshDeviceAvailability()
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref()
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
   * Announce that this connection is serving fresh state. Called once the
   * first data of a connection arrives, so availability never flips true
   * while only pre-outage values are known.
   */
  private announceAvailable(): void {
    if (!this.awaitingFirstDocument || this.disconnected) return
    this.awaitingFirstDocument = false
    // The connection has proved itself, so the backoff can start over
    this.consecutiveFailures = 0
    if (!this.onConnectedSubject.value) {
      this.onConnectedSubject.next(true)
    }
    this.refreshDeviceAvailability()
  }

  /**
   * Whether the socket is genuinely usable right now. The connected flag
   * alone can be stale: the socket can die while a reconnect attempt is
   * still inside its own discovery window.
   */
  private isLive(): boolean {
    return (
      !this.disconnected &&
      this.socket !== null &&
      this.socket.readyState === SOCKET_OPEN
    )
  }

  /** Close the current socket and stop its timers, without ending the object. */
  private teardownSocket(): void {
    this.stopKeepalive()
    const socket = this.socket
    // Detach first: the listeners compare against this.socket, so clearing it
    // before close() means the close event this teardown causes is ignored
    // instead of re-arming a reconnect request.
    this.socket = null
    this.awaitingFirstDocument = false
    try {
      socket?.close()
    } catch {
      // ignore close errors during cleanup
    }
    // Nothing heard on this connection counts toward the next one: after a
    // reconnect each detector must report again before it is available.
    this.deviceLastSeen.clear()
    if (this.onConnectedSubject.value) {
      this.onConnectedSubject.next(false)
    }
    this.refreshDeviceAvailability()
  }

  /**
   * Request a reconnect, starting the retry loop if one isn't already running.
   *
   * The request flag is set even when a loop is running so a drop occurring
   * during that loop's own discovery window is not lost; the loop re-checks
   * the flag before declaring success.
   */
  private reconnect(): void {
    if (this.disconnected) return
    this.reconnectRequested = true
    if (this.reconnecting) return
    this.reconnecting = true
    void this.reconnectLoop().finally(() => {
      this.reconnecting = false
    })
  }

  /**
   * Reconnect with jittered exponential backoff.
   * Starts at 5s, doubles each attempt, caps at 60s, and NEVER gives up:
   * for a smoke detector integration, a plugin that quietly stops trying
   * is worse than one that retries once a minute forever.
   */
  private async reconnectLoop(): Promise<void> {
    while (!this.disconnected) {
      this.reconnectRequested = false
      this.teardownSocket()
      if (this.disconnected) return

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
      if (this.disconnected) return

      let result: ConnectResult
      try {
        result = await this.doConnect()
      } catch (error) {
        logError(`Reconnect failed for "${this.locationName}": ${error}`)
        continue
      }

      if (result === 'no-assets') {
        // Transient empty asset list during reconnect: keep trying rather
        // than silently ending monitoring for this location.
        continue
      }

      if (!this.isLive() || this.reconnectRequested) {
        // The socket dropped again during the discovery window.
        logWarn(
          `Reconnect for "${this.locationName}" did not come up cleanly, retrying`,
        )
        continue
      }

      return
    }
  }

  // ─── Messaging ────────────────────────────────────────────────────────

  /**
   * Send a message over the WebSocket.
   * Uses the same wire format as ring-client-api:
   * { channel: 'message', msg: { msg, dst, seq } }
   */
  private sendMessage(message: Record<string, any>): void {
    if (this.socket?.readyState !== SOCKET_OPEN) {
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
        // Wait for a complete picture, but never indefinitely
        filter(() => this.isDeviceListComplete),
        timeout({ first: GET_DEVICES_TIMEOUT_MS }),
        catchError(() => {
          logWarn(
            `Timed out waiting for device list at location "${this.locationName}" ` +
              `(${this.receivedAssetDeviceLists.length}/${this.assets.length} asset(s) responded)`,
          )
          // Some assets stayed silent. Report what did arrive so those
          // detectors still work, and let availability reflect reality.
          if (this.latestDevices.length > 0) this.announceAvailable()
          return of(this.latestDevices)
        }),
      ),
    )
  }

  /** Clean shutdown: close the WebSocket and complete all observables. */
  disconnect(): void {
    this.disconnected = true
    this.stopKeepalive()
    this.onImpulseSubject.complete()

    // Same ordering invariant as teardownSocket(): detach before closing so
    // the resulting close event cannot re-enter the reconnect logic.
    const socket = this.socket
    this.socket = null
    this.awaitingFirstDocument = false
    try {
      socket?.close()
    } catch {
      // ignore
    }

    // Report unavailable before completing, so any accessory still bound to
    // this connection stops presenting its last reading as current.
    this.deviceLastSeen.clear()
    if (this.onConnectedSubject.value) {
      this.onConnectedSubject.next(false)
    }
    this.refreshDeviceAvailability()
    for (const subject of this.deviceAvailability.values()) {
      subject.complete()
    }
    this.onMessage.complete()
    this.onDataUpdate.complete()
    this.onConnectedSubject.complete()
  }
}
