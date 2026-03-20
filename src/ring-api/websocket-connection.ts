/**
 * Custom WebSocket Connection for Kidde/Ring Smoke Detectors
 *
 * THIS IS THE CORE OF THE PLUGIN — the key innovation that makes hubless
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
 */

import { WebSocket } from 'undici'
import {
  Subject,
  BehaviorSubject,
  Observable,
  firstValueFrom,
  Subscription,
} from 'rxjs'
import {
  filter,
  map,
  scan,
  distinctUntilChanged,
  concatMap,
  shareReplay,
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
   */
  public readonly onDeviceDataUpdate: Observable<SmokeDetectorDeviceData>

  /**
   * Observable that emits the complete accumulated device list.
   * Only emits once ALL assets have responded to DeviceInfoDocGetList.
   * This ensures we have a complete picture before creating HomeKit accessories.
   */
  public readonly onDevices: Observable<SmokeDetectorDeviceData[]>

  /** Assets from the ticket response that we're tracking */
  private assets: TicketAsset[] = []

  /**
   * Whether this location has any Kidde smoke detector assets.
   * Populated after connect() completes — used by the platform to decide
   * whether to proceed with device discovery or skip this location.
   */
  get hasAssets(): boolean {
    return this.assets.length > 0
  }
  /** Track which assets have responded to our device list request */
  private receivedAssetDeviceLists: string[] = []
  /** Sequence number for WebSocket messages (incremented per message) */
  private seq = 1
  private socket: WebSocket | null = null
  private reconnecting = false
  private disconnected = false
  private consecutiveFailures = 0
  private subscriptions: Subscription[] = []

  constructor(
    private readonly locationId: string,
    private readonly locationName: string,
    private readonly restClient: RingRestClient,
  ) {
    /**
     * Real-time device data updates pipeline:
     * 1. Filter for DeviceInfoDocType messages (contains device state)
     * 2. Flatten the body array into individual device entries
     * 3. Merge general.v2 + device.v1 into a flat object
     *
     * These updates happen whenever a device's alarm state changes,
     * which is what triggers the HomeKit smoke/CO alerts.
     */
    this.onDeviceDataUpdate = this.onDataUpdate.pipe(
      filter(
        (m) => m.datatype === 'DeviceInfoDocType' && Boolean(m.body),
      ),
      concatMap((m) => m.body),
      map((data) => flattenDeviceData(data)),
      shareReplay(1),
    )

    /**
     * Initial device discovery pipeline:
     * Accumulates device lists from DeviceInfoDocGetList responses.
     * We may have multiple assets (one per physical detector), each
     * returning its own device list. We merge them into a single array
     * and only emit once ALL assets have responded.
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
          if (!deviceList) return devices

          // Track that this asset has responded
          if (!this.receivedAssetDeviceLists.includes(src)) {
            this.receivedAssetDeviceLists.push(src)
          }

          // Merge new devices into accumulated list (update existing, add new)
          return deviceList.reduce(
            (acc: SmokeDetectorDeviceData[], data: any) => {
              const flat = flattenDeviceData(data)
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
        },
        [] as SmokeDetectorDeviceData[],
      ),
      // Only emit once ALL assets have responded — ensures complete device list
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
   * Establish the WebSocket connection.
   *
   * Protocol (same as ring-client-api's Location.createConnection()):
   * 1. GET clap/tickets — returns assets, host, and auth ticket
   * 2. Filter assets for sensor_bluejay_* kinds (THIS IS THE KEY DIFFERENCE)
   * 3. Connect to wss://{host}/ws?authcode={ticket}&ack=false
   * 4. Send DeviceInfoDocGetList for each asset UUID
   * 5. Listen for responses and DataUpdate channel messages
   */
  async connect(): Promise<void> {
    if (this.disconnected) return

    try {
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

      // Step 2: Filter for Kidde smoke detector assets.
      //
      // THIS IS THE KEY DIFFERENCE from ring-client-api:
      // ring-client-api's isWebSocketSupportedAsset() only accepts:
      //   kind.startsWith('base_station') || kind.startsWith('beams_bridge')
      //
      // We instead accept: kind.startsWith('sensor_bluejay')
      //
      // This is what @tsightler discovered — the clap/tickets endpoint returns
      // sensor_bluejay_* assets even for hubless locations, and the WebSocket
      // works perfectly with them.
      const supportedAssets = assets.filter(isKiddeAsset)
      this.assets = supportedAssets
      this.receivedAssetDeviceLists = []

      if (supportedAssets.length === 0) {
        logWarn(
          `No Kidde smoke detector assets found via websocket for location "${this.locationName}"`,
        )
        return
      }

      logDebug(
        `Location "${this.locationName}": ${supportedAssets.length} websocket asset(s) — ` +
          supportedAssets
            .map((a) => `${a.uuid} (${a.kind}, ${a.status})`)
            .join(', '),
      )

      // Step 3: Create the WebSocket connection.
      // Same URL format as ring-client-api: wss://{host}/ws?authcode={ticket}&ack=false
      // The ack=false parameter disables message acknowledgment (simpler protocol).
      const wsUrl = `wss://${host}/ws?authcode=${ticket}&ack=false`
      this.socket = new WebSocket(wsUrl)

      // Wait for the connection to open before proceeding
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup()
          this.onConnectedSubject.next(true)
          this.consecutiveFailures = 0

          logInfo(
            `WebSocket connected for location "${this.locationName}"`,
          )

          // Step 4: Request device lists for all smoke detector assets.
          // Each asset responds with its devices (including component state
          // like alarm.smoke, alarm.co, battery level, etc.).
          for (const asset of supportedAssets) {
            this.requestList('DeviceInfoDocGetList', asset.uuid)
          }

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
          this.socket?.removeEventListener('open', onOpen)
          this.socket?.removeEventListener('error', onError)
        }

        this.socket!.addEventListener('open', onOpen)
        this.socket!.addEventListener('error', onError)
      })

      // Step 5: Set up ongoing message handling for the lifetime of the connection.
      //
      // Messages arrive as JSON with structure: { msg: SocketIoMessage, channel: string }
      // - Initial device list responses come with msg.msg === 'DeviceInfoDocGetList'
      // - Real-time state updates come on channel === 'DataUpdate'
      // - HubDisconnectionEventType means the server wants us to reconnect
      this.socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(String(event.data))
          const message: SocketIoMessage = parsed.msg
          const channel: string = parsed.channel

          if (!message) return

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
      this.socket.addEventListener('close', () => {
        logDebug(
          `WebSocket closed for location "${this.locationName}"`,
        )
        this.reconnect()
      })

      this.socket.addEventListener('error', () => {
        logDebug(
          `WebSocket error for location "${this.locationName}"`,
        )
        this.reconnect()
      })
    } catch (error) {
      logError(`WebSocket connect failed for "${this.locationName}": ${error}`)
      this.consecutiveFailures++
      await this.reconnect()
    }
  }

  /**
   * Reconnect with exponential backoff.
   * Starts at 5s, doubles each attempt, caps at 60s.
   * Prevents reconnect storms if Ring's servers are down.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.disconnected) return
    this.reconnecting = true
    this.onConnectedSubject.next(false)

    try {
      this.socket?.close()
    } catch {
      // ignore close errors during cleanup
    }
    this.socket = null

    this.consecutiveFailures++
    const delayMs = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1),
      MAX_RECONNECT_DELAY_MS,
    )

    logInfo(
      `Reconnecting websocket for "${this.locationName}" in ${delayMs / 1000}s (attempt ${this.consecutiveFailures})...`,
    )

    await delay(delayMs)
    this.reconnecting = false

    if (!this.disconnected) {
      this.connect().catch((error) => {
        logError(`Reconnect failed for "${this.locationName}": ${error}`)
      })
    }
  }

  /**
   * Send a message over the WebSocket.
   * Uses the same wire format as ring-client-api:
   * { channel: 'message', msg: { msg, dst, seq } }
   */
  private sendMessage(message: Record<string, any>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      logDebug('Cannot send message — websocket not open')
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
   * Returns a promise that resolves with the complete device array.
   */
  async getDevices(): Promise<SmokeDetectorDeviceData[]> {
    return firstValueFrom(this.onDevices)
  }

  /** Clean shutdown — close the WebSocket and complete all observables. */
  disconnect(): void {
    this.disconnected = true
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions = []
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
