/**
 * Build a CSV from rows and hand it to the OS share sheet (native, via
 * expo-file-system + expo-sharing) or trigger a browser download (web).
 * Guarded requires so the bundle never hard-fails where the modules are absent.
 */
import { Platform } from 'react-native';

/** RFC-4180 field escaping: quote when the value has a comma, quote or newline. */
function csvField(v: any): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n');
}

/** Sanitize a filename stem (no extension). */
function safeName(stem: string): string {
  return (stem || 'export').replace(/[^\w.-]+/g, '_').slice(0, 80);
}

/**
 * Share a CSV file. `filenameStem` is without extension.
 * Throws a friendly Error if the native modules aren't available.
 */
export async function shareCsv(filenameStem: string, headers: string[], rows: (string | number | null | undefined)[][]): Promise<void> {
  const csv = buildCsv(headers, rows);
  const filename = `${safeName(filenameStem)}.csv`;

  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') throw new Error('CSV export is not available here.');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  let FileSystem: any;
  try { FileSystem = require('expo-file-system'); }
  catch { throw new Error('File module (expo-file-system) is not available in this build.'); }
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) throw new Error('No writable directory available for the CSV.');
  const uri = `${dir}${filename}`;
  await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType?.UTF8 || 'utf8' });

  let Sharing: any;
  try { Sharing = require('expo-sharing'); }
  catch { throw new Error('Sharing module (expo-sharing) is not available.'); }
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle: 'Export CSV', UTI: 'public.comma-separated-values-text' });
}
