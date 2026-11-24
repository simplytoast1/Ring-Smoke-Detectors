import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDeviceCache } from '../dist/ring-api/device-cache.js'

const serverPath = fileURLToPath(new URL('../dist/homebridge-ui/server.js', import.meta.url))

/**
 * Start the real settings server the way the Homebridge UI does: as a child
 * process that is sent requests and answers over the process channel.
 */
async function startServer(t, storage) {
  const child = fork(serverPath, [], {
    silent: true,
    env: {
      ...process.env,
      HOMEBRIDGE_STORAGE_PATH: storage,
      HOMEBRIDGE_CONFIG_PATH: join(storage, 'config.json'),
    },
  })
  t.after(() => child.kill())

  const pending = new Map()
  let ready
  const isReady = new Promise((resolve) => (ready = resolve))
  child.on('message', (message) => {
    if (message.action === 'ready') ready()
    if (message.action === 'response') pending.get(message.payload.requestId)?.(message.payload)
  })
  await isReady

  let seq = 0
  return (path, body) =>
    new Promise((resolve) => {
      const requestId = `r${++seq}`
      pending.set(requestId, resolve)
      child.send({ action: 'request', requestId, path, body })
    })
}

test('the settings server answers from disk without signing in to Ring', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'ring-smoke-ui-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  writeFileSync(
    join(storage, 'config.json'),
    JSON.stringify({ platforms: [{ platform: 'RingSmokeDetectors', refreshToken: 'TOKEN_ON_DISK' }] }),
  )
  const cached = [{ zid: 'A1', name: 'Hallway', deviceType: 'comp.bluejay.sensor_bluejay_wsc', locationName: 'Home' }]
  await writeDeviceCache(storage, cached)

  const request = await startServer(t, storage)

  // The device list is the plugin's cache. The old "forceRefresh" flag, which
  // made the server sign in with the saved token, no longer does anything.
  const devices = await request('/devices', { refreshToken: 'TOKEN_ON_DISK', forceRefresh: true })
  assert.equal(devices.success, true)
  assert.deepEqual(devices.data, { devices: cached, fromCache: true, cacheEmpty: false })

  const token = await request('/current-token')
  assert.deepEqual(token.data, { refreshToken: 'TOKEN_ON_DISK' })

  const badLogin = await request('/send-code', { email: '', password: '' })
  assert.equal(badLogin.success, false)
  assert.match(badLogin.data.message, /Email and password are required/)
})
