/**
 * WebSocket construction, behind one small seam.
 *
 * Production always uses undici's WebSocket. The seam exists so the test
 * suite can drive the real connection and platform code against a simulated
 * Ring backend: Ring's endpoint is wss-only and cannot be stood up locally,
 * and the alarm path is exactly the code that most needs regression tests.
 */

import { WebSocket } from 'undici'

/** The part of the WebSocket interface this plugin uses */
export type RingSocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>

/** readyState of an open socket */
export const SOCKET_OPEN = WebSocket.OPEN

type SocketFactory = (url: string) => RingSocket

const defaultFactory: SocketFactory = (url) => new WebSocket(url)
let factory: SocketFactory = defaultFactory

/** Open a WebSocket to the given URL */
export function openSocket(url: string): RingSocket {
  return factory(url)
}

/**
 * Replace the socket implementation. For tests only.
 * Returns a function that restores the real implementation.
 */
export function setSocketFactory(next: SocketFactory): () => void {
  factory = next
  return () => {
    factory = defaultFactory
  }
}
