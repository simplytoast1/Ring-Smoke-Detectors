import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSim, deviceDoc, kiddeAsset, encodeToken } from './helpers/sim.mjs'
import { persistRotatedToken, readConfigRefreshToken, readRefreshTokenFromFile } from '../dist/ring-api/config-store.js'
import { RingRestClient, RingApiError, RingAuthError } from '../dist/ring-api/ring-rest-client.js'

const posixOnly = { skip: process.platform === 'win32' && 'POSIX file modes and symlinks' }

/** A throwaway Homebridge storage dir holding a config.json with the given token */
function tempConfig(t, token) {
  const dir = mkdtempSync(join(tmpdir(), 'ring-smoke-config-'))
  t.after(() => {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'config.json')
  const write = (target = path) =>
    writeFileSync(
      target,
      JSON.stringify({ platforms: [{ platform: 'SomethingElse', token: 'x' }, { platform: 'RingSmokeDetectors', refreshToken: token }] }, null, 4),
    )
  write()
  return { dir, path, write, api: { user: { configPath: () => path } } }
}

test('the running plugin saves each rotated token into config.json', async (t) => {
  const sim = createSim(t)
  sim.locations = [{ location_id: 'L1', name: 'Home' }]
  sim.assets.L1 = [kiddeAsset('A1')]
  sim.docs.A1 = deviceDoc('A1', 'Hallway')
  await sim.boot()
  assert.equal(sim.configToken(), encodeToken('rt1'), 'the token Ring rotated to is on disk')
})

test('a rotation is saved even when an earlier one never reached the file', (t) => {
  const { api } = tempConfig(t, 'TOKEN_A')
  // A -> B was rotated in memory but never written (failed write, or an older
  // copy of the config was saved over it). The file still holds A.
  const known = new Set(['TOKEN_A', 'TOKEN_B'])

  assert.equal(persistRotatedToken(api, 'TOKEN_C', known).outcome, 'updated')
  assert.equal(readConfigRefreshToken(api), 'TOKEN_C')

  known.add('TOKEN_C')
  assert.equal(persistRotatedToken(api, 'TOKEN_D', known).outcome, 'updated')
  assert.equal(readConfigRefreshToken(api), 'TOKEN_D')
  assert.equal(persistRotatedToken(api, 'TOKEN_D', known).outcome, 'unchanged')
})

test('a token from a new login is never overwritten', (t) => {
  const { api, path } = tempConfig(t, 'TOKEN_FROM_NEW_LOGIN')
  const before = readFileSync(path, 'utf8')

  const result = persistRotatedToken(api, 'TOKEN_C', new Set(['TOKEN_A', 'TOKEN_B']))

  assert.equal(result.outcome, 'foreign')
  assert.equal(readFileSync(path, 'utf8'), before, 'file untouched')
})

test('the settings page can read the token config.json holds right now', (t) => {
  const { api, path } = tempConfig(t, 'TOKEN_A')
  assert.equal(readRefreshTokenFromFile(path), 'TOKEN_A')
  // the plugin rotates while the settings page is open
  persistRotatedToken(api, 'TOKEN_B', new Set(['TOKEN_A']))
  assert.equal(readRefreshTokenFromFile(path), 'TOKEN_B')
  assert.equal(readRefreshTokenFromFile(join(path, 'missing')), undefined)
})

test('only the token changes: other plugins and formatting are preserved', (t) => {
  const { api, path } = tempConfig(t, 'TOKEN_A')
  const before = readFileSync(path, 'utf8')
  persistRotatedToken(api, 'TOKEN_$&_B', new Set(['TOKEN_A']))
  assert.equal(readFileSync(path, 'utf8'), before.replace('TOKEN_A', () => 'TOKEN_$&_B'))
})

test('saving a token keeps config.json private', posixOnly, (t) => {
  const { api, path } = tempConfig(t, 'TOKEN_A')
  chmodSync(path, 0o600)
  persistRotatedToken(api, 'TOKEN_B', new Set(['TOKEN_A']))
  assert.equal((statSync(path).mode & 0o777).toString(8), '600')
})

test('saving a token keeps a symlinked config.json a symlink', posixOnly, (t) => {
  const { api, dir, path, write } = tempConfig(t, 'TOKEN_A')
  const real = join(dir, 'real-config.json')
  rmSync(path)
  write(real)
  symlinkSync(real, path)

  persistRotatedToken(api, 'TOKEN_B', new Set(['TOKEN_A']))

  assert.ok(lstatSync(path).isSymbolicLink())
  assert.match(readFileSync(real, 'utf8'), /TOKEN_B/)
})

test('a config that cannot be replaced atomically is written in place', posixOnly, (t) => {
  const { api, dir } = tempConfig(t, 'TOKEN_A')
  chmodSync(dir, 0o500) // no new files here, like a single bind-mounted file
  assert.equal(persistRotatedToken(api, 'TOKEN_B', new Set(['TOKEN_A'])).outcome, 'updated')
  assert.equal(readConfigRefreshToken(api), 'TOKEN_B')
})

for (const [label, body] of [
  ['an HTML page', '<html>maintenance</html>'],
  ['an empty object', '{}'],
  ['a response without a refresh token', '{"access_token":"at"}'],
]) {
  test(`a 200 token response that is ${label} is rejected and nothing is saved`, async (t) => {
    const realFetch = globalThis.fetch
    t.after(() => (globalThis.fetch = realFetch))
    globalThis.fetch = async () => new Response(body, { status: 200 })

    const start = encodeToken('GOOD')
    const client = new RingRestClient({ refreshToken: start })
    const emitted = []
    client.onRefreshTokenUpdated.subscribe((event) => emitted.push(event))

    await assert.rejects(client.getCurrentAuth(), (error) => {
      // transient, so the caller retries; NOT an auth failure that wipes the session
      return error instanceof RingApiError && !(error instanceof RingAuthError)
    })
    assert.deepEqual(emitted, [], 'no token is handed to the config writer')
    assert.equal(client.refreshToken, start, 'the good token is kept')
  })
}
