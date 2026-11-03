# meshcore-forwarder

## Requirements
- Computer or raspberry pi with node.js v22 + npm
- 2 (or more) MeshCore nodes flashed with KISS radio firmware connected via USB

## Usage

```sh
git clone https://github.com/recrof/meshcore-forwarder
cd meshcore-forwarder
npm install .
```
Edit `config.mjs`

Then run with `node index.mjs`

## Logging

Optional keys in `config.mjs`:

- `logTimestamps: true` – prefix each log line with an ISO timestamp (off by default, since journald adds its own)
- `debug: true` – log every unique received `GRP_TXT` (channel message), decrypted with the channels listed in `debugChannels`. Messages on unlisted channels are logged with just the channel hash byte and raw hex
- `debugChannels` – channels to try: `'#hashtag'` names, or `{ name: 'Public', key: '<32 hex chars>' }` for channels with an explicit secret

## Filtering

`config.filter(packet, constants)` decides which packets get forwarded. Useful packet helpers:

- `packet.isFlood` – `FLOOD` or `TRANSPORT_FLOOD` (region-scoped flood)
- `packet.isInRegion('#cs')` – packet is scoped to the given hashtag region
- `packet.isFromChannel('#cs')` – `GRP_TXT` / `GRP_DATA` decrypts with the given hashtag channel
- `packet.type`, `packet.routeType`, `packet.transportCodes`

Example – forward all non-flood packets, but only floods scoped to `#cs`:

```js
filter(packet, constants) {
  if (!packet.isFlood) return true;
  return packet.isInRegion('#cs');
},
```
