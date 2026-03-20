/**
 * Smoke-Only Detector Accessory
 *
 * HomeKit accessory for Kidde/Ring smoke-only detectors (no CO sensor).
 * Used for sensor_bluejay_ws (wired, smoke-only) models.
 *
 * Exposes two HomeKit services:
 * - SmokeSensor: SmokeDetected characteristic
 * - Battery: BatteryLevel, StatusLowBattery, ChargingState
 *
 * Note: No CarbonMonoxideSensor service — these devices don't have CO sensors.
 */

import type { PlatformAccessory } from 'homebridge'
import { BehaviorSubject } from 'rxjs'
import { hap } from '../hap.js'
import type { SmokeDetectorDeviceData } from '../ring-api/types.js'
import { BaseAccessory } from './base-accessory.js'

export class SmokeDetectorAccessory extends BaseAccessory {
  constructor(
    accessory: PlatformAccessory,
    deviceData: BehaviorSubject<SmokeDetectorDeviceData>,
  ) {
    super(accessory, deviceData)

    // Smoke Sensor service only (no CO for this device type)
    const smokeSensor = this.getOrAddService(hap.Service.SmokeSensor)

    this.registerCharacteristic(
      smokeSensor,
      hap.Characteristic.SmokeDetected,
      (data) => {
        // Check both the legacy flat field and the components structure
        // for compatibility across firmware versions
        const status =
          data.smoke?.alarmStatus ??
          data.components?.['alarm.smoke']?.alarmStatus
        return status === 'active'
          ? hap.Characteristic.SmokeDetected.SMOKE_DETECTED
          : hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      },
    )

    // Battery service
    this.setupBatteryService()

    // Clean up any stale services from previous plugin versions
    this.pruneUnusedServices([
      hap.Service.SmokeSensor,
      hap.Service.Battery,
    ])
  }
}
