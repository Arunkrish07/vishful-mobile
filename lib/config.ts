// ============================================================
// SUPABASE CONFIGURATION
// Credentials are embedded directly — no external bootstrapping needed.
// The anon key is designed to be used client-side (subject to RLS).
// ============================================================
export const SUPABASE_URL = 'https://slljsigvfaxngpjaajjd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsbGpzaWd2ZmF4bmdwamFhampkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzI2NTQsImV4cCI6MjA4OTI0ODY1NH0.87jgDYMaRTM2JlVUulKZX0F4NKRg0GPWchwjCDmXmoU';

// Service role key — bypasses RLS. Paste your key from:
// Supabase Dashboard → Project Settings → API → service_role (secret)
export const SUPABASE_SERVICE_ROLE_KEY = 'PASTE_YOUR_SERVICE_ROLE_KEY_HERE';

export const ORG_ID = '00000000-0000-0000-0000-000000000001';

// ============================================================
// CONVEX BACKEND
// ONE place to repoint the whole app at a different Convex deployment.
// Set this to your Convex deployment name from `npx convex deploy`
// (e.g. "rapid-lion-123"). CONVEX_CLOUD_URL is the action-client URL;
// CONVEX_SITE_URL is the direct HTTP host (/api/transcribe, etc.).
// ============================================================
export const CONVEX_DEPLOYMENT = 'polished-sockeye-740'; // ← CHANGE to your new deployment name
export const CONVEX_CLOUD_URL = `https://${CONVEX_DEPLOYMENT}.convex.cloud`;
export const CONVEX_SITE_URL = `https://${CONVEX_DEPLOYMENT}.convex.site`;