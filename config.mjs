export const config = {
  radios: [
    {
      name: 'Czech',
      port: '/dev/serial/by-id/usb-RAKwireless_WisCore_RAK3401_Board_AB64A0C3AA6F778B-if00',
      freq: 869.432,
      bw: 62.5,
      sf: 7,
      cr: 5,
      txPower: 22,
    },
    {
      name: 'EU',
      port: '/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_80:F1:B2:64:8E:34-if00',
      freq: 869.618,
      bw: 62.5,
      sf: 8,
      cr: 5,
      txPower: 22,
    },
  ],
  filter(packet, constants) {
    return packet.type === constants.GRP_TXT && packet.isFromChannel('#cs');
  },
};
