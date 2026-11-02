import { createHash, createHmac } from 'node:crypto';

const TRANSPORT_KEY_SIZE = 16;

const regionCache = new Map();

export function getRegion(hashtag) {
  const name = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  let rg = regionCache.get(name);
  if (rg) return rg;

  // Matches firmware TransportKeyStore::getAutoKeyFor: key = sha256("#name")[0:16]
  const key = createHash('sha256').update(name, 'utf8').digest().subarray(0, TRANSPORT_KEY_SIZE);

  rg = {
    name,
    key,
    calcTransportCode(payloadType, payload) { return calcTransportCode(this.key, payloadType, payload); },
  };
  regionCache.set(name, rg);
  return rg;
}

// Matches firmware TransportKey::calcTransportCode:
// HMAC-SHA256(key, [payload_type] || payload), first 2 bytes as LE uint16; 0000 and FFFF are reserved
function calcTransportCode(key, payloadType, payload) {
  const mac = createHmac('sha256', key).update(Buffer.from([payloadType])).update(payload).digest();
  let code = mac.readUInt16LE(0);
  if (code === 0) code++;
  else if (code === 0xFFFF) code--;
  return code;
}
