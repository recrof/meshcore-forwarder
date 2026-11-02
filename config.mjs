export const config = {
  radios: [
    {
      name: 'CZ',
      port: '/dev/cu.usbmodem101',
      freq: 869.432,
      bw: 62.5,
      sf: 7,
      cr: 5,
      txPower: 22,
    },
    {
      name: 'SK',
      port: '/dev/cu.usbmodemF09E9E7747081',
      freq: 869.618,
      bw: 62.5,
      sf: 7,
      cr: 5,
      txPower: 22,
    },
  ],
  // forward all non-flood packets, but only flood packets scoped to region #cs
  filter(packet, constants) {
    if (!packet.isFlood) return true;
    return packet.isInRegion('#cs');
  },
};
