import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSim, deviceDoc, kiddeAsset, smoke, isResponding, sleep, until } from './helpers/sim.mjs'

/** One location with a Hallway and a Kitchen detector */
function twoDetectorHome(sim) {
  sim.locations = [{ location_id: 'L1', name: 'Home' }]
  sim.assets.L1 = [kiddeAsset('A1'), kiddeAsset('A2')]
  sim.docs.A1 = deviceDoc('A1', 'Hallway')
  sim.docs.A2 = deviceDoc('A2', 'Kitchen')
}

test("a poll answer from one detector does not clear another detector's alarm", async (t) => {
  const sim = createSim(t)
  twoDetectorHome(sim)
  const { accessory } = await sim.boot()
  const kitchen = accessory('Kitchen')
  const changes = []
  smoke(kitchen).on('change', ({ newValue }) => changes.push(newValue))
  const socket = sim.socketFor('L1')

  sim.pushUpdate(socket, 'A2', { 'alarm.smoke': { alarmStatus: 'active' } })
  assert.equal(smoke(kitchen).value, 1, 'kitchen alarm reaches HomeKit')

  // The next poll: the HALLWAY detector answers, with some field changed.
  // The kitchen's last poll document (from before the alarm) must not be replayed.
  sim.docs.A1 = deviceDoc('A1', 'Hallway', { lastCommTime: 2 })
  sim.answerPoll(socket, 'A1')
  await sleep(10)

  assert.equal(smoke(kitchen).value, 1, 'kitchen is still alarming')
  assert.deepEqual(changes, [1], 'HomeKit never saw the alarm clear')

  // The kitchen itself reporting inactive is what clears it
  sim.answerPoll(socket, 'A2')
  assert.equal(smoke(kitchen).value, 0)
})

test('a detector that goes quiet shows as not responding while the others stay up', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const sim = createSim(t)
  twoDetectorHome(sim)
  const { accessory } = await sim.boot()
  const hallway = accessory('Hallway')
  const kitchen = accessory('Kitchen')
  assert.ok(isResponding(hallway) && isResponding(kitchen))
  const socket = sim.socketFor('L1')

  // Three minutes pass in which only the hallway detector keeps answering
  sim.silent.add('A2')
  t.mock.timers.setTime(Date.now() + 181_000)
  sim.answerPoll(socket, 'A1')

  assert.ok(isResponding(hallway), 'hallway keeps reporting')
  assert.ok(!isResponding(kitchen), 'kitchen stops presenting its last reading as current')
  assert.ok(sim.logged(/Detector "Kitchen".*has not reported/))

  // A pushed alarm is proof of life and must never be suppressed
  sim.pushUpdate(socket, 'A2', { 'alarm.smoke': { alarmStatus: 'active' } })
  assert.ok(isResponding(kitchen))
  assert.equal(smoke(kitchen).value, 1)
})

test('after a reconnect, a detector stays not responding until it reports again', async (t) => {
  const sim = createSim(t)
  twoDetectorHome(sim)
  const { accessory } = await sim.boot()
  const hallway = accessory('Hallway')
  const kitchen = accessory('Kitchen')

  sim.silent.add('A2')
  sim.socketFor('L1').drop()
  assert.ok(!isResponding(hallway) && !isResponding(kitchen), 'both go down with the connection')

  // Reconnect backoff is about five seconds
  await until(() => isResponding(hallway), { timeout: 9000, what: 'the reconnect' })
  assert.ok(!isResponding(kitchen), 'kitchen has not been heard from on the new connection')

  sim.silent.delete('A2')
  sim.answerPoll(sim.socketFor('L1'), 'A2')
  assert.ok(isResponding(kitchen))
})
