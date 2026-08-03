"use node";

import { action } from './_generated/server';
import { v } from 'convex/values';
import { getSupabase } from './lib/supabaseAdmin';

const NOTICE_KEYWORDS = [
  'vacate', 'notice', 'leaving', 'exit', 'move out', 'checkout',
  'room vacate', 'shift room', 'leaving hostel', 'final day'
];

function isNoticeIntent(text: string) {
  const lower = text.toLowerCase();
  return NOTICE_KEYWORDS.some(k => lower.includes(k));
}

export const routeVoiceIntent = action({
  args: {
    transcript: v.string(),
    tenantId: v.string(),
    allotmentId: v.string(),
    bedId: v.string(),
    exitDate: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();

    if (isNoticeIntent(args.transcript)) {
      const exitDate =
        args.exitDate ||
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0];

      await sb.from('tenant_notices').insert({
        tenant_id: args.tenantId,
        allotment_id: args.allotmentId,
        bed_id: args.bedId,
        notice_date: new Date().toISOString().split('T')[0],
        exit_date: exitDate,
        notes: args.transcript,
      });

      return { type: 'notice', success: true };
    }

    return { type: 'ticket', success: true };
  },
});
