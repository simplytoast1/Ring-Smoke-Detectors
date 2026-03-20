/**
 * Ring API Types for Kidde/Ring Smoke Detectors
 *
 * Background: Kidde/Ring smoke detectors are WiFi-only devices that don't require
 * a Ring Alarm hub. The Ring REST API returns them in the "other" devices collection
 * (alongside third-party devices like MyQ garage doors), NOT in the main "devices"
 * collection where hub-connected Z-wave sensors appear.
 *
 * CRITICAL: The REST API "other" collection provides only device metadata (name,
 * battery health, connection status) — it does NOT include real-time alarm state.
 * Alarm state (smoke detected, CO detected, etc.) is ONLY available via the
 * WebSocket connection. This is why the WebSocket is essential, not optional.
 *
 * There are two naming conventions for these devices:
 * - "kind" (REST API): e.g., "sensor_bluejay_wsc"
 * - "deviceType" (WebSocket): e.g., "comp.bluejay.sensor_bluejay_wsc"
 *
 * See: https://github.com/dgreif/ring/issues/1674
 */

/**
 * Device kinds as they appear in the REST API "other" devices collection.
 * Used to identify which locations have Kidde devices and thus need a WebSocket.
 */
export const KiddeDeviceKind = {
  /** Wired smoke-only detector (no CO sensor) */
  SmokeOnly: 'sensor_bluejay_ws',
  /** Wired smoke + CO combo detector */
  SmokeCo: 'sensor_bluejay_wsc',
  /** Battery-powered smoke + CO combo detector */
  SmokeCoBattery: 'sensor_bluejay_sc',
} as const

export type KiddeDeviceKind =
  (typeof KiddeDeviceKind)[keyof typeof KiddeDeviceKind]

/**
 * Device types as they appear in WebSocket discovery responses.
 * These are the "deviceType" field from the flattened device data
 * (general.v2 merged with device.v1). The "comp.bluejay." prefix
 * distinguishes them from the REST API "kind" values.
 */
export const KiddeDeviceType = {
  SmokeOnly: 'comp.bluejay.sensor_bluejay_ws',
  SmokeCo: 'comp.bluejay.sensor_bluejay_wsc',
  SmokeCoBattery: 'comp.bluejay.sensor_bluejay_sc',
} as const

export type KiddeDeviceType =
  (typeof KiddeDeviceType)[keyof typeof KiddeDeviceType]

/**
 * Response from Ring's WebSocket ticket endpoint (clap/tickets).
 *
 * The ticket endpoint returns a list of "assets" — devices at the location
 * that support WebSocket communication. Each asset has a UUID that we use
 * to request its device list over the WebSocket.
 *
 * The "host" field is the WebSocket server to connect to, and "ticket" is
 * the authentication token for the WebSocket URL.
 */
export interface TicketResponse {
  assets: TicketAsset[]
  host: string
  subscriptionTopics: string[]
  ticket: string
}

/**
 * An individual asset from the ticket response.
 *
 * The key insight from @tsightler: even when there is no Ring hub, the
 * clap/tickets endpoint still returns sensor_bluejay_* assets. The existing
 * ring-client-api filters these out because isWebSocketSupportedAsset() only
 * accepts base_station* and beams_bridge*. We accept sensor_bluejay* assets
 * to enable hubless WebSocket discovery.
 */
export interface TicketAsset {
  doorbotId: number
  kind: string
  onBattery: boolean
  status: 'online' | 'offline'
  uuid: string
}

/**
 * WebSocket message types used in the Ring protocol.
 *
 * The Ring WebSocket uses a simple request/response pattern:
 * - We send "DeviceInfoDocGetList" to request all devices for an asset
 * - The server responds with the same message type containing device data
 * - Real-time updates arrive as "DeviceInfoDocType" on the "DataUpdate" channel
 */
export type MessageType =
  | 'DeviceInfoDocGetList'
  | 'DeviceInfoSet'
  | 'SessionInfo'
  | 'RoomGetList'

export type MessageDataType =
  | 'DeviceInfoDocType'
  | 'SessionInfoType'
  | 'HubDisconnectionEventType'
  | 'DeviceInfoSetType'

/**
 * A message received over the Ring WebSocket.
 * Matches the structure used by ring-client-api's SocketIoMessage interface.
 */
export interface SocketIoMessage {
  msg: MessageType
  datatype: MessageDataType
  /** The asset UUID this message originated from */
  src: string
  /** Array of device data objects */
  body: any[]
}

/**
 * Device component data as returned via the WebSocket.
 *
 * These are the actual alarm states that we expose to HomeKit.
 * The component names (alarm.smoke, alarm.co, etc.) are consistent
 * across all Kidde detector models discovered via WebSocket.
 *
 * Example data from a working device (provided by @tsightler):
 * {
 *   "alarm.smoke": { "alarmStatus": "inactive", "relayStatus": "clear" },
 *   "alarm.co": { "alarmStatus": "inactive", "relayStatus": "clear" },
 *   "co.level": { "reading": 0 },
 *   "siren": { "status": "clear" }
 * }
 */
export interface SmokeDetectorComponents {
  /** Smoke alarm status — "active" means smoke detected */
  'alarm.smoke'?: {
    alarmStatus: 'active' | 'inactive'
    relayStatus?: string
  }
  /** CO alarm status — "active" means dangerous CO levels */
  'alarm.co'?: {
    alarmStatus: 'active' | 'inactive'
    relayStatus?: string
    lowLevelAlarmStatus?: 'active' | 'inactive'
  }
  /** Sensor end-of-life warning (detectors expire after ~10 years) */
  'alarm.end-of-life'?: {
    alarmStatus: 'active' | 'inactive'
    warningStatus?: 'active' | 'inactive'
    remainingDays?: number
  }
  /** Current CO reading in PPM */
  'co.level'?: {
    reading: number
  }
  /** Firmware version information */
  'firmware-version'?: {
    wifi: string
    main: string
    LPTSN: string
  }
  /** Kidde-internal status fields */
  'kidde.internal'?: {
    alarmExpressStatus: string
    tooMuchSmoke?: 'active' | 'inactive'
  }
  /** Active device malfunctions */
  malfunctions?: {
    current: string[]
  }
  /** WiFi network information */
  'networks:wlan0'?: {
    rssi: number
    signalStrength: string
    ipAddress: string
    type: string
    interfaceStatus: string
  }
  /** Push-to-test button status (physical test button on device) */
  pushToTest?: {
    status: 'active' | 'inactive'
  }
  /** Siren status */
  siren?: {
    status: string
  }
}

/**
 * Flattened device data from the WebSocket.
 *
 * WebSocket responses contain device data in a nested structure:
 *   { general: { v2: {...} }, device: { v1: {...} } }
 *
 * We flatten this via Object.assign(general.v2, device.v1) to get a single
 * object. This is the same approach used by ring-client-api's Location class.
 *
 * The "zid" field is the unique device identifier used throughout the system.
 */
export interface SmokeDetectorDeviceData {
  /** Unique device identifier (used to match devices across updates) */
  zid: string
  /** User-assigned device name from the Ring app */
  name: string
  /** Device type with comp.bluejay prefix (e.g., "comp.bluejay.sensor_bluejay_wsc") */
  deviceType: string
  /** Numeric category ID */
  categoryId: number
  /** Battery level percentage (0-100) */
  batteryLevel?: number
  /** Battery status category */
  batteryStatus?: 'full' | 'charged' | 'ok' | 'low' | 'none' | 'charging'
  /** AC power status for wired models */
  acStatus?: 'error' | 'ok'
  /** Manufacturer name */
  manufacturerName?: string
  /** Device serial number */
  serialNumber?: string
  /** Tamper detection status */
  tamperStatus?: string
  /** Whether the device has a fault condition */
  faulted?: boolean
  tags?: string[]
  /** Real-time alarm component states — THE PRIMARY DATA WE NEED */
  components?: SmokeDetectorComponents
  /**
   * Legacy flat alarm fields. Some firmware versions may include these
   * alongside or instead of the components structure. We check both
   * locations for compatibility (same pattern as homebridge-ring's
   * smoke-co-listener.ts).
   */
  smoke?: { alarmStatus?: 'active' | 'inactive' }
  co?: { alarmStatus?: 'active' | 'inactive' }
  parentZid?: string
  roomId?: number
}

/** Ring REST API location response */
export interface RingLocation {
  location_id: string
  name: string
}

/**
 * Check if a WebSocket ticket asset is a Kidde smoke detector.
 *
 * This is the key filter that differs from ring-client-api's
 * isWebSocketSupportedAsset(), which only accepts base_station* and
 * beams_bridge*. By also accepting sensor_bluejay*, we enable WebSocket
 * connections for hubless Kidde detectors.
 */
export function isKiddeAsset(asset: TicketAsset): boolean {
  return asset.kind.startsWith('sensor_bluejay')
}

/**
 * Check if a WebSocket deviceType is a Kidde smoke detector.
 * Used to filter devices discovered via WebSocket — we skip
 * security-panel devices (which Ring creates for monitored locations
 * but don't have burglar-alarm capability, causing HomeKit errors).
 */
export function isKiddeDeviceType(deviceType: string): boolean {
  return deviceType.includes('sensor_bluejay')
}

/**
 * Check if a device is smoke-only (no CO sensor).
 * Determines whether to create a SmokeDetectorAccessory (smoke only)
 * or SmokeCoDetectorAccessory (smoke + CO).
 */
export function isSmokeOnly(deviceType: string): boolean {
  return (
    deviceType === KiddeDeviceType.SmokeOnly ||
    deviceType === KiddeDeviceKind.SmokeOnly
  )
}

/**
 * Flatten the nested WebSocket device data into a single object.
 *
 * WebSocket responses contain device data split across two objects:
 *   { general: { v2: { zid, name, deviceType, ... } },
 *     device:  { v1: { components, batteryLevel, ... } } }
 *
 * We merge them via Object.assign() — this is the exact same approach
 * used by ring-client-api's Location class (flattenDeviceData function).
 */
export function flattenDeviceData(data: {
  general?: { v2?: Record<string, any> }
  device?: { v1?: Record<string, any> }
}): SmokeDetectorDeviceData {
  return Object.assign(
    {},
    data.general?.v2,
    data.device?.v1,
  ) as SmokeDetectorDeviceData
}
