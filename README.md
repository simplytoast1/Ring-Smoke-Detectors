# homebridge-ring-smoke-detectors

A [Homebridge](https://homebridge.io) plugin for **Kidde/Ring smart smoke and CO detectors**: the WiFi-only, hubless models that are not supported by the existing [homebridge-ring](https://github.com/dgreif/ring) plugin.

## Why This Plugin Exists

Kidde/Ring smart smoke and CO detectors connect via WiFi and are managed through the Ring app. However, these devices don't work with the existing `homebridge-ring` plugin because:

1. **Real-time alarm state** (smoke detected, CO detected) is only available via a WebSocket connection
2. The upstream library only creates WebSocket connections when a Ring Alarm hub or Beams bridge is present, but these Kidde detectors work without any hub
3. These devices may not appear in the Ring REST API at all. They are only reliably discoverable via WebSocket

This plugin establishes its own WebSocket connections that bypass the hub requirement. This approach was [discovered by @tsightler](https://github.com/dgreif/ring/issues/1674#issuecomment-4094895140) and [validated by @jbettcher](https://github.com/dgreif/ring/compare/main...jbettcher:ring:kidde_ring_support) in the original Ring plugin issue.

## Supported Devices

| Device | Model |
|--------|-------|
| Kidde/Ring Smart Smoke Alarm (wired) | Smoke only |
| Kidde/Ring Smart Smoke + CO Alarm (wired) | Smoke + CO |
| Kidde/Ring Smart Smoke + CO Alarm (battery) | Smoke + CO |

## HomeKit Services

Each detector exposes the following HomeKit services:

- **Smoke Sensor**: alerts when smoke is detected (all models), plus tamper and fault status (device malfunction, end-of-life sensor, AC power failure)
- **Carbon Monoxide Sensor**: alerts when CO is detected, with PPM level (CO models only)
- **Battery**: low-battery warnings (also shown on the smoke and CO sensor tiles), plus an approximate level

If the connection to Ring drops, the detectors show as **not responding** in the Home app until it is restored. The same applies to a single detector that stops reporting (for example because it fell off Wi-Fi) while the others keep working: after three minutes of silence that one detector shows as not responding until it reports again. That is deliberate: for a smoke detector, a silent "no smoke" from a detector nobody can hear from is worse than an obvious "no response".

Note on battery level: these detectors report a battery *category* (such as "full" or "low") rather than a percentage, so the level shown is an approximation of that category (full is 100%, ok is 75%, low is 10%). If a detector's firmware does report a numeric level, that number is used instead, and the low-battery warning also triggers at or below `lowBatteryThreshold`. If a detector reports a category the plugin does not recognize, the last known level is kept and the unrecognized value is logged so it can be added. Battery changes are written to the Homebridge log, and with `"debug": true` the plugin logs every battery-related field each detector reports, which is the place to look if you want to see what your hardware actually sends.

## Prerequisites

- [Homebridge](https://homebridge.io) v1.8.0 or later
- Node.js 20.18.1 or later
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
2. Go to **Plugins**, find **Ring Smoke Detectors**, and click **Settings**
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
| `lowBatteryThreshold` | number | `20` | For detectors that report a numeric battery level: show the low-battery warning at or below this percentage |
| `debug` | boolean | `false` | Log the plugin's debug messages at info level |

## How It Works

1. **Authentication**: OAuth token management with automatic token rotation. Ring rotates the refresh token periodically, so the plugin writes each new token back into your `config.json` (the same approach the reference homebridge-ring plugin uses) to keep a valid token available across restarts. The settings page reads the plugin's discovered-device cache rather than logging in again, so opening settings never disturbs the running plugin's token.
2. **Location Discovery**: Fetches all Ring locations, then probes each one via WebSocket. If a location can't be reached, the others still come up and the failed one is retried on its own schedule. Locations are re-checked hourly, so a detector added later is picked up without restarting Homebridge.
3. **WebSocket Connection**: Requests a ticket from Ring's `clap/tickets` endpoint and establishes a direct WebSocket connection, even without a Ring hub.
4. **Device Discovery**: Sends `DeviceInfoDocGetList` requests over the WebSocket to discover devices and their current state.
5. **Real-time Updates**: Subscribes to `DataUpdate` messages for live alarm state changes (smoke, CO, battery, etc.).
6. **Keepalive**: Polls each detector's state once a minute. The poll doubles as a dead-connection detector: if nothing is received for three minutes, the connection is considered half-open and is re-established, so a silently broken connection can't suppress alarm delivery. The same three-minute rule is applied to each detector individually, and state is only ever updated from the detector that actually answered.
7. **Auto-reconnect**: Reconnects with jittered exponential backoff (5s up to 60s) on connection loss, never gives up, and automatically picks up new devices on reconnect. While a connection is down the affected detectors report as not responding, and a dropped connection also re-checks authentication so a revoked login is reported clearly instead of retrying forever.

Pressing the physical test button on a detector is detected and written to the Homebridge log. It is not exposed to HomeKit as a separate button.

## Troubleshooting

### Devices Not Showing Up

- Ensure your Kidde/Ring detectors are set up and online in the Ring app
- Check the Homebridge logs for discovery messages
- Enable `"debug": true` in the config for verbose logging

### Token Issues

The plugin automatically rotates and persists refresh tokens to `config.json`. If authentication fails, open the plugin settings and click **Re-authenticate** to log in again; the new token is saved automatically. Restart Homebridge afterward so the running plugin picks it up.

### WebSocket Connection Issues

The plugin automatically reconnects with exponential backoff (5s, 10s, 20s, up to 60s) and re-checks connection health every 30 seconds. Check your Homebridge logs for connection status messages.

## Development

```bash
npm install
npm test
```

`npm test` builds the plugin and runs the regression suite in `test/`. The tests drive the real compiled plugin against a simulated Ring backend (REST and WebSocket), so they cover the alarm path, discovery across restarts, token persistence, and battery reporting without needing a Ring account.

## Credits

This plugin would not be possible without the work of several people in the Ring community:

- **[@dgreif](https://github.com/dgreif)**: Creator of [ring-client-api](https://github.com/dgreif/ring) and homebridge-ring
- **[@tsightler](https://github.com/tsightler)**: [Discovered](https://github.com/dgreif/ring/issues/1674#issuecomment-4094895140) that Kidde smoke detectors can be accessed via WebSocket even without a hub
- **[@jbettcher](https://github.com/jbettcher)**: [Built the proof-of-concept](https://github.com/dgreif/ring/compare/main...jbettcher:ring:kidde_ring_support) that validated the WebSocket approach for hubless Kidde detectors
- Everyone in [dgreif/ring#1674](https://github.com/dgreif/ring/issues/1674) who contributed testing and discussion

## License

MIT
