/**
 * Base Accessory Class
 *
 * Provides shared functionality for all Kidde smoke detector HomeKit accessories.
 * Follows the same patterns as homebridge-ring's BaseDeviceAccessory:
 * - Uses RxJS BehaviorSubject for reactive state management
 * - Binds HAP characteristics to the device data observable
 * - Handles both HomeKit GET requests and push-based updates
 *
 * HomeKit updates happen in two ways:
 * 1. GET requests: When HomeKit polls a characteristic, we return the latest
 *    data from the BehaviorSubject's current value
 * 2. Push updates: When the WebSocket delivers new device data, the RxJS
 *    pipeline automatically pushes the new value to HomeKit via updateValue()
 *
 * AVAILABILITY: sensor characteristics are tied to whether THIS detector is
 * currently reporting (the platform passes a per-detector source). While it
 * is not, because the connection is down or because this one detector has
 * gone silent, they report an error so HomeKit shows "No Response" instead
 * of the last known state. Without this, a detector we cannot hear from is
 * indistinguishable from "no smoke", which is the worst possible failure
 * mode for a life-safety sensor.
 */

import type {
  PlatformAccessory,
  Service,
  Characteristic,
  CharacteristicValue,
  WithUUID,
} from 'homebridge'
import { BehaviorSubject, Observable, Subscription, combineLatest, of } from 'rxjs'
import { map, distinctUntilChanged } from 'rxjs/operators'
import { hap } from '../hap.js'
import { logInfo, logWarn, logDebug } from '../util.js'
import {
  BATTERY_STATUS_PERCENT,
  BATTERY_STATUS_NO_DATA,
  DEFAULT_LOW_BATTERY_THRESHOLD,
  type SmokeDetectorDeviceData,
} from '../ring-api/types.js'

/**
 * Whether the detector behind this accessory is currently reporting.
 * SmokeDetectorWebSocket.availabilityFor(zid) provides one per detector.
 */
export interface AvailabilitySource {
  readonly connected: boolean
  readonly onConnected: Observable<boolean>
}

/** Per-accessory settings taken from the plugin config */
export interface AccessoryOptions {
  /**
   * Numeric battery level (percent) at or below which HomeKit shows the
   * low-battery warning. Only matters for firmware that reports a number;
   * the categorical "low" status always raises the warning.
   */
  lowBatteryThreshold?: number
}

/**
 * Raised from characteristic reads while this detector is not reporting.
 *
 * A HapStatusError, not a plain Error: HAP-NodeJS treats a plain Error from
 * a read handler as a plugin bug and logs a warning with a stack trace for
 * every single read, which floods the log for the whole length of an outage.
 * The status error produces the same "No Response" in HomeKit, quietly.
 */
const UNAVAILABLE_ERROR = () =>
  new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)

/** Status spellings already warned about, to avoid log spam */
const warnedBatteryStatus = new Set<string>()
const warnedAlarmStatus = new Set<string>()
const warnedCommStatus = new Set<string>()

/**
 * Every battery- or power-related field Ring reported for a device, for the
 * debug log. These detectors are only known to report a battery CATEGORY, so
 * this is how a numeric level (or any other useful field) would be noticed
 * on real hardware.
 */
function batterySnapshot(data: SmokeDetectorDeviceData): Record<string, unknown> {
  const interesting = /batt|power|^acStatus$/i
  const snapshot: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (interesting.test(key)) snapshot[key] = value
  }
  const components = data.components
  if (isMergeableObject(components)) {
    for (const [key, value] of Object.entries(components)) {
      if (interesting.test(key)) snapshot[`components.${key}`] = value
    }
  }
  return snapshot
}

function isMergeableObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shallow-merge an update over a previous value, preserving unmentioned keys. */
function mergeObject<T>(previous: T | undefined, update: T | undefined): T | undefined {
  if (update === undefined) return previous
  if (isMergeableObject(previous) && isMergeableObject(update)) {
    return { ...previous, ...update } as T
  }
  return update
}

export abstract class BaseAccessory {
  /** RxJS subscriptions to clean up on destroy */
  protected readonly subscriptions: Subscription[] = []

  /** Emits the current availability of this accessory's connection */
  private readonly available$: Observable<boolean>

  /**
   * Last battery percentage we could actually determine. Starts at 100
   * because HomeKit's BatteryLevel has no "unknown" value: until the
   * detector reports something we can map, the level is a placeholder and
   * the low-battery warning (which never guesses) is the signal that counts.
   */
  private lastKnownBatteryPercent = 100

  /** Numeric level at or below which the low-battery warning is raised */
  private readonly lowBatteryThreshold: number

  constructor(
    protected readonly accessory: PlatformAccessory,
    protected readonly deviceData: BehaviorSubject<SmokeDetectorDeviceData>,
    private readonly availability?: AvailabilitySource,
    options: AccessoryOptions = {},
  ) {
    this.available$ = availability ? availability.onConnected : of(true)

    const threshold = options.lowBatteryThreshold
    this.lowBatteryThreshold =
      typeof threshold === 'number' && threshold >= 0 && threshold <= 100
        ? threshold
        : DEFAULT_LOW_BATTERY_THRESHOLD

    const initial = deviceData.value
    logDebug(
      `Battery data reported for "${initial.name || initial.zid}": ${JSON.stringify(batterySnapshot(initial))}`,
    )

    // Set the mandatory AccessoryInformation service.
    // This shows up in the HomeKit app's accessory details.
    // Registered against the data stream (not set once) because the
    // initial payload may lack serial/firmware info that a later
    // device-list poll fills in.
    //
    // These are static metadata, so they are NOT gated on availability:
    // an offline detector should still show its model and serial.
    const infoService = accessory.getService(
      hap.Service.AccessoryInformation,
    )!

    this.registerCharacteristic(
      infoService,
      hap.Characteristic.Manufacturer,
      (data) => data.manufacturerName || 'Kidde',
      { gated: false },
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.Model,
      (data) => data.deviceType || 'Ring Smoke Detector',
      { gated: false },
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.SerialNumber,
      (data) => data.serialNumber || data.zid,
      { gated: false },
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.FirmwareRevision,
      (data) => data.components?.['firmware-version']?.main || '1.0',
      { gated: false },
    )
  }

  /** The device state currently presented to HomeKit */
  get currentData(): SmokeDetectorDeviceData {
    return this.deviceData.value
  }

  /** Whether this detector is currently reporting */
  protected get isAvailable(): boolean {
    return this.availability ? this.availability.connected : true
  }

  /**
   * Get an existing service or add a new one.
   * Reuses cached services from previous runs to preserve HomeKit pairings.
   */
  protected getOrAddService(serviceType: WithUUID<typeof Service>): Service {
    return (
      this.accessory.getService(serviceType) ||
      this.accessory.addService(serviceType as unknown as Service)
    )
  }

  /**
   * Bind a HomeKit characteristic to the device data stream.
   *
   * This is the core pattern: a getValue function extracts the relevant
   * value from the device data, and we wire it up for both:
   * - onGet: response when HomeKit polls
   * - subscribe: push updates when the WebSocket delivers new data
   *
   * getValue may return undefined to mean "no value known" (for example an
   * unrecognized battery category). Undefined and unavailable both surface
   * as a characteristic error, which HAP reports as
   * SERVICE_COMMUNICATION_FAILURE, so HomeKit shows "No Response" rather
   * than a stale or fabricated reading.
   */
  protected registerCharacteristic(
    service: Service,
    characteristic: WithUUID<new () => Characteristic>,
    getValue: (data: SmokeDetectorDeviceData) => CharacteristicValue | undefined,
    options: { gated?: boolean } = {},
  ): void {
    const gated = options.gated !== false
    const char = service.getCharacteristic(characteristic)

    // Respond to HomeKit polling with the latest known value
    char.onGet(() => {
      if (gated && !this.isAvailable) {
        throw UNAVAILABLE_ERROR()
      }
      const value = getValue(this.deviceData.value)
      if (value === undefined) {
        throw UNAVAILABLE_ERROR()
      }
      return value
    })

    // Push updates reactively when device data or availability changes.
    // distinctUntilChanged() prevents redundant HomeKit updates.
    //
    // getValue runs on raw data from Ring. If it ever throws, the value is
    // treated as unknown: an exception here would otherwise end this stream
    // for good and surface as an uncaught exception.
    const safeValue = (data: SmokeDetectorDeviceData) => {
      try {
        return getValue(data)
      } catch {
        return undefined
      }
    }
    const source = gated
      ? combineLatest([this.deviceData, this.available$]).pipe(
          map(([data, available]) =>
            available ? safeValue(data) : undefined,
          ),
        )
      : this.deviceData.pipe(map(safeValue))

    const sub = source
      .pipe(distinctUntilChanged())
      .subscribe((value) => {
        if (value === undefined) {
          char.updateValue(UNAVAILABLE_ERROR())
        } else {
          char.updateValue(value)
        }
      })

    this.subscriptions.push(sub)
  }

  /**
   * Set up the Battery service.
   *
   * These detectors report a categorical batteryStatus ("full", "low", ...),
   * not a numeric percentage, so the level is an approximation of that
   * category. A numeric batteryLevel is used instead whenever the firmware
   * does report one.
   *
   * HomeKit's BatteryLevel cannot express "unknown", so an unrecognized or
   * missing status holds the last level that could be determined. The
   * low-battery warning is the part to trust: it is raised only on real
   * evidence (the "low" category, or a numeric level at or below the
   * configured threshold) and never from a placeholder.
   */
  protected setupBatteryService(): void {
    const battery = this.getOrAddService(hap.Service.Battery)

    // An unrecognized category must not go through the unavailable-error
    // channel: that is reserved for "the Ring connection is down", and using
    // it here would present a perfectly healthy detector as Not Responding
    // in HomeKit over nothing more than an unmapped battery string. Hold the
    // last known level instead, and log the unknown value so it can be added.
    this.registerCharacteristic(
      battery,
      hap.Characteristic.BatteryLevel,
      (data) => this.batteryPercent(data) ?? this.lastKnownBatteryPercent,
    )

    this.registerLowBattery(battery)

    // These detectors run on replaceable or sealed cells, so the honest
    // default is "not chargeable" rather than "not charging". The charging
    // spellings are still honored in case some firmware reports them.
    this.registerCharacteristic(
      battery,
      hap.Characteristic.ChargingState,
      (data) => {
        if (data.batteryStatus === 'charging') {
          return hap.Characteristic.ChargingState.CHARGING
        }
        if (data.batteryStatus === 'charged') {
          return hap.Characteristic.ChargingState.NOT_CHARGING
        }
        return hap.Characteristic.ChargingState.NOT_CHARGEABLE
      },
    )
  }

  /**
   * Bind the low-battery warning to a service.
   *
   * Registered on the Battery service and on each sensor service, so the
   * warning shows on the sensor tile itself and not only in the accessory's
   * battery details.
   */
  protected registerLowBattery(service: Service): void {
    this.registerCharacteristic(
      service,
      hap.Characteristic.StatusLowBattery,
      (data) =>
        this.isLowBattery(data)
          ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )
  }

  /**
   * Whether the battery needs attention.
   *
   * The categorical "low" always counts. A numeric level also counts when
   * it is at or below the configured threshold, so firmware that reports a
   * percentage raises the warning even if its category has not caught up.
   * 'none' means no battery data, not an empty battery, and never counts.
   */
  private isLowBattery(data: SmokeDetectorDeviceData): boolean {
    if (data.batteryStatus === 'low') return true
    const level = data.batteryLevel
    return (
      typeof level === 'number' &&
      Number.isFinite(level) &&
      level <= this.lowBatteryThreshold
    )
  }

  /**
   * Approximate battery percentage, or undefined when it cannot be known.
   * A numeric batteryLevel is preferred when the firmware reports one.
   */
  private batteryPercent(
    data: SmokeDetectorDeviceData,
  ): number | undefined {
    const percent = this.computeBatteryPercent(data)
    if (percent !== undefined) this.lastKnownBatteryPercent = percent
    return percent
  }

  private computeBatteryPercent(
    data: SmokeDetectorDeviceData,
  ): number | undefined {
    const level = data.batteryLevel
    if (typeof level === 'number' && Number.isFinite(level)) {
      return Math.max(0, Math.min(100, Math.round(level)))
    }

    const status = data.batteryStatus
    // No status, or the explicit "no battery data" status: nothing to map
    if (status === undefined || status === BATTERY_STATUS_NO_DATA) {
      return undefined
    }

    const percent = BATTERY_STATUS_PERCENT[status]
    if (percent === undefined) {
      if (!warnedBatteryStatus.has(status)) {
        warnedBatteryStatus.add(status)
        logWarn(
          `Unrecognized batteryStatus "${status}"; keeping the last known battery level. ` +
            'Please report this value on the issue tracker so it can be mapped.',
        )
      }
      return undefined
    }
    return percent
  }

  /**
   * Surface device health on the primary sensor service:
   * - StatusTampered: the physical tamper switch
   * - StatusFault: device malfunctions, end-of-life sensors, AC power
   *   failure on wired models, or an explicit faulted flag
   *
   * These states are already delivered over the WebSocket; without them a
   * detector that can no longer detect anything looks perfectly healthy
   * in HomeKit.
   */
  protected setupStatusCharacteristics(service: Service): void {
    this.registerCharacteristic(
      service,
      hap.Characteristic.StatusTampered,
      (data) =>
        data.tamperStatus === 'tamper'
          ? hap.Characteristic.StatusTampered.TAMPERED
          : hap.Characteristic.StatusTampered.NOT_TAMPERED,
    )

    this.registerCharacteristic(
      service,
      hap.Characteristic.StatusFault,
      (data) =>
        data.faulted === true ||
        (data.components?.malfunctions?.current?.length ?? 0) > 0 ||
        data.components?.['alarm.end-of-life']?.alarmStatus === 'active' ||
        data.acStatus === 'error' ||
        // Ring's own view of whether it can reach the detector. Only the
        // confirmed unhealthy value raises a fault; other spellings are
        // logged by instrumentUnknownStates so they can be mapped.
        data.commStatus === 'error'
          ? hap.Characteristic.StatusFault.GENERAL_FAULT
          : hap.Characteristic.StatusFault.NO_FAULT,
    )
  }

  /**
   * Remove services that this accessory type doesn't use.
   * This handles the case where a cached accessory had different
   * services from a previous plugin version.
   */
  protected pruneUnusedServices(
    keepServices: WithUUID<typeof Service>[],
  ): void {
    const keepSet = new Set<string>(
      keepServices.map((s) => s.UUID),
    )
    // Always keep AccessoryInformation (required by HomeKit)
    keepSet.add(hap.Service.AccessoryInformation.UUID)

    // Iterate a copy: removeService mutates the live array, and removing
    // while iterating skips the element after each removed one
    for (const service of [...this.accessory.services]) {
      if (!keepSet.has(service.UUID)) {
        this.accessory.removeService(service)
      }
    }
  }

  /**
   * Merge new state from the WebSocket into the known device data.
   * This triggers all registered characteristic subscriptions to
   * re-evaluate and push updates to HomeKit if values changed.
   *
   * DataUpdate payloads are PARTIAL: they contain only the fields that
   * changed. Replacing the whole state object with a partial update would
   * flip an active smoke alarm back to "clear" and reset the battery
   * whenever an unrelated field updates. The merge therefore goes two
   * levels deep: an update may carry a single component, and that
   * component may itself carry only the one field that changed. Merging
   * only one level would let `{"alarm.smoke": {"relayStatus": "clear"}}`
   * drop an active alarmStatus.
   */
  updateData(data: SmokeDetectorDeviceData): void {
    const previous = this.deviceData.value
    const merged: SmokeDetectorDeviceData = {
      ...previous,
      ...data,
      components: this.mergeComponents(previous.components, data.components),
      // The legacy flat alarm objects are read by the alarm characteristics
      // just like components are, so they need the same protection: a
      // partial {smoke:{relayStatus}} must not drop an active alarmStatus.
      smoke: mergeObject(previous.smoke, data.smoke),
      co: mergeObject(previous.co, data.co),
    }
    this.instrumentUnknownStates(merged)
    this.logBatteryChange(previous, merged)
    this.deviceData.next(merged)
  }

  /**
   * Log battery transitions. They are rare and worth seeing: this is how a
   * "full" to "low" change (or a firmware that starts reporting a numeric
   * level) shows up in the Homebridge log.
   */
  private logBatteryChange(
    previous: SmokeDetectorDeviceData,
    current: SmokeDetectorDeviceData,
  ): void {
    if (
      previous.batteryStatus === current.batteryStatus &&
      previous.batteryLevel === current.batteryLevel
    ) {
      return
    }
    const describe = (d: SmokeDetectorDeviceData) =>
      [
        d.batteryStatus ?? 'no status',
        typeof d.batteryLevel === 'number' ? `${d.batteryLevel}%` : undefined,
      ]
        .filter(Boolean)
        .join(', ')
    logInfo(
      `Battery for "${current.name || current.zid}" changed: ${describe(previous)} -> ${describe(current)}`,
    )
  }

  // NOTE: there is deliberately no "replace wholesale" entry point.
  //
  // Device-list responses look authoritative, but the websocket accumulates
  // them separately from the DataUpdate channel, so the accumulated document
  // does NOT contain alarm deltas delivered since the last poll. Replacing
  // state with it would clear an alarm that is still active. Merging is the
  // safe direction in both cases: a document that explicitly reports
  // "inactive" still clears the alarm, while one that simply omits the key
  // leaves the known state intact.

  private mergeComponents(
    previous: SmokeDetectorDeviceData['components'],
    update: SmokeDetectorDeviceData['components'],
  ): SmokeDetectorDeviceData['components'] {
    if (!update) return previous
    const merged: Record<string, any> = { ...previous }
    for (const [key, value] of Object.entries(update)) {
      const existing = merged[key]
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        merged[key] = { ...existing, ...value }
      } else {
        merged[key] = value
      }
    }
    return merged as SmokeDetectorDeviceData['components']
  }

  /**
   * Log alarm states we don't recognize, without treating them as alarms.
   * Only "active" triggers HomeKit, so an undocumented value would silently
   * read as "clear"; surfacing it lets the enum be pinned down from real
   * hardware instead of guessed.
   */
  private instrumentUnknownStates(data: SmokeDetectorDeviceData): void {
    for (const key of ['alarm.smoke', 'alarm.co'] as const) {
      const status = data.components?.[key]?.alarmStatus as string | undefined
      if (
        status !== undefined &&
        status !== 'active' &&
        status !== 'inactive' &&
        !warnedAlarmStatus.has(`${key}:${status}`)
      ) {
        warnedAlarmStatus.add(`${key}:${status}`)
        logWarn(
          `Unrecognized ${key} alarmStatus "${status}" on ${data.name || data.zid}; ` +
            'treating it as not alarming. Please report this value on the issue tracker.',
        )
      }
    }

    const comm = data.commStatus
    if (
      typeof comm === 'string' &&
      comm !== 'ok' &&
      comm !== 'error' &&
      !warnedCommStatus.has(comm)
    ) {
      warnedCommStatus.add(comm)
      logWarn(
        `Unrecognized commStatus "${comm}" on ${data.name || data.zid}; ` +
          'not treating it as a fault. Please report this value on the issue tracker.',
      )
    }
  }

  /** Clean up RxJS subscriptions when the accessory is removed */
  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions.length = 0
  }
}
