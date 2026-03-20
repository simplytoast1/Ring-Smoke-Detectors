# homebridge-ring-smoke-detectors

A [Homebridge](https://homebridge.io) plugin for **Kidde/Ring smart smoke and CO detectors** — the WiFi-only, hubless models that are not supported by the existing [homebridge-ring](https://github.com/dgreif/ring) plugin.

## Why This Plugin Exists

Kidde/Ring smart smoke and CO detectors connect via WiFi and are managed through the Ring app. However, these devices don't work with the existing `homebridge-ring` plugin because:

1. **Real-time alarm state** (smoke detected, CO detected) is only available via a WebSocket connection
2. The upstream library only creates WebSocket connections when a Ring Alarm hub or Beams bridge is present — but these Kidde detectors work without any hub
3. These devices may not appear in the Ring REST API at all — they are only reliably discoverable via WebSocket

This plugin establishes its own WebSocket connections that bypass the hub requirement. This approach was [discovered by @tsightler](https://github.com/dgreif/ring/issues/1674#issuecomment-4094895140) and [validated by @jbettcher](https://github.com/dgreif/ring/compare/main...jbettcher:ring:kidde_ring_support) in the original Ring plugin issue.

## Supported Devices

| Device | Model |
|--------|-------|
| Kidde/Ring Smart Smoke Alarm (wired) | Smoke only |
| Kidde/Ring Smart Smoke + CO Alarm (wired) | Smoke + CO |
| Kidde/Ring Smart Smoke + CO Alarm (battery) | Smoke + CO |

## HomeKit Services

Each detector exposes the following HomeKit services:

- **Smoke Sensor** — alerts when smoke is detected (all models)
- **Carbon Monoxide Sensor** — alerts when CO is detected, with PPM level (CO models only)
- **Battery** — battery level and low-battery warnings

## Prerequisites

- [Homebridge](https://homebridge.io) v1.8.0 or later
- Node.js 20, 22, 24, or 25
- A Ring account with Kidde/Ring smoke detectors set up in the Ring app

## Installation

### Via Homebridge UI

Search for `homebridge-ring-smoke-detectors` in the Homebridge plugin search and install it.

### Via Command Line

```bash
npm install -g homebridge-ring-smoke-detectors
```

## Setup

1. Open the Homebridge web UI
2. Go to **Plugins** → find **Ring Smoke Detectors** → click **Settings**
3. Click **Log In**
4. Enter your **Ring email** and **password**
5. If prompted, enter your **2FA verification code**
6. Your devices will be discovered automatically and shown in the settings page
7. Optionally rename devices or uncheck any you want to hide from HomeKit

Your Ring credentials are sent directly to Ring's servers and are **not stored**. Only the resulting refresh token is saved, and the plugin automatically handles token rotation.

### Manual Configuration

If you prefer, add this to your Homebridge `config.json` under `platforms`:

```json
{
  "platform": "RingSmokeDetectors",
  "refreshToken": "YOUR_REFRESH_TOKEN_HERE"
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `refreshToken` | string | *required* | Ring refresh token (generated via the settings UI) |
| `locationIds` | string[] | all locations | Limit to specific Ring location IDs |
| `hiddenDevices` | string[] | none | Device IDs to exclude from HomeKit (managed via settings UI) |
| `deviceNames` | object | none | Custom display names by device ID (managed via settings UI) |
| `debug` | boolean | `false` | Enable verbose debug logging |

## How It Works

1. **Authentication** — OAuth token management with automatic token rotation and persistence
2. **Location Discovery** — Fetches all Ring locations, then probes each one via WebSocket
3. **WebSocket Connection** — Requests a ticket from Ring's `clap/tickets` endpoint and establishes a direct WebSocket connection — even without a Ring hub
4. **Device Discovery** — Sends `DeviceInfoDocGetList` requests over the WebSocket to discover devices and their current state
5. **Real-time Updates** — Subscribes to `DataUpdate` messages for live alarm state changes (smoke, CO, battery, etc.)
6. **Auto-reconnect** — Reconnects with exponential backoff (5s → 60s) on connection loss, and automatically picks up new devices on reconnect

## Troubleshooting

### Devices Not Showing Up

- Ensure your Kidde/Ring detectors are set up and online in the Ring app
- Check the Homebridge logs for discovery messages
- Enable `"debug": true` in the config for verbose logging

### Token Issues

The plugin automatically rotates and persists refresh tokens. If authentication fails, open the plugin settings and click **Re-authenticate** to generate a new token.

### WebSocket Connection Issues

The plugin automatically reconnects with exponential backoff (5s, 10s, 20s, up to 60s). Check your Homebridge logs for connection status messages.

## Credits

This plugin would not be possible without the work of several people in the Ring community:

- **[@dgreif](https://github.com/dgreif)** — Creator of [ring-client-api](https://github.com/dgreif/ring) and homebridge-ring
- **[@tsightler](https://github.com/tsightler)** — [Discovered](https://github.com/dgreif/ring/issues/1674#issuecomment-4094895140) that Kidde smoke detectors can be accessed via WebSocket even without a hub
- **[@jbettcher](https://github.com/jbettcher)** — [Built the proof-of-concept](https://github.com/dgreif/ring/compare/main...jbettcher:ring:kidde_ring_support) that validated the WebSocket approach for hubless Kidde detectors
- Everyone in [dgreif/ring#1674](https://github.com/dgreif/ring/issues/1674) who contributed testing and discussion

## License

MIT
