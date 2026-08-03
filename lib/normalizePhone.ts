/**
 * Phone normalization helper
 * Standardizes phone formats across the app
 */

export function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return '';
  
  // Remove all non-digits
  const digitsOnly = phone.replace(/\D/g, '');
  
  // Keep only last 10 digits
  const last10 = digitsOnly.slice(-10);
  
  return last10;
}

export function phoneVariants(phone: string | null | undefined): string[] {
  if (!phone) return [];
  
  const clean = normalizePhone(phone);
  if (!clean || clean.length < 10) return [];
  
  return [
    clean,           // Last 10 digits: 8770097459
    `+91${clean}`,   // With +91: +918770097459
    `91${clean}`,    // With 91: 918770097459
    `0${clean}`,     // With 0 prefix: 08770097459
    phone,           // Raw input as-is
  ].filter(v => v && v.length > 0);
}

/**
 * Safe optional field access with defaults
 * Usage: safeGet(tenant, 'property_name', 'N/A')
 */
export function safeGet<T = any>(
  obj: T | null | undefined,
  path: string,
  defaultValue: any = null
): any {
  if (!obj) return defaultValue;
  
  const keys = path.split('.');
  let value: any = obj;
  
  for (const key of keys) {
    if (value == null) return defaultValue;
    value = value[key];
  }
  
  return value ?? defaultValue;
}
