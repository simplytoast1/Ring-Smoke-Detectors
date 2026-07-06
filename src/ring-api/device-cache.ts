/**
 * Discovered Device Cache
 *
 * The running plugin discovers Kidde devices over the WebSocket and writes the
 * resulting list to this cache file in the Homebridge storage directory. The
 * settings UI reads the cache to render the device list INSTEAD of doing its
 * own WebSocket discovery.
 *
 * Why this exists: authenticating to discover devices rotates the Ring refresh
 * token, and Ring's tokens are effectively single-use. If the settings page
 * authenticated every time it opened, it would rotate the token out from under
 * the running plugin and could knock the plugin offline until a restart. By
 * reading the plugin's cache, opening the settings page performs no auth and no
 * rotation, so the plugin stays the sole token consumer and is never disturbed.
 *
 * This file holds NO credentials, only device metadata for display, so it is a
 * plain (not owner-only) JSON file with a single writer (the plugin).
 */

import { writeFile, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Filename for the discovered-device cache */
export const DEVICE_CACHE_FILE = 'ring-smoke-detectors.devices.json'

/** A device as shown in the settings UI (no alarm state, display only) */
export interface CachedDevice {
  zid: string
  name: string
  deviceType: string
  locationName: string
  batteryLevel?: number
  batteryStatus?: string
}

function cachePath(storagePath: string): string {
  return join(storagePath, DEVICE_CACHE_FILE)
}

/** Monotonic counter so concurrent writes never share a temp filename */
let writeSeq = 0

/** Atomically write the discovered device list for the settings UI to read. */
export async function writeDeviceCache(
  storagePath: string,
  devices: CachedDevice[],
): Promise<void> {
  const finalPath = cachePath(storagePath)
  // Unique per write (pid + counter): several locations poll on independent
  // timers and write fire-and-forget, so a shared temp path would collide.
  const tmpPath = `${finalPath}.${process.pid}.${writeSeq++}.tmp`
  await writeFile(tmpPath, JSON.stringify(devices), 'utf-8')
  try {
    await rename(tmpPath, finalPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/** Read the cached device list. Returns [] if the cache is absent or invalid. */
export async function readDeviceCache(
  storagePath: string,
): Promise<CachedDevice[]> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(storagePath), 'utf-8'))
    return Array.isArray(parsed) ? (parsed as CachedDevice[]) : []
  } catch {
    return []
  }
}
