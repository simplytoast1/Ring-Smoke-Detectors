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
    const data = deviceData.value

    // Set the mandatory AccessoryInformation service.
    // This shows up in the HomeKit app's accessory details.
    const infoService = accessory.getService(
      hap.Service.AccessoryInformation,
    )!
    infoService
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Kidde')
      .setCharacteristic(
        hap.Characteristic.Model,
        data.deviceType || 'Ring Smoke Detector',
      )
      .setCharacteristic(
        hap.Characteristic.SerialNumber,
        data.serialNumber || data.zid,
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
      (data) =>
        data.batteryStatus === 'low' || data.batteryStatus === 'none'
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

    for (const service of this.accessory.services) {
      if (!keepSet.has(service.UUID)) {
        this.accessory.removeService(service)
      }
    }
  }

  /**
   * Update the device data with new state from the WebSocket.
   * This triggers all registered characteristic subscriptions to
   * re-evaluate and push updates to HomeKit if values changed.
   */
  updateData(data: SmokeDetectorDeviceData): void {
    this.deviceData.next(data)
  }

  /** Clean up RxJS subscriptions when the accessory is removed */
  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions.length = 0
  }
}
