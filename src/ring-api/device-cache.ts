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
 * The cache also lists every Ring location on the account, including ones the
 * user has excluded. The settings page needs those to offer locations by name:
 * an excluded location is never probed, so it has no devices in the cache and
 * could otherwise never be shown, or switched back on.
 *
 * This file holds NO credentials, only names and ids for display, so it is a
 * plain (not owner-only) JSON file. The plugin is its writer; the settings UI
 * seeds it once after a first login, and only while it is still empty.
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
  /** Absent in entries written before locations were tracked */
  locationId?: string
  batteryLevel?: number
  batteryStatus?: string
}

/** A Ring location on the account, whether or not it has detectors */
export interface CachedLocation {
  id: string
  name: string
}

export interface DeviceCache {
  devices: CachedDevice[]
  locations: CachedLocation[]
}

function cachePath(storagePath: string): string {
  return join(storagePath, DEVICE_CACHE_FILE)
}

/** Monotonic counter so concurrent writes never share a temp filename */
let writeSeq = 0

/** Atomically write the device and location lists for the settings UI. */
export async function writeDeviceCache(
  storagePath: string,
  devices: CachedDevice[],
  locations: CachedLocation[] = [],
): Promise<void> {
  const finalPath = cachePath(storagePath)
  // Unique per write (pid + counter): several locations poll on independent
  // timers and write fire-and-forget, so a shared temp path would collide.
  const tmpPath = `${finalPath}.${process.pid}.${writeSeq++}.tmp`
  const cache: DeviceCache & { version: number } = {
    version: 2,
    locations,
    devices,
  }
  await writeFile(tmpPath, JSON.stringify(cache), 'utf-8')
  try {
    await rename(tmpPath, finalPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Read the cache. Returns empty lists if it is absent or invalid.
 * Also understands the original format, a bare array of devices.
 */
export async function readCache(storagePath: string): Promise<DeviceCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(storagePath), 'utf-8'))
    if (Array.isArray(parsed)) {
      return { devices: parsed as CachedDevice[], locations: [] }
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { devices: [], locations: [] }
    }
    const devices = Array.isArray(parsed.devices)
      ? (parsed.devices as CachedDevice[])
      : []
    const locations = Array.isArray(parsed.locations)
      ? (parsed.locations as unknown[]).filter(
          (l): l is CachedLocation =>
            typeof (l as CachedLocation | null)?.id === 'string' &&
            typeof (l as CachedLocation | null)?.name === 'string',
        )
      : []
    return { devices, locations }
  } catch {
    return { devices: [], locations: [] }
  }
}

/** Read the cached device list. Returns [] if the cache is absent or invalid. */
export async function readDeviceCache(
  storagePath: string,
): Promise<CachedDevice[]> {
  return (await readCache(storagePath)).devices
}
