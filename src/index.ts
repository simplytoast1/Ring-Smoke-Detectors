import type { API } from 'homebridge'
import { RingSmokeDetectorsPlatform } from './platform.js'
import { setHap } from './hap.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './config.js'

export default function (api: API) {
  setHap(api.hap)
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RingSmokeDetectorsPlatform)
}
