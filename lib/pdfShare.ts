/**
 * Render an HTML string to a PDF on-device (expo-print) and hand it to the OS
 * share sheet (expo-sharing); on web, open a print window instead. Guarded
 * `require` so the bundle never hard-fails where the native modules are absent.
 * Shared by the pay-slip, invoice, and receipt PDF builders.
 */
import { Platform } from 'react-native';

export async function htmlToPdfAndShare(html: string, opts: { dialogTitle?: string } = {}): Promise<void> {
  if (Platform.OS === 'web') {
    const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (!w) throw new Error('Allow pop-ups to open the document for printing.');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 350);
    return;
  }

  let Print: any;
  try { Print = require('expo-print'); }
  catch { throw new Error('PDF module (expo-print) is not available in this build.'); }
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  let Sharing: any;
  try { Sharing = require('expo-sharing'); }
  catch { throw new Error('Sharing module (expo-sharing) is not available.'); }
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: opts.dialogTitle || 'Share PDF',
    UTI: 'com.adobe.pdf',
  });
}
