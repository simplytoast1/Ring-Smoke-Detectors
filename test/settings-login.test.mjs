import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSim, deviceDoc, kiddeAsset } from './helpers/sim.mjs'
import { RingRestClient } from '../dist/ring-api/ring-rest-client.js'
import { completeLogin } from '../dist/homebridge-ui/login-discovery.js'
import { readDeviceCache, writeDeviceCache } from '../dist/ring-api/device-cache.js'

// Dummy credentials: every request in these tests goes to the simulated Ring
const credentials = { email: 'user@example.test', password: 'not-a-real-password' }
const tokenInside = (refreshToken) => JSON.parse(Buffer.from(refreshToken, 'base64').toString()).rt
const names = (devices) => devices.map((d) => d.name).sort()

/** Two detectors at home, and a cabin with one */
function account(sim) {
  sim.locations = [
    { location_id: 'L1', name: 'Home' },
    { location_id: 'L2', name: 'Cabin' },
  ]
  sim.assets.L1 = [kiddeAsset('A1'), kiddeAsset('A2')]
  sim.assets.L2 = [kiddeAsset('A3')]
  sim.docs.A1 = deviceDoc('A1', 'Hallway')
  sim.docs.A2 = deviceDoc('A2', 'Kitchen')
  sim.docs.A3 = deviceDoc('A3', 'Loft')
}

test('a password login scans for devices without spending the new token', async (t) => {
  const sim = createSim(t)
  account(sim)
  const client = new RingRestClient(credentials)
  await client.getCurrentAuth()

  const result = await completeLogin(client, sim.storage)

  assert.deepEqual(names(result.devices), ['Hallway', 'Kitchen', 'Loft'])
  assert.equal(sim.tokenSeq, 1, 'Ring was asked for a token exactly once')
  assert.equal(tokenInside(result.refreshToken), 'rt1', 'the page gets the token the login produced')
  assert.equal(result.scanFailed, false)
})

test('a 2FA login scans for devices without spending the new token', async (t) => {
  const sim = createSim(t)
  account(sim)
  const client = new RingRestClient(credentials)
  await client.authenticateWithCode('123456')

  const result = await completeLogin(client, sim.storage)

  assert.deepEqual(names(result.devices), ['Hallway', 'Kitchen', 'Loft'])
  assert.equal(sim.tokenSeq, 1, 'no second sign-in with the brand new refresh token')
  assert.equal(tokenInside(result.refreshToken), 'rt1')
})

test("the login scan seeds an empty device list and never replaces the plugin's", async (t) => {
  const sim = createSim(t)
  account(sim)

  const first = new RingRestClient(credentials)
  await first.getCurrentAuth()
  await completeLogin(first, sim.storage)
  assert.deepEqual(names(await readDeviceCache(sim.storage)), ['Hallway', 'Kitchen', 'Loft'], 'list survives reopening the page')

  // Once the running plugin has written its own list, that list wins
  const fromPlugin = [{ zid: 'A1', name: 'Hallway (plugin)', deviceType: 'comp.bluejay.sensor_bluejay_wsc', locationName: 'Home' }]
  await writeDeviceCache(sim.storage, fromPlugin)
  const second = new RingRestClient(credentials)
  await second.getCurrentAuth()
  await completeLogin(second, sim.storage)
  assert.deepEqual(await readDeviceCache(sim.storage), fromPlugin)
})

test('an unreachable location is reported, and a partial list is not cached', async (t) => {
  const sim = createSim(t)
  account(sim)
  sim.failTickets.add('L2')
  const client = new RingRestClient(credentials)
  await client.getCurrentAuth()

  t.mock.method(console, 'error', () => {})
  const result = await completeLogin(client, sim.storage)

  assert.deepEqual(names(result.devices), ['Hallway', 'Kitchen'])
  assert.deepEqual(result.failedLocations, ['Cabin'])
  assert.deepEqual(await readDeviceCache(sim.storage), [])
})

test('a scan that cannot run does not fail the login', async (t) => {
  const sim = createSim(t)
  account(sim)
  sim.failLocations = true
  const client = new RingRestClient(credentials)
  await client.getCurrentAuth()

  t.mock.method(console, 'error', () => {})
  const result = await completeLogin(client, sim.storage)

  assert.equal(result.scanFailed, true)
  assert.deepEqual(result.devices, [])
  assert.equal(tokenInside(result.refreshToken), 'rt1', 'the login still hands back its token')
})
