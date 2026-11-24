import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSim, deviceDoc, kiddeAsset, hap, FakePlatformAccessory, isResponding, sleep } from './helpers/sim.mjs'

function twoLocations(sim) {
  sim.locations = [
    { location_id: 'L1', name: 'Home' },
    { location_id: 'L2', name: 'Cabin' },
  ]
  sim.assets.L1 = [kiddeAsset('A1')]
  sim.assets.L2 = [kiddeAsset('A2')]
  sim.docs.A1 = deviceDoc('A1', 'Home Hallway')
  sim.docs.A2 = deviceDoc('A2', 'Cabin Loft')
}

test('accessories remember which location they belong to', async (t) => {
  const sim = createSim(t)
  twoLocations(sim)
  const { accessory } = await sim.boot()
  assert.equal(accessory('Home Hallway').context.locationId, 'L1')
  assert.equal(accessory('Cabin Loft').context.locationId, 'L2')
})

test('a restart during which one location is temporarily empty keeps its accessories', async (t) => {
  const sim = createSim(t)
  twoLocations(sim)
  const first = await sim.boot()
  first.api.handlers.shutdown()

  // Homebridge restarts while the cabin detectors are still coming back
  sim.assets.L2 = []
  const second = await sim.boot({ cached: first.api.registered })

  assert.deepEqual(second.api.unregistered, [], 'nothing is removed from HomeKit')
  assert.ok(isResponding(second.accessory('Home Hallway')))
  assert.ok(!isResponding(second.accessory('Cabin Loft')), 'the cabin shows as not responding meanwhile')
  assert.ok(sim.logged(/"Cabin" reported no detectors, but it had some before/))
  assert.ok(sim.logged(/Retrying 1 unreachable location\(s\) in 30s/), 'and it is retried quickly, not in an hour')
})

test('a detector removed from Ring is still cleaned up when another location has none', async (t) => {
  const sim = createSim(t)
  sim.locations = [
    { location_id: 'L1', name: 'Home' },
    { location_id: 'L2', name: 'Office' }, // cameras only, never had a detector
  ]
  sim.assets.L1 = [kiddeAsset('A1')]
  sim.docs.A1 = deviceDoc('A1', 'Hallway')

  const gone = new FakePlatformAccessory('Old Detector', hap.uuid.generate('GONE'))
  gone.context = { zid: 'GONE', deviceType: 'comp.bluejay.sensor_bluejay_wsc', locationId: 'L1' }
  const { api } = await sim.boot({ cached: [gone] })

  assert.deepEqual(api.unregistered.map((a) => a.displayName), ['Old Detector'])
})

test('unexpected entries from Ring are ignored instead of crashing the bridge', async (t) => {
  const sim = createSim(t)
  sim.locations = [{ location_id: 'L1', name: 'Home' }]
  // an asset with no "kind" alongside a real one
  sim.assets.L1 = [{ uuid: 'junk' }, kiddeAsset('A1')]
  sim.docs.A1 = deviceDoc('A1', 'Hallway')

  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  t.after(() => process.off('uncaughtException', onUncaught))

  const { api, accessory } = await sim.boot()
  assert.equal(api.registered.length, 1)

  // a device-list entry with a zid but no deviceType, then outright junk
  const socket = sim.socketFor('L1')
  socket.push({ msg: 'DeviceInfoDocGetList', datatype: 'DeviceInfoDocType', src: 'A1', body: [{ general: { v2: { zid: 'X9', name: 'Mystery' } } }] })
  socket.push({ msg: 'DeviceInfoDocGetList', datatype: 'DeviceInfoDocType', src: 'A1', body: [null, 7, 'text', { general: 'nope' }] })
  socket.push({ msg: 'DataUpdate', datatype: 'DeviceInfoDocType', src: 'A1', body: [{ general: { v2: { zid: 'A1', components: 'not-an-object' } } }] }, 'DataUpdate')
  await sleep(30) // RxJS reports handler exceptions on a timer

  assert.deepEqual(uncaught, [], 'no uncaught exception')
  assert.equal(api.registered.length, 1, 'the mystery device did not become an accessory')
  assert.ok(isResponding(accessory('Hallway')))
})
