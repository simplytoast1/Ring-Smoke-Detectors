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
 *
 * config.json holds every plugin's credentials, so writing it is done with
 * care: the file's permissions and ownership are preserved, a symlinked
 * config keeps its link, and the write is atomic where the filesystem allows.
 */

import type { API } from 'homebridge'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
  statSync,
  chmodSync,
  chownSync,
} from 'node:fs'
import { PLATFORM_NAME } from '../config.js'
import { logDebug, logWarn, logError } from '../util.js'

/**
 * What happened when a rotated token was offered to config.json.
 * - updated:   the file now holds the new token
 * - unchanged: the file already held the new token
 * - foreign:   the file holds a token this process never used (for example a
 *              new login saved from the settings page); it was left alone
 * - failed:    the file could not be read or written
 */
export type PersistOutcome = 'updated' | 'unchanged' | 'foreign' | 'failed'

export interface PersistResult {
  outcome: PersistOutcome
  /** The token found in config.json before the update, when it was readable */
  onDisk?: string
}

/** The refresh token in this platform's block of an already-parsed config */
function tokenFromConfig(config: unknown): string | undefined {
  const platforms = (config as { platforms?: unknown } | null)?.platforms
  if (!Array.isArray(platforms)) return undefined
  const mine = platforms.find(
    (p: unknown): p is { refreshToken?: unknown } =>
      typeof p === 'object' &&
      p !== null &&
      (p as { platform?: unknown }).platform === PLATFORM_NAME,
  )
  return typeof mine?.refreshToken === 'string' ? mine.refreshToken : undefined
}

/**
 * Write config.json without loosening or relocating it.
 *
 * A plain "write temp file, rename over the original" replaces the file with
 * a brand new one, which silently:
 * - resets its permissions to the process default (a config locked to 0600
 *   became world-readable on the first token rotation), and
 * - replaces a symlinked config.json with a regular file, detaching it from
 *   wherever the user actually keeps it.
 *
 * So: resolve symlinks first, create the temp file private, copy the original
 * mode and owner onto it, then rename. If the atomic path is not possible
 * (a bind-mounted single file cannot be renamed over, or the directory is
 * not writable), fall back to writing in place, which is how Homebridge
 * itself writes the file. Throws if both paths fail.
 */
function writeConfigFile(configPath: string, contents: string): void {
  let target = configPath
  try {
    target = realpathSync(configPath)
  } catch {
    // keep the given path; the write below reports any real problem
  }

  let original: { mode: number; uid: number; gid: number } | undefined
  try {
    const stats = statSync(target)
    original = { mode: stats.mode & 0o7777, uid: stats.uid, gid: stats.gid }
  } catch {
    // no original to copy from: the temp file stays private (0600)
  }

  const tmpPath = `${target}.${process.pid}.ring-tmp`
  try {
    // Private from the moment it exists, then matched to the original
    writeFileSync(tmpPath, contents, { mode: 0o600 })
    if (original) {
      chmodSync(tmpPath, original.mode)
      try {
        chownSync(tmpPath, original.uid, original.gid)
      } catch {
        // Not permitted unless running as root; the file is ours either way
      }
    }
    renameSync(tmpPath, target)
    return
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // temp file may not exist
    }
    logDebug(
      `Atomic config.json update not possible (${error}); writing in place instead`,
    )
  }

  // In-place write keeps the existing inode, so mode, owner and any mount
  // or link stay exactly as they were.
  writeFileSync(target, contents)
}

/**
 * Put a rotated refresh token into config.json.
 *
 * The token that gets replaced is whatever this platform's block holds RIGHT
 * NOW, provided it is one this process has used (knownTokens). That makes
 * persistence self-healing: if an earlier write was missed, or something
 * saved an older copy of the config over a newer token, the next rotation
 * still lands. A token this process never used is treated as a deliberate
 * new login and is never overwritten.
 *
 * The update is a targeted text replacement (not JSON re-serialization) so
 * the user's formatting and key order are preserved. Every occurrence of the
 * old token is replaced: once rotated it is dead wherever it appears.
 */
export function persistRotatedToken(
  api: API,
  newRefreshToken: string,
  knownTokens: ReadonlySet<string>,
): PersistResult {
  const configPath = api.user.configPath()

  let contents: string
  try {
    contents = readFileSync(configPath, 'utf8')
  } catch (error) {
    logError(`Failed to read config.json to persist refresh token: ${error}`)
    return { outcome: 'failed' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    parsed = undefined
  }
  const onDisk = tokenFromConfig(parsed)

  if (onDisk === newRefreshToken) return { outcome: 'unchanged', onDisk }
  if (onDisk !== undefined && !knownTokens.has(onDisk)) {
    return { outcome: 'foreign', onDisk }
  }

  // Normally the token in our platform block. If the block could not be read
  // (unparseable file, missing key), fall back to the newest known token
  // that appears anywhere in the text.
  const stale =
    onDisk ?? [...knownTokens].reverse().find((t) => contents.includes(t))

  let updated: string | undefined
  if (stale !== undefined && contents.includes(stale)) {
    // split/join rather than replace(): no "$" pattern surprises, and every
    // occurrence is covered
    updated = contents.split(stale).join(newRefreshToken)
  } else if (onDisk !== undefined && parsed !== undefined) {
    // The token is in the JSON but not as literal text (escaped characters).
    // Fall back to rewriting the parsed config in Homebridge's own format.
    const platforms = (parsed as { platforms: { platform?: unknown }[] })
      .platforms
    for (const platform of platforms) {
      if (platform?.platform === PLATFORM_NAME) {
        ;(platform as { refreshToken?: string }).refreshToken = newRefreshToken
      }
    }
    updated = JSON.stringify(parsed, null, 4)
  }

  if (updated === undefined) {
    logWarn(
      'Could not find the Ring refresh token in config.json to update it. ' +
        'If Homebridge restarts, you may need to Re-authenticate in the plugin settings.',
    )
    return { outcome: 'failed', onDisk }
  }

  try {
    writeConfigFile(configPath, updated)
    logDebug('Persisted rotated refresh token to config.json')
    return { outcome: 'updated', onDisk }
  } catch (error) {
    // Serious, but recoverable: config.json keeps a token Ring has now
    // invalidated, and the next rotation will try again from whatever the
    // file holds. Warn loudly so the user can fix permissions meanwhile.
    logWarn(
      `Could not save the rotated Ring token to config.json (${error}). ` +
        'It will be retried on the next rotation. If Homebridge restarts before a save succeeds, ' +
        'you will need to Re-authenticate in the plugin settings.',
    )
    return { outcome: 'failed', onDisk }
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
    return readRefreshTokenFromFile(api.user.configPath())
  } catch {
    return undefined
  }
}

/**
 * Same, for a caller that only has the path to config.json (the settings UI
 * server, which runs outside Homebridge and has no API object).
 */
export function readRefreshTokenFromFile(
  configPath: string,
): string | undefined {
  try {
    return tokenFromConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return undefined
  }
}
