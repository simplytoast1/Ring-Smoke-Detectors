import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCache } from '../dist/ring-api/device-cache.js'

/**
 * The settings page's script is inline in index.html. Its settings logic is
 * written without DOM access, so it can be loaded here with a stand-in page
 * (every element lookup returns an inert stub) and called directly.
 */
function loadPageLogic() {
  const html = readFileSync(new URL('../src/homebridge-ui/public/index.html', import.meta.url), 'utf8')
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
  const inert = () => new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : inert()), apply: () => inert(), set: () => true })
  const context = vm.createContext({
    document: inert(),
    homebridge: { getPluginConfig: async () => [], toast: inert(), showSpinner() {}, hideSpinner() {}, request: async () => ({}) },
  })
  vm.runInContext(script, context)
  return context
}

const page = loadPageLogic()
// values created inside the page's context are compared as plain data
const plain = (value) => JSON.parse(JSON.stringify(value))

test('saving keeps hidden flags and names of detectors the page is not showing', () => {
  const savedHidden = ['CABIN-1', 'HOME-2']
  const savedNames = { 'CABIN-1': 'Loft', 'HOME-1': 'Old name' }
  // Only the two home detectors are on screen (the cabin was unreachable)
  const shown = [
    { zid: 'HOME-1', visible: true, customName: 'Hallway', originalName: 'Smoke Alarm' },
    { zid: 'HOME-2', visible: true, customName: '', originalName: 'Kitchen' },
  ]

  const result = plain(page.mergeDeviceSettings(savedHidden, savedNames, shown))

  assert.deepEqual(result.hiddenDevices, ['CABIN-1'], 'cabin stays hidden; kitchen was unhidden on screen')
  assert.deepEqual(result.deviceNames, { 'CABIN-1': 'Loft', 'HOME-1': 'Hallway' })
})

test('saving with nothing on screen changes nothing', () => {
  const result = plain(page.mergeDeviceSettings(['A', 'B'], { A: 'Den' }, []))
  assert.deepEqual(result, { hiddenDevices: ['A', 'B'], deviceNames: { A: 'Den' } })
})

test('hiding, unhiding and renaming the detectors on screen works as before', () => {
  const result = plain(
    page.mergeDeviceSettings(undefined, undefined, [
      { zid: 'A', visible: false, customName: '  Den  ', originalName: 'Smoke Alarm' },
      { zid: 'B', visible: true, customName: 'Kitchen', originalName: 'Kitchen' },
    ]),
  )
  assert.deepEqual(result, { hiddenDevices: ['A'], deviceNames: { A: 'Den' } })

  const cleared = page.mergeDeviceSettings(['A'], { A: 'Den' }, [
    { zid: 'A', visible: true, customName: '', originalName: 'Smoke Alarm' },
  ])
  assert.equal(cleared.hiddenDevices, undefined, 'an empty list is removed from the config')
  assert.equal(cleared.deviceNames, undefined)
})

test('locations chosen by name become the locationIds option', () => {
  const locations = [{ id: 'L1', name: 'Home' }, { id: 'L2', name: 'Cabin' }]

  const all = page.selectLocationIds(locations, ['L1', 'L2'])
  assert.equal(all.ok, true)
  assert.equal(all.locationIds, undefined, 'everything ticked means no filter, so future locations are included')

  assert.deepEqual(plain(page.selectLocationIds(locations, ['L2'])), { ok: true, locationIds: ['L2'] })
  assert.equal(page.selectLocationIds(locations, []).ok, false, 'an empty list would silently mean "all"')

  assert.equal(page.isLocationIncluded(undefined, 'L1'), true)
  assert.equal(page.isLocationIncluded([], 'L1'), true)
  assert.equal(page.isLocationIncluded(['L2'], 'L1'), false)
})

test('a device list written by an older version is still readable', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'ring-smoke-cache-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const legacy = [{ zid: 'A1', name: 'Hallway', deviceType: 'comp.bluejay.sensor_bluejay_wsc', locationName: 'Home' }]
  writeFileSync(join(storage, 'ring-smoke-detectors.devices.json'), JSON.stringify(legacy))

  assert.deepEqual(await readCache(storage), { devices: legacy, locations: [] })
})
