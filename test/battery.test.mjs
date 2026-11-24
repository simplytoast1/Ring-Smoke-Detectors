import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BehaviorSubject } from 'rxjs'
import { hap, FakePlatformAccessory } from './helpers/sim.mjs'
import { SmokeCoDetectorAccessory } from '../dist/accessories/smoke-co-detector.js'

const { Service, Characteristic } = hap
const LOW = Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
const NORMAL = Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL

let seq = 0
function detector(initial, options) {
  const zid = `B${++seq}`
  const accessory = new FakePlatformAccessory('Detector', hap.uuid.generate(zid))
  const data = new BehaviorSubject({ zid, name: 'Detector', deviceType: 'comp.bluejay.sensor_bluejay_wsc', ...initial })
  const handler = new SmokeCoDetectorAccessory(accessory, data, undefined, options)
  const read = (service, characteristic) => accessory.getService(service).getCharacteristic(characteristic).value
  return {
    update: (patch) => handler.updateData({ zid, ...patch }),
    level: () => read(Service.Battery, Characteristic.BatteryLevel),
    low: (service = Service.Battery) => read(service, Characteristic.StatusLowBattery),
    charging: () => read(Service.Battery, Characteristic.ChargingState),
  }
}

test('battery categories map to a level and only "low" raises the warning', () => {
  const d = detector({ batteryStatus: 'full' })
  assert.equal(d.level(), 100)
  assert.equal(d.low(), NORMAL)

  d.update({ batteryStatus: 'ok' })
  assert.equal(d.level(), 75)
  assert.equal(d.low(), NORMAL)

  d.update({ batteryStatus: 'low' })
  assert.equal(d.level(), 10)
  assert.equal(d.low(), LOW)
})

test('the low-battery warning shows on the sensor services too', () => {
  const d = detector({ batteryStatus: 'low' })
  assert.equal(d.low(Service.Battery), LOW)
  assert.equal(d.low(Service.SmokeSensor), LOW)
  assert.equal(d.low(Service.CarbonMonoxideSensor), LOW)
})

test('a numeric level is used when reported, with a configurable low threshold', () => {
  const d = detector({ batteryStatus: 'full', batteryLevel: 64 })
  assert.equal(d.level(), 64, 'the number wins over the category')
  assert.equal(d.low(), NORMAL)

  d.update({ batteryLevel: 20 })
  assert.equal(d.low(), LOW, 'default threshold is 20')

  const strict = detector({ batteryStatus: 'full', batteryLevel: 35 }, { lowBatteryThreshold: 40 })
  assert.equal(strict.low(), LOW)
})

test('"none" and unknown statuses keep the last known level instead of showing 0%', () => {
  const d = detector({ batteryStatus: 'ok' })
  d.update({ batteryStatus: 'none' })
  assert.equal(d.level(), 75)
  assert.equal(d.low(), NORMAL)
  d.update({ batteryStatus: 'something-new' })
  assert.equal(d.level(), 75)
})

test('replaceable cells report as not chargeable', () => {
  const d = detector({ batteryStatus: 'full' })
  assert.equal(d.charging(), Characteristic.ChargingState.NOT_CHARGEABLE)
  d.update({ batteryStatus: 'charging' })
  assert.equal(d.charging(), Characteristic.ChargingState.CHARGING)
})

test('a detector Ring cannot reach raises a fault', () => {
  const accessory = new FakePlatformAccessory('Detector', hap.uuid.generate('F1'))
  const data = new BehaviorSubject({ zid: 'F1', name: 'Detector', deviceType: 'comp.bluejay.sensor_bluejay_wsc', commStatus: 'ok' })
  const handler = new SmokeCoDetectorAccessory(accessory, data)
  const fault = () => accessory.getService(Service.SmokeSensor).getCharacteristic(Characteristic.StatusFault).value
  assert.equal(fault(), Characteristic.StatusFault.NO_FAULT)
  handler.updateData({ zid: 'F1', commStatus: 'error' })
  assert.equal(fault(), Characteristic.StatusFault.GENERAL_FAULT)
})
