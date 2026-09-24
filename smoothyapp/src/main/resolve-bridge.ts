/**
 * DaVinci Resolve Bridge - Connection status tracking
 * 
 * The Resolve bridge is a Lua script installed in DaVinci Resolve's Scripts folder.
 * It communicates via HTTP polling or file-based mechanisms.
 * For now, we track connection status as a simple boolean.
 */

let resolveConnected = false;

export function getResolveConnectionStatus(): boolean {
  return resolveConnected;
}

export function setResolveConnectionStatus(connected: boolean): void {
  resolveConnected = connected;
}
