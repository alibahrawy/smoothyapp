import qrcode from 'qrcode-generator';

/** Self-contained QR used in the desktop panel; never requests an external service. */
export function makeQrDataUrl(value: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
