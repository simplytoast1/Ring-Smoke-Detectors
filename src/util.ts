import type { Logger } from 'homebridge'

let logger: Logger | undefined
let debugEnabled = false

/**
 * Store the Homebridge logger for the module-level log helpers.
 * When the plugin's "debug" config option is on, debug messages are
 * promoted to info level so they show up without running Homebridge
 * itself in debug mode (-D).
 */
export function setLogger(log: Logger, debug = false) {
  logger = log
  debugEnabled = debug
}

export function logInfo(message: string) {
  logger?.info(message)
}

export function logWarn(message: string) {
  logger?.warn(message)
}

export function logError(message: string) {
  logger?.error(message)
}

export function logDebug(message: string) {
  if (debugEnabled) {
    logger?.info(message)
  } else {
    logger?.debug(message)
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
