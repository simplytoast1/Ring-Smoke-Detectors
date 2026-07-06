/**
 * Homebridge config.json Token Persistence
 *
 * Ring rotates the OAuth refresh token on every exchange, and the tokens are
 * effectively single-use: once a token is exchanged, the previous one stops
 * working. So the latest token MUST be persisted, and there must be exactly
 * one place that holds "the current token".
 *
 * We use config.json itself as that single source of truth, matching the
 * approach the reference homebridge-ring plugin has used in production for
 * years: on each rotation we write the new token back into config.json, so
 * the file the user (and Homebridge) already trust always holds a live token.
 * This keeps a fresh token available after restarts without a second file
 * that could drift out of sync with config.json.
 *
 * The plugin is the sole token consumer at runtime (the settings UI reads a
 * device cache instead of authenticating), so there is no cross-process
 * rotation race here in normal operation.
 */

import type { API } from 'homebridge'
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { PLATFORM_NAME } from '../config.js'
import { logDebug, logWarn, logError } from '../util.js'

/**
 * Replace the old refresh token with the new one inside config.json.
 *
 * Uses a targeted string replacement (not JSON re-serialization) so the
 * user's formatting, key order, and any surrounding config are preserved and
 * only the token characters change. Refresh tokens are long unique strings,
 * so a single occurrence is expected. Returns true if the file was updated.
 */
export function updateConfigRefreshToken(
  api: API,
  oldRefreshToken: string | undefined,
  newRefreshToken: string,
): boolean {
  // Nothing to find/replace on the very first auth (no prior token)
  if (!oldRefreshToken || oldRefreshToken === newRefreshToken) return false

  const configPath = api.user.configPath()

  let contents: string
  let updated: string
  try {
    contents = readFileSync(configPath).toString()
    updated = contents.replace(oldRefreshToken, newRefreshToken)
  } catch (error) {
    logError(`Failed to read config.json to persist refresh token: ${error}`)
    return false
  }

  if (contents === updated) {
    // The old token wasn't in config.json (e.g. the user re-logged-in and
    // config already holds a newer token). Leave the file alone.
    return false
  }

  // Write atomically (temp file + rename) so a crash mid-write can never leave
  // config.json truncated, which would stop all of Homebridge from starting.
  const tmpPath = `${configPath}.${process.pid}.ring-tmp`
  try {
    writeFileSync(tmpPath, updated)
    renameSync(tmpPath, configPath)
    logDebug('Persisted rotated refresh token to config.json')
    return true
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // temp file may not exist
    }
    // A write failure here is serious: config.json keeps the old token, which
    // Ring has now invalidated, so the plugin will need re-authentication
    // after the next restart. Warn loudly so the user can fix permissions.
    logWarn(
      `Could not save the rotated Ring token to config.json (${error}). ` +
        'If Homebridge restarts before this is fixed, you will need to Re-authenticate in the plugin settings.',
    )
    return false
  }
}

/**
 * Read the current refresh token for this platform straight from config.json
 * on disk. Used to start each discovery attempt from the freshest token, so
 * the running plugin picks up a token that a re-login or explicit device
 * refresh wrote to config (self-heal) without needing a restart.
 *
 * Returns undefined if the file can't be read or the platform block has no
 * refresh token; callers fall back to the token Homebridge parsed at startup.
 */
export function readConfigRefreshToken(api: API): string | undefined {
  try {
    const configPath = api.user.configPath()
    const config = JSON.parse(readFileSync(configPath).toString())
    const platforms = Array.isArray(config?.platforms) ? config.platforms : []
    const mine = platforms.find(
      (p: unknown): p is { refreshToken?: unknown } =>
        typeof p === 'object' &&
        p !== null &&
        (p as { platform?: unknown }).platform === PLATFORM_NAME,
    )
    return typeof mine?.refreshToken === 'string' ? mine.refreshToken : undefined
  } catch {
    return undefined
  }
}
