#!/usr/bin/env node
import { config } from './config.mjs';
import { Radio } from './lib/radio.mjs';
import { wrap, Constants } from './lib/packet-wrap.mjs';
import { Dedup } from './lib/dedup.mjs';
import { makeLogger } from './lib/log.mjs';

const log = makeLogger('forwarder');
const dedup = new Dedup();

function handleRx(sourceRadio, radios, raw) {
  let packet;
  try {
    packet = wrap(raw);
  } catch (err) {
    log.warn(`${sourceRadio.name}: parse error: ${err.message}`);
    return;
  }

  if (packet.is_marked_do_not_retransmit) return;

  if (dedup.seen(packet)) {
    log.info(`${sourceRadio.name}: dup ${packet.typeName} dropped`);
    return;
  }

  let pass = true;
  if (typeof config.filter === 'function') {
    try {
      pass = !!config.filter(packet, Constants);
    } catch (err) {
      log.warn(`filter threw: ${err.message}`);
      pass = false;
    }
  }
  if (!pass) return;

  log.info(`${sourceRadio.name} -> fwd ${packet.typeName} (${packet.raw.length}B)`);
  for (const r of radios) {
    if (r === sourceRadio) continue;
    r.enqueue(packet.raw);
  }
}

async function main() {
  if (!Array.isArray(config.radios) || config.radios.length < 2) {
    log.error('config.radios must contain at least 2 entries');
    process.exit(1);
  }

  const radios = config.radios.map((cfg) => new Radio(cfg, makeLogger(cfg.name)));

  try {
    await Promise.all(radios.map((r) => r.start()));
  } catch (err) {
    log.error(err.message);
    process.exit(2);
  }

  for (const r of radios) {
    r.on('rx', (raw) => handleRx(r, radios, raw));
  }

  log.info(`up with ${radios.length} radios`);

  const shutdown = async (sig) => {
    log.info(`${sig} received, shutting down`);
    await Promise.allSettled(radios.map((r) => r.stop()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
