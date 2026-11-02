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
