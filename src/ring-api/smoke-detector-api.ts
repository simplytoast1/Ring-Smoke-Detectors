/**
 * Ring Location Discovery
 *
 * This module fetches the user's Ring locations so we can attempt WebSocket
 * connections to each one.
 *
 * CRITICAL INSIGHT from @tsightler (https://github.com/dgreif/ring/issues/1674):
 * "It seems these Kiddie smoke/co detectors only show up in the device list
 * via the websocket, however, since there is no hub, no websocket is actually
 * created, thus no discovery of these devices."
 *
 * This means we CANNOT rely on the REST API to tell us which locations have
 * Kidde smoke detectors. The REST API's "other" collection may show some
 * device metadata for hubless devices, but:
 * - It contains NO alarm state (no components like alarm.smoke, alarm.co)
 * - It may not list the devices at all in some configurations
 * - The actual device data with real-time state ONLY comes from the WebSocket
 *
 * Therefore, our discovery approach is:
 * 1. Fetch ALL locations from the REST API
 * 2. For EVERY location, attempt a WebSocket connection (via clap/tickets)
 * 3. The clap/tickets endpoint returns "assets" — if any are sensor_bluejay_*,
 *    that location has Kidde devices and we proceed with WebSocket discovery
 * 4. If no sensor_bluejay_* assets, we skip that location (no Kidde devices)
 *
 * This approach is more robust than filtering by REST "other" devices because
 * it lets the WebSocket ticket endpoint be the source of truth for which
 * locations have Kidde devices.
 */

import { RestClientWrapper } from './rest-client-wrapper.js'
import { deviceApi } from './ring-rest-client.js'
import type { RingLocation } from './types.js'
import { logInfo, logDebug } from '../util.js'

/**
 * Fetch all Ring locations for the authenticated user.
 *
 * Uses the same endpoint as ring-client-api internally:
 *   GET https://api.ring.com/devices/v1/locations
 *
 * The response wraps the location array in { user_locations: [...] }.
 *
 * We fetch ALL locations because we can't know from the REST API alone
 * which ones have Kidde smoke detectors. The WebSocket ticket endpoint
 * (clap/tickets) is the only reliable way to discover Kidde assets.
 *
 * The platform class will then attempt a WebSocket connection to each
 * location and let the asset list determine if there are Kidde devices.
 */
export async function fetchAllLocations(
  client: RestClientWrapper,
): Promise<RingLocation[]> {
  const { user_locations: locations } = await client.request<{
    user_locations: RingLocation[]
  }>(deviceApi('locations'))

  logInfo(`Found ${locations.length} Ring location(s)`)

  for (const loc of locations) {
    logDebug(`Location: "${loc.name}" (${loc.location_id})`)
  }

  return locations
}
