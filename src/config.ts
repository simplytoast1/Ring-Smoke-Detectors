import type { PlatformConfig } from 'homebridge'

export interface RingSmokeDetectorsConfig extends PlatformConfig {
  refreshToken: string
  locationIds?: string[]
  debug?: boolean
  /** Device zids to exclude from HomeKit */
  hiddenDevices?: string[]
  /** Custom display names, keyed by device zid */
  deviceNames?: Record<string, string>
}

export const PLATFORM_NAME = 'RingSmokeDetectors'
export const PLUGIN_NAME = 'homebridge-ring-smoke-detectors'
