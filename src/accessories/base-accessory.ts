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
 */

import type {
  PlatformAccessory,
  Service,
  Characteristic,
  CharacteristicValue,
  WithUUID,
} from 'homebridge'
import { BehaviorSubject, Subscription } from 'rxjs'
import { map, distinctUntilChanged } from 'rxjs/operators'
import { hap } from '../hap.js'
import type { SmokeDetectorDeviceData } from '../ring-api/types.js'

export abstract class BaseAccessory {
  /** RxJS subscriptions to clean up on destroy */
  protected readonly subscriptions: Subscription[] = []

  constructor(
    protected readonly accessory: PlatformAccessory,
    protected readonly deviceData: BehaviorSubject<SmokeDetectorDeviceData>,
  ) {
    // Set the mandatory AccessoryInformation service.
    // This shows up in the HomeKit app's accessory details.
    // Registered against the data stream (not set once) because the
    // initial payload may lack serial/firmware info that a later
    // device-list poll fills in.
    const infoService = accessory.getService(
      hap.Service.AccessoryInformation,
    )!

    this.registerCharacteristic(
      infoService,
      hap.Characteristic.Manufacturer,
      (data) => data.manufacturerName || 'Kidde',
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.Model,
      (data) => data.deviceType || 'Ring Smoke Detector',
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.SerialNumber,
      (data) => data.serialNumber || data.zid,
    )
    this.registerCharacteristic(
      infoService,
      hap.Characteristic.FirmwareRevision,
      (data) => data.components?.['firmware-version']?.main || '1.0',
    )
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
   * - onGet: synchronous response when HomeKit polls
   * - subscribe: push updates when WebSocket delivers new data
   *
   * The distinctUntilChanged() prevents unnecessary HomeKit updates
   * when the value hasn't actually changed.
   */
  protected registerCharacteristic(
    service: Service,
    characteristic: WithUUID<new () => Characteristic>,
    getValue: (data: SmokeDetectorDeviceData) => CharacteristicValue,
  ): void {
    const char = service.getCharacteristic(characteristic)

    // Respond to HomeKit polling with the latest known value
    char.onGet(() => getValue(this.deviceData.value))

    // Push updates reactively when device data changes via WebSocket
    const sub = this.deviceData
      .pipe(
        map(getValue),
        distinctUntilChanged(),
      )
      .subscribe((value) => {
        char.updateValue(value)
      })

    this.subscriptions.push(sub)
  }

  /**
   * Set up the Battery service.
   * All Kidde detectors report battery info (even wired models have backup batteries).
   */
  protected setupBatteryService(): void {
    const battery = this.getOrAddService(hap.Service.Battery)

    this.registerCharacteristic(
      battery,
      hap.Characteristic.BatteryLevel,
      (data) => data.batteryLevel ?? 100,
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
   * flip an active smoke alarm back to "clear" and reset the battery to
   * its default whenever an unrelated field updates. So we merge: shallow
   * at the top level, one level deeper for the components map (a partial
   * update may carry only the one component that changed).
   */
  updateData(data: SmokeDetectorDeviceData): void {
    const previous = this.deviceData.value
    this.deviceData.next({
      ...previous,
      ...data,
      components: {
        ...previous.components,
        ...data.components,
      },
    })
  }

  /** Clean up RxJS subscriptions when the accessory is removed */
  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions.length = 0
  }
}
