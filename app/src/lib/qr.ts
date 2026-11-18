/** The browser's own barcode reader, where it has one (Chromium-based browsers and the desktop app). */
interface Detector {
  detect(image: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}
type DetectorClass = new (opts: { formats: string[] }) => Detector;

const DetectorOf = (): DetectorClass | null =>
  (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector ?? null;

/** Whether QR codes can be read from a picture here. */
export const canReadQr = () => !!DetectorOf();

/**
 * The text of the first QR code in a picture, read in this browser; nothing leaves for anywhere.
 * Null when there is none, or this browser cannot read one.
 */
export async function readQr(picture: Blob): Promise<string | null> {
  const Detector = DetectorOf();
  if (!Detector) return null;
  try {
    const bitmap = await createImageBitmap(picture);
    try {
      const [code] = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
      return code?.rawValue ?? null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
