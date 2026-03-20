/**
 * Smoke + CO Detector Accessory
 *
 * HomeKit accessory for Kidde/Ring combo smoke + CO detectors.
 * Used for sensor_bluejay_wsc (wired) and sensor_bluejay_sc (battery) models.
 *
 * Exposes three HomeKit services:
 * - SmokeSensor: SmokeDetected characteristic
 * - CarbonMonoxideSensor: CarbonMonoxideDetected + CarbonMonoxideLevel
 * - Battery: BatteryLevel, StatusLowBattery, ChargingState
 *
 * Alarm state is read from the WebSocket device data. We check two locations
 * for compatibility across firmware versions:
 * - data.components['alarm.smoke'].alarmStatus (newer firmware)
 * - data.smoke.alarmStatus (legacy flat format)
 * This dual-check pattern matches homebridge-ring's smoke-co-listener.ts.
 */

import type { PlatformAccessory } from 'homebridge'
import { BehaviorSubject } from 'rxjs'
import { hap } from '../hap.js'
import type { SmokeDetectorDeviceData } from '../ring-api/types.js'
import { BaseAccessory } from './base-accessory.js'

export class SmokeCoDetectorAccessory extends BaseAccessory {
  constructor(
    accessory: PlatformAccessory,
    deviceData: BehaviorSubject<SmokeDetectorDeviceData>,
  ) {
    super(accessory, deviceData)

    // Smoke Sensor service — triggers HomeKit smoke alerts
    const smokeSensor = this.getOrAddService(hap.Service.SmokeSensor)

    this.registerCharacteristic(
      smokeSensor,
      hap.Characteristic.SmokeDetected,
      (data) => {
        // Check both the legacy flat field and the components structure.
        // Different firmware versions may use different data shapes.
        const status =
          data.smoke?.alarmStatus ??
          data.components?.['alarm.smoke']?.alarmStatus
        return status === 'active'
          ? hap.Characteristic.SmokeDetected.SMOKE_DETECTED
          : hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      },
    )

    // Carbon Monoxide Sensor service — triggers HomeKit CO alerts
    const coSensor = this.getOrAddService(
      hap.Service.CarbonMonoxideSensor,
    )

    this.registerCharacteristic(
      coSensor,
      hap.Characteristic.CarbonMonoxideDetected,
      (data) => {
        const status =
          data.co?.alarmStatus ??
          data.components?.['alarm.co']?.alarmStatus
        return status === 'active'
          ? hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
      },
    )

    // CO Level in PPM — available from the co.level component
    this.registerCharacteristic(
      coSensor,
      hap.Characteristic.CarbonMonoxideLevel,
      (data) => data.components?.['co.level']?.reading ?? 0,
    )

    // Battery service (all models have batteries, even wired ones as backup)
    this.setupBatteryService()

    // Clean up any stale services from previous plugin versions
    this.pruneUnusedServices([
      hap.Service.SmokeSensor,
      hap.Service.CarbonMonoxideSensor,
      hap.Service.Battery,
    ])
  }
}
