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

    // Smoke Sensor service, which triggers HomeKit smoke alerts
    const smokeSensor = this.getOrAddService(hap.Service.SmokeSensor)

    this.registerCharacteristic(
      smokeSensor,
      hap.Characteristic.SmokeDetected,
      (data) => {
        // Check both the legacy flat field and the components structure.
        // Different firmware versions may use different data shapes.
        // For a life-safety alert, "active" in EITHER location wins;
        // a stale 'inactive' in one shape must never mask a live alarm
        // reported in the other.
        const active =
          data.smoke?.alarmStatus === 'active' ||
          data.components?.['alarm.smoke']?.alarmStatus === 'active'
        return active
          ? hap.Characteristic.SmokeDetected.SMOKE_DETECTED
          : hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      },
    )

    // Tamper and fault reporting on the primary service
    this.setupStatusCharacteristics(smokeSensor)

    // Carbon Monoxide Sensor service, triggers HomeKit CO alerts
    const coSensor = this.getOrAddService(
      hap.Service.CarbonMonoxideSensor,
    )

    this.registerCharacteristic(
      coSensor,
      hap.Characteristic.CarbonMonoxideDetected,
      (data) => {
        const active =
          data.co?.alarmStatus === 'active' ||
          data.components?.['alarm.co']?.alarmStatus === 'active'
        return active
          ? hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
      },
    )

    // CO Level in PPM from the co.level component, clamped to the
    // characteristic's valid 0-100 range so an out-of-range reading
    // can't be rejected by HAP
    this.registerCharacteristic(
      coSensor,
      hap.Characteristic.CarbonMonoxideLevel,
      (data) =>
        Math.max(0, Math.min(100, data.components?.['co.level']?.reading ?? 0)),
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
