// Supabase Edge Function: upload_document
// Server-side file upload to the `documents` storage bucket (holds the service-role
// key, so the client never needs it). Port of convex owners.uploadDocument.
// Used for KYC docs, meter photos, ticket photos, owner/asset documents.
//
// Deploy: supabase functions deploy upload_document --no-verify-jwt
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected.)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { base64, fileName, folder, contentType, bucket } = await req.json();
    if (!base64 || !fileName) return json({ error: 'base64 and fileName are required' }, 400);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const bytes = base64ToBytes(base64);
    const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${folder || 'owners'}/${Date.now()}_${safeName}`;
    const bucketName = bucket || 'documents';

    const { error } = await sb.storage.from(bucketName).upload(path, bytes, {
      contentType: contentType || 'image/jpeg',
      upsert: true,
    });
    if (error) return json({ error: `Upload failed: ${error.message}` }, 500);

    const { data } = sb.storage.from(bucketName).getPublicUrl(path);
    return json({ url: data.publicUrl, path });
  } catch (err: any) {
    console.error('[upload_document] Error:', err?.message);
    return json({ error: 'Something went wrong during upload.' }, 500);
  }
});
