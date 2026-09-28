/**
 * BarcodeScanner.tsx — read a product's barcode with the phone's camera.
 *
 * Opens the back camera in a small live preview, and the moment it reads a
 * barcode (the kinds printed on food: UPC-A, UPC-E, EAN-13, EAN-8) it hands the
 * digits up and turns the camera off. The reading is done by the zxing library
 * in plain JavaScript, so it works in iPhone Safari too, which has no built-in
 * barcode reader. The library is only downloaded when this opens: the parent
 * loads this file with React.lazy (./PackagedSearch.tsx).
 *
 * The camera needs a secure page (https) and her permission. When it can't
 * open, it says why, and the number printed under the bars can be typed in.
 *
 * Prompt: "Scanning with the phone camera is a good second step once typing in
 * a barcode works (the site is a touch-first PWA)."
 */
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { useEffect, useRef, useState } from 'react';
import styles from './Nutrition.module.css';

// Only the formats food packages carry: fewer formats, faster and surer reads.
const FOOD_FORMATS = [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8];

export default function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Start the camera on open, stop it on the first read or on close.
  useEffect(() => {
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, FOOD_FORMATS]]);
    const reader = new BrowserMultiFormatReader(hints);
    let controls: IScannerControls | null = null;
    let done = false;
    reader
      .decodeFromConstraints({ video: { facingMode: 'environment' } }, videoRef.current ?? undefined, (result) => {
        if (result && !done) {
          done = true;
          controls?.stop();
          onCode(result.getText());
        }
      })
      .then((started) => {
        controls = started;
        if (done) started.stop();
      })
      .catch((error: Error) => setProblem(cameraProblem(error)));
    return () => {
      done = true;
      controls?.stop();
    };
  }, [onCode]);

  return (
    <div className={styles.scanner}>
      {problem ? (
        <p className={styles.error}>{problem}</p>
      ) : (
        <>
          <video ref={videoRef} className={styles.scannerVideo} muted playsInline />
          <p className={styles.muted}>Hold the barcode flat in the frame, a hand's width away.</p>
        </>
      )}
      <button type="button" className={styles.chip} onClick={onClose}>
        Close camera
      </button>
    </div>
  );
}

// Say in words why the camera didn't open.
function cameraProblem(error: Error): string {
  if (error.name === 'NotAllowedError') return 'The camera is blocked for this site. Allow it in the browser settings, or type the number under the bars.';
  if (error.name === 'NotFoundError') return 'No camera found here. Type the number under the bars instead.';
  if (!window.isSecureContext) return 'The camera only opens on the https address. Type the number under the bars instead.';
  return `The camera didn't open (${error.message}). Type the number under the bars instead.`;
}
