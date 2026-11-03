import { Packet } from '@liamcottle/meshcore.js';
import { getChannel, getChannelByKey } from './channel.mjs';
import { getRegion } from './region.mjs';

export const PayloadType = {
  REQ: Packet.PAYLOAD_TYPE_REQ,
  RESPONSE: Packet.PAYLOAD_TYPE_RESPONSE,
  TXT_MSG: Packet.PAYLOAD_TYPE_TXT_MSG,
  ACK: Packet.PAYLOAD_TYPE_ACK,
  ADVERT: Packet.PAYLOAD_TYPE_ADVERT,
  GRP_TXT: Packet.PAYLOAD_TYPE_GRP_TXT,
  GRP_DATA: Packet.PAYLOAD_TYPE_GRP_DATA,
  ANON_REQ: Packet.PAYLOAD_TYPE_ANON_REQ,
  PATH: Packet.PAYLOAD_TYPE_PATH,
  TRACE: Packet.PAYLOAD_TYPE_TRACE,
  MULTIPART: 0x0A,
  CONTROL: 0x0B,
  RAW_CUSTOM: Packet.PAYLOAD_TYPE_RAW_CUSTOM,
};

export const RouteType = {
  TRANSPORT_FLOOD: Packet.ROUTE_TYPE_TRANSPORT_FLOOD,
  FLOOD: Packet.ROUTE_TYPE_FLOOD,
  DIRECT: Packet.ROUTE_TYPE_DIRECT,
  TRANSPORT_DIRECT: Packet.ROUTE_TYPE_TRANSPORT_DIRECT,
};

// Types newer than meshcore.js knows about (see firmware Packet.h)
const EXTRA_TYPE_NAMES = { 0x0A: 'MULTIPART', 0x0B: 'CONTROL' };

export const Constants = { ...PayloadType, RouteType, PayloadType };

export function wrap(rawBytes) {
  const pkt = Packet.fromBytes(rawBytes);
  const decryptCache = new Map();

  pkt.raw = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  pkt.type = pkt.payload_type;
  pkt.typeName = pkt.payload_type_string ?? EXTRA_TYPE_NAMES[pkt.type] ?? `TYPE_0x${pkt.type.toString(16).padStart(2, '0')}`;
  pkt.routeType = pkt.route_type;
  pkt.hasTransportCodes = pkt.routeType === Packet.ROUTE_TYPE_TRANSPORT_FLOOD
    || pkt.routeType === Packet.ROUTE_TYPE_TRANSPORT_DIRECT;
  pkt.isFlood = pkt.routeType === Packet.ROUTE_TYPE_FLOOD
    || pkt.routeType === Packet.ROUTE_TYPE_TRANSPORT_FLOOD;
  // transport codes sit right after the header byte: [code1:2 LE][code2:2 LE]
  pkt.transportCodes = pkt.hasTransportCodes
    ? [pkt.raw.readUInt16LE(1), pkt.raw.readUInt16LE(3)]
    : null;

  pkt.isFromChannel = function (hashtag) {
    if (pkt.type !== Packet.PAYLOAD_TYPE_GRP_TXT && pkt.type !== Packet.PAYLOAD_TYPE_GRP_DATA) {
      return false;
    }
    const ch = getChannel(hashtag);
    if (decryptCache.has(ch.name)) return decryptCache.get(ch.name) !== null;
    const plain = ch.decrypt(pkt.payload);
    decryptCache.set(ch.name, plain);
    return plain !== null;
  };

  pkt.getChannelPlaintext = function (hashtag) {
    const ch = getChannel(hashtag);
    if (decryptCache.has(ch.name)) return decryptCache.get(ch.name);
    const plain = ch.decrypt(pkt.payload);
    decryptCache.set(ch.name, plain);
    return plain;
  };

  pkt.isInRegion = function (hashtag) {
    if (!pkt.hasTransportCodes) return false;
    const code = getRegion(hashtag).calcTransportCode(pkt.type, pkt.payload);
    return pkt.transportCodes[0] === code;
  };

  return pkt;
}

const ROUTE_NAMES = {
  [Packet.ROUTE_TYPE_TRANSPORT_FLOOD]: 'TRANSPORT_FLOOD',
  [Packet.ROUTE_TYPE_FLOOD]: 'FLOOD',
  [Packet.ROUTE_TYPE_DIRECT]: 'DIRECT',
  [Packet.ROUTE_TYPE_TRANSPORT_DIRECT]: 'TRANSPORT_DIRECT',
};

const hex = (bytes) => Buffer.from(bytes ?? []).toString('hex');

// Path hops are 1-3 bytes each; hash size is encoded in the top 2 bits of path_len.
function formatPath(pkt) {
  const path = Buffer.from(pkt.path ?? []);
  const size = Packet.extractPathHashSize(pkt.pathLen ?? 0);
  const hops = [];
  for (let i = 0; i + size <= path.length; i += size) hops.push(hex(path.subarray(i, i + size)));
  return hops.join(',');
}

// Turn config.debugChannels entries into channel objects.
// '#name' → hashtag channel; { name, key: '<32 hex>' } or '<32 hex>' → explicit key.
export function resolveChannels(list = []) {
  return list.map((entry) => {
    if (typeof entry === 'object') return getChannelByKey(entry.key, entry.name);
    if (/^[0-9a-f]{32}$/i.test(entry)) return getChannelByKey(entry);
    return getChannel(entry);
  });
}

// GRP_TXT plaintext: [timestamp:4 LE][flags:1 (txt_type<<2 | attempt)]["sender: message"][zero padding]
function parseGrpTxt(plain) {
  if (!plain || plain.length < 5) return null;
  const ts = plain.readUInt32LE(0);
  const flags = plain[4];
  let text = plain.subarray(5);
  const nul = text.indexOf(0);
  if (nul !== -1) text = text.subarray(0, nul);
  return { timestamp: ts, txtType: flags >> 2, attempt: flags & 0x03, text: text.toString('utf8') };
}

// One-line human-readable dump of a GRP_TXT packet, or null for other types.
// Tries each given channel; if none decrypts, shows the channel hash byte only.
export function formatGrpTxt(pkt, channels) {
  if (pkt.type !== Packet.PAYLOAD_TYPE_GRP_TXT) return null;
  const parts = [
    `route=${ROUTE_NAMES[pkt.routeType] ?? pkt.routeType}`,
    `path=[${formatPath(pkt)}]`,
  ];
  if (pkt.transportCodes) {
    parts.push(`transport=${pkt.transportCodes.map((c) => c.toString(16).padStart(4, '0')).join(',')}`);
  }

  for (const ch of channels) {
    const msg = parseGrpTxt(ch.decrypt(pkt.payload));
    if (!msg) continue;
    const sent = new Date(msg.timestamp * 1000).toISOString();
    const extra = msg.attempt ? ` attempt=${msg.attempt}` : '';
    return `GRP_TXT ${ch.name} ${parts.join(' ')} sent=${sent}${extra} ${JSON.stringify(msg.text)}`;
  }
  return `GRP_TXT ch=${hex(pkt.payload.slice(0, 1))} (unknown channel) ${parts.join(' ')} raw=${hex(pkt.raw)}`;
}
