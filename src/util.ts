import type { Logger } from 'homebridge'

let logger: Logger | undefined

export function setLogger(log: Logger) {
  logger = log
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
  logger?.debug(message)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
