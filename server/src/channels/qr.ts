import QRCode from 'qrcode';

/** A QR code as a PNG data URL, which the web page and the phone app both show as an image. */
export function qrImage(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
}
