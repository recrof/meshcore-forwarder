import { createHash, createHmac, createDecipheriv } from 'node:crypto';

const CIPHER_KEY_SIZE = 16;
const PUB_KEY_SIZE = 32;
const CIPHER_MAC_SIZE = 2;

const channelCache = new Map();

export function getChannel(hashtag) {
  const name = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  let ch = channelCache.get(name);
  if (ch) return ch;

  const key16 = createHash('sha256').update(name, 'utf8').digest().subarray(0, CIPHER_KEY_SIZE);
  ch = makeChannel(name, key16);
  channelCache.set(name, ch);
  return ch;
}

// Channel with an explicit 16-byte secret given as 32 hex chars (e.g. the Public channel).
export function getChannelByKey(hexKey, name) {
  const key16 = Buffer.from(hexKey, 'hex');
  if (key16.length !== CIPHER_KEY_SIZE) {
    throw new Error(`channel key must be ${CIPHER_KEY_SIZE * 2} hex chars`);
  }
  const cacheKey = `key:${key16.toString('hex')}`;
  let ch = channelCache.get(cacheKey);
  if (ch) return ch;
  ch = makeChannel(name ?? key16.toString('hex').slice(0, 8), key16);
  channelCache.set(cacheKey, ch);
  return ch;
}

function makeChannel(name, key16) {
  // HMAC key matches firmware: 32 bytes, low 16 = AES key, high 16 = zeros
  const hmacKey = Buffer.alloc(PUB_KEY_SIZE);
  key16.copy(hmacKey, 0);
  // Channel hash byte that prefixes the on-air payload
  const hashByte = createHash('sha256').update(key16).digest()[0];

  return {
    name,
    key16,
    hmacKey,
    hashByte,
    decrypt(payload) { return decryptChannel(this, payload); },
  };
}

// payload layout for GRP_TXT / GRP_DATA: [channel_hash:1][mac:2][ciphertext:N*16]
function decryptChannel(ch, payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length < 1 + CIPHER_MAC_SIZE + 16) return null;
  if (payload[0] !== ch.hashByte) return null;

  const mac = payload.subarray(1, 1 + CIPHER_MAC_SIZE);
  const ciphertext = payload.subarray(1 + CIPHER_MAC_SIZE);
  if (ciphertext.length % 16 !== 0) return null;

  const expected = createHmac('sha256', ch.hmacKey).update(ciphertext).digest().subarray(0, CIPHER_MAC_SIZE);
  if (!mac.equals(expected)) return null;

  // AES-128-ECB, zero padding
  const decipher = createDecipheriv('aes-128-ecb', ch.key16, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}
