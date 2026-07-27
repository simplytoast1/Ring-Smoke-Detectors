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
 * AVAILABILITY: sensor characteristics are tied to the location's WebSocket
 * connection. While that connection is down, they report an error so HomeKit
 * shows "No Response" instead of the last known state. Without this, a dead
 * connection is indistinguishable from "no smoke", which is the worst
 * possible failure mode for a life-safety sensor.
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
import { logWarn } from '../util.js'
import {
  BATTERY_STATUS_PERCENT,
  type SmokeDetectorDeviceData,
} from '../ring-api/types.js'

/**
 * Connection health for the location serving this accessory. The WebSocket
 * class satisfies this shape.
 */
export interface AvailabilitySource {
  readonly connected: boolean
  readonly onConnected: Observable<boolean>
}

/** Thrown from characteristic reads while the Ring connection is down. */
const UNAVAILABLE_ERROR = () =>
  new Error('Ring connection unavailable for this detector')

/** Battery/alarm status spellings already warned about, to avoid log spam */
const warnedBatteryStatus = new Set<string>()
const warnedAlarmStatus = new Set<string>()

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

  /** Last battery percentage we could actually determine */
  private lastKnownBatteryPercent = 100

  constructor(
    protected readonly accessory: PlatformAccessory,
    protected readonly deviceData: BehaviorSubject<SmokeDetectorDeviceData>,
    private readonly availability?: AvailabilitySource,
  ) {
    this.available$ = availability ? availability.onConnected : of(true)

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

  /** Whether the Ring connection serving this accessory is up */
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
    const source = gated
      ? combineLatest([this.deviceData, this.available$]).pipe(
          map(([data, available]) =>
            available ? getValue(data) : undefined,
          ),
        )
      : this.deviceData.pipe(map(getValue))

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
   * category. An unrecognized or missing status reports no value at all
   * rather than a fabricated one: claiming 100% on a detector whose battery
   * state is actually unknown is exactly the wrong direction to guess in.
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

    this.registerCharacteristic(
      battery,
      hap.Characteristic.StatusLowBattery,
      // 'none' means no battery data (wired models), not an empty battery,
      // so only 'low' should raise the HomeKit low-battery warning
      (data) =>
        data.batteryStatus === 'low'
          ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )

    this.registerCharacteristic(
      battery,
      hap.Characteristic.ChargingState,
      (data) =>
        data.batteryStatus === 'charging'
          ? hap.Characteristic.ChargingState.CHARGING
          : hap.Characteristic.ChargingState.NOT_CHARGING,
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
    if (status === undefined) return undefined

    const percent = BATTERY_STATUS_PERCENT[status]
    if (percent === undefined) {
      if (!warnedBatteryStatus.has(status)) {
        warnedBatteryStatus.add(status)
        logWarn(
          `Unrecognized batteryStatus "${status}"; reporting battery level as unknown. ` +
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
        data.acStatus === 'error'
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
    this.deviceData.next(merged)
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
  }

  /** Clean up RxJS subscriptions when the accessory is removed */
  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions.length = 0
  }
}
