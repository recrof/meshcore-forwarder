import { Packet } from '@liamcottle/meshcore.js';
import { getChannel } from './channel.mjs';

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
  RAW_CUSTOM: Packet.PAYLOAD_TYPE_RAW_CUSTOM,
};

export const RouteType = {
  TRANSPORT_FLOOD: Packet.ROUTE_TYPE_TRANSPORT_FLOOD,
  FLOOD: Packet.ROUTE_TYPE_FLOOD,
  DIRECT: Packet.ROUTE_TYPE_DIRECT,
  TRANSPORT_DIRECT: Packet.ROUTE_TYPE_TRANSPORT_DIRECT,
};

export const Constants = { ...PayloadType, RouteType, PayloadType };

export function wrap(rawBytes) {
  const pkt = Packet.fromBytes(rawBytes);
  const decryptCache = new Map();

  pkt.raw = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  pkt.type = pkt.payload_type;
  pkt.typeName = pkt.payload_type_string;
  pkt.routeType = pkt.route_type;
  pkt.isFlood = pkt.isRouteFlood();

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

  return pkt;
}
