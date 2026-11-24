/**
 * Simulated Ring backend for the regression tests.
 *
 * The tests run the REAL compiled plugin (dist/) end to end. Only the two
 * edges that touch Ring are replaced: global fetch (REST) and the WebSocket
 * factory. Everything in between, including the platform, the connection
 * state machine and the HomeKit accessories, is production code.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHap } from '../../dist/hap.js'
import { setSocketFactory } from '../../dist/ring-api/socket-factory.js'
import { RingSmokeDetectorsPlatform } from '../../dist/platform.js'

const require = createRequire(import.meta.url)
// hap-nodejs as Homebridge itself resolves it, so the classes match
export const hap = createRequire(require.resolve('homebridge'))('hap-nodejs')
setHap(hap)

export const NO_RESPONSE = hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const encodeToken = (rt, hid = 'hid-1') =>
  Buffer.from(JSON.stringify({ rt, hid })).toString('base64')

/** Poll until a condition holds, failing loudly if it never does. */
export async function until(condition, { timeout = 3000, what = 'condition' } = {}) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** Minimal stand-in for Homebridge's PlatformAccessory, backed by real HAP. */
export class FakePlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName
    this.UUID = UUID
    this.context = {}
    this.hapAccessory = new hap.Accessory(displayName, UUID)
  }
  get services() {
    return this.hapAccessory.services
  }
  getService(service) {
    return this.hapAccessory.getService(service)
  }
  addService(service, ...args) {
    return this.hapAccessory.addService(service, ...args)
  }
  removeService(service) {
    this.hapAccessory.removeService(service)
  }
}

/** A raw device document in the shape Ring sends over the websocket. */
export function deviceDoc(zid, name, general = {}, components = {}) {
  return {
    general: {
      v2: {
        zid,
        name,
        deviceType: 'comp.bluejay.sensor_bluejay_wsc',
        batteryStatus: 'full',
        lastCommTime: 1,
        ...general,
      },
    },
    device: {
      v1: {
        components: {
          'alarm.smoke': { alarmStatus: 'inactive' },
          'alarm.co': { alarmStatus: 'inactive' },
          ...components,
        },
      },
    },
  }
}

export const kiddeAsset = (uuid) => ({ kind: 'sensor_bluejay_wsc', uuid, status: 'online' })

class FakeSocket {
  constructor(url, sim) {
    this.url = url
    this.sim = sim
    this.readyState = 0
    this.listeners = { open: [], message: [], close: [], error: [] }
    sim.sockets.push(this)
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.emit('open', {})
    }, 1)
  }
  addEventListener(type, fn) {
    this.listeners[type].push(fn)
  }
  removeEventListener(type, fn) {
    this.listeners[type] = this.listeners[type].filter((f) => f !== fn)
  }
  emit(type, event) {
    for (const fn of [...this.listeners[type]]) fn(event)
  }
  send(raw) {
    const { msg } = JSON.parse(raw)
    if (msg.msg !== 'DeviceInfoDocGetList' || this.sim.silent.has(msg.dst)) return
    setTimeout(() => this.sim.answerPoll(this, msg.dst), 1)
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.emit('close', {}), 1)
  }
  /** Deliver a message from Ring */
  push(msg, channel = 'message') {
    if (this.readyState !== 1) return
    this.emit('message', { data: JSON.stringify({ msg, channel }) })
  }
  /** Simulate the connection dropping */
  drop() {
    this.readyState = 3
    this.emit('close', {})
  }
}

export function createSim(t) {
  const storage = mkdtempSync(join(tmpdir(), 'ring-smoke-test-'))
  const startToken = encodeToken('rt0')
  const configPath = join(storage, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify(
      { bridge: { name: 'Test' }, platforms: [{ platform: 'RingSmokeDetectors', refreshToken: startToken }] },
      null,
      4,
    ),
  )

  const realFetch = globalThis.fetch
  const apis = []
  const sim = {
    storage,
    configPath,
    startToken,
    sockets: [],
    /** [{ location_id, name }] */
    locations: [],
    /** location id -> ticket assets */
    assets: {},
    /** asset uuid -> device document that asset reports */
    docs: {},
    /** asset uuids that do not answer device-list requests */
    silent: new Set(),
    tokenSeq: 0,
    /** Optional override: () => Response for the OAuth endpoint */
    oauth: null,
    /** When true, the locations request fails with a server error */
    failLocations: false,
    /** Location ids whose ticket request fails with a server error */
    failTickets: new Set(),
    logs: [],
    logged: (pattern) => sim.logs.some((line) => pattern.test(line)),
    configToken: () =>
      JSON.parse(readFileSync(configPath, 'utf8')).platforms[0].refreshToken,

    /** The asset answers a device-list request with its current document */
    answerPoll(socket, uuid) {
      socket.push({
        msg: 'DeviceInfoDocGetList',
        datatype: 'DeviceInfoDocType',
        src: uuid,
        body: [sim.docs[uuid]],
      })
    },
    /** Ring pushes a partial real-time update for one device */
    pushUpdate(socket, zid, components) {
      socket.push(
        {
          msg: 'DataUpdate',
          datatype: 'DeviceInfoDocType',
          src: zid,
          body: [{ general: { v2: { zid } }, device: { v1: { components } } }],
        },
        'DataUpdate',
      )
    },
    /** The currently open socket for a location */
    socketFor(locationId) {
      return [...sim.sockets]
        .reverse()
        .find((s) => s.readyState === 1 && s.url.includes(`authcode=${locationId}&`))
    },

    /** Start a platform instance, optionally with accessories from a previous run */
    async boot({ cached = [], config = {} } = {}) {
      const handlers = {}
      const api = {
        hap,
        handlers,
        registered: [],
        unregistered: [],
        user: { storagePath: () => storage, configPath: () => configPath },
        on: (event, fn) => {
          handlers[event] = fn
        },
        platformAccessory: FakePlatformAccessory,
        registerPlatformAccessories: (_plugin, _platform, accessories) =>
          api.registered.push(...accessories),
        unregisterPlatformAccessories: (_plugin, _platform, accessories) =>
          api.unregistered.push(...accessories),
        updatePlatformAccessories: () => {},
      }
      apis.push(api)
      const log = Object.fromEntries(
        ['info', 'warn', 'error', 'debug'].map((level) => [
          level,
          (message) => sim.logs.push(`[${level}] ${message}`),
        ]),
      )
      const platform = new RingSmokeDetectorsPlatform(
        log,
        { platform: 'RingSmokeDetectors', refreshToken: startToken, ...config },
        api,
      )
      for (const accessory of cached) platform.configureAccessory(accessory)
      handlers.didFinishLaunching()
      await until(() => platform.discoveryRunning === false, { what: 'discovery to finish' })
      const accessory = (name) => {
        const found = [...cached, ...api.registered].find((a) => a.displayName === name)
        if (!found) throw new Error(`No accessory named ${name}`)
        return found
      }
      return { api, platform, accessory }
    },
  }

  globalThis.fetch = async (url) => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.includes('oauth/token')) {
      if (sim.oauth) return sim.oauth()
      return json({ access_token: 'at', refresh_token: `rt${++sim.tokenSeq}`, expires_in: 3600 })
    }
    if (url.includes('clients_api/session')) return json({})
    if (url.includes('devices/v1/locations')) {
      if (sim.failLocations) return json({ error: 'unavailable' }, 500)
      return json({ user_locations: sim.locations })
    }
    if (url.includes('clap/tickets')) {
      const id = new URL(url).searchParams.get('locationID')
      if (sim.failTickets.has(id)) return json({ error: 'unavailable' }, 500)
      return json({ assets: sim.assets[id] ?? [], ticket: id, host: 'ring.test' })
    }
    return json({}, 404)
  }
  const restoreSockets = setSocketFactory((url) => new FakeSocket(url, sim))

  t.after(() => {
    for (const api of apis) api.handlers.shutdown?.()
    globalThis.fetch = realFetch
    restoreSockets()
    rmSync(storage, { recursive: true, force: true })
  })
  return sim
}

/** Convenience readers for an accessory's HomeKit state */
export const smoke = (accessory) =>
  accessory.getService(hap.Service.SmokeSensor).getCharacteristic(hap.Characteristic.SmokeDetected)
export const isResponding = (accessory) => smoke(accessory).statusCode === hap.HAPStatus.SUCCESS
