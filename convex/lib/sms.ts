/**
 * sms.ts — Fast2SMS helper for ticket assignment notifications.
 *
 * Supports two modes (controlled by env var TICKET_SMS_TEMPLATE_ID):
 *
 *   MODE A — DLT Template (recommended for production):
 *     Set TICKET_SMS_TEMPLATE_ID to your Fast2SMS numeric message ID.
 *     Your DLT template must use {#var#} placeholders in this order:
 *       {#var#} 1 = techName
 *       {#var#} 2 = ticketNumber
 *       {#var#} 3 = issueType      (or "N/A")
 *       {#var#} 4 = apartmentCode  (or "N/A")
 *       {#var#} 5 = priority       (or "N/A")
 *       {#var#} 6 = slaDeadline    (or "N/A")
 *
 *     Suggested DLT template text to register on Fast2SMS portal:
 *     "Hi {#var#}, ticket {#var#} for {#var#} at {#var#} has been assigned
 *      to you. Priority: {#var#}. SLA: {#var#}. Please check your app. - VISHFL"
 *
 *   MODE B — Quick SMS (fallback, no DLT registration needed):
 *     Leave TICKET_SMS_TEMPLATE_ID unset or empty.
 *
 * Environment variables (Convex dashboard → Settings → Env Variables):
 *   FAST2SMS_API_KEY         — same key used for OTP (required)
 *   SMS_ENABLED              — "true" to send real SMS (default: "false")
 *   TICKET_SMS_SENDER_ID     — sender ID (default: "VISHFL")
 *   TICKET_SMS_TEMPLATE_ID   — numeric message ID from Fast2SMS DLT portal
 *                              Leave empty to use Quick SMS fallback
 */

function isSmsEnabled(): boolean {
  return (process.env.SMS_ENABLED || "false").toLowerCase() === "true";
}

/**
 * Core SMS sender.
 * Picks DLT route if TICKET_SMS_TEMPLATE_ID is set, Quick SMS otherwise.
 */
async function sendSms(
  phone: string,
  plainTextMessage: string,
  variables: string[]
): Promise<void> {
  const clean = phone.replace(/\D/g, "").replace(/^91/, "").slice(-10);

  if (clean.length !== 10) {
    console.warn("[SMS] Invalid phone number, skipping:", phone);
    return;
  }

  if (!isSmsEnabled()) {
    console.log(`[SMS] (disabled) Would send to +91${clean}:`, plainTextMessage);
    return;
  }

  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.warn("[SMS] FAST2SMS_API_KEY not set — skipping SMS");
    return;
  }

  const templateId = process.env.TICKET_SMS_TEMPLATE_ID || "";
  const senderId   = process.env.TICKET_SMS_SENDER_ID   || "VISHFL";
  const url        = "https://www.fast2sms.com/dev/bulkV2";

  let params: URLSearchParams;

  if (templateId) {
    // ── MODE A: DLT Template ────────────────────────────────────────────────
    // variables_values = pipe-separated values matching {#var#} slots in order
    params = new URLSearchParams({
      authorization:    apiKey,
      route:            "dlt",
      sender_id:        senderId,
      message:          templateId,
      variables_values: variables.join("|"),
      numbers:          clean,
    });
    console.log(`[SMS] DLT | template:${templateId} | vars:${variables.join("|")} | to:+91${clean}`);
  } else {
    // ── MODE B: Quick SMS fallback ──────────────────────────────────────────
    params = new URLSearchParams({
      authorization: apiKey,
      route:         "q",
      message:       plainTextMessage,
      numbers:       clean,
      flash:         "0",
    });
    console.log(`[SMS] QuickSMS | to:+91${clean} | msg:${plainTextMessage}`);
  }

  try {
    const response = await fetch(`${url}?${params.toString()}`, {
      method:  "GET",
      headers: { "cache-control": "no-cache" },
    });

    const raw = await response.text();
    console.log("[SMS] HTTP status:", response.status, "| response:", raw);

    let result: any = {};
    try { result = JSON.parse(raw); } catch { result = { return: response.ok }; }

    if (!result.return) {
      // Never throw — SMS failure must not break ticket creation/assignment
      console.error("[SMS] Fast2SMS error:", raw);
    } else {
      console.log(`[SMS] Sent successfully to +91${clean} | requestId:`, result.request_id);
    }
  } catch (err: any) {
    console.error("[SMS] Fetch failed:", err?.message);
  }
}

/**
 * Sends a ticket assignment notification SMS to a technician.
 * Auto-selects DLT or Quick SMS based on TICKET_SMS_TEMPLATE_ID env var.
 */
export async function sendTicketAssignmentSms(opts: {
  phone:          string;
  techName:       string;
  ticketNumber:   string;
  issueType?:     string | null;
  apartmentCode?: string | null;
  priority?:      string | null;
  slaDeadline?:   string | null;
}): Promise<void> {
  const { phone, techName, ticketNumber, issueType, apartmentCode, priority, slaDeadline } = opts;

  // Format SLA in IST
  let slaFormatted = "N/A";
  if (slaDeadline) {
    try {
      slaFormatted = new Date(slaDeadline).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day:      "numeric",
        month:    "short",
        hour:     "2-digit",
        minute:   "2-digit",
      });
    } catch { /* keep N/A */ }
  }

  const issueVal    = issueType     || "N/A";
  const locationVal = apartmentCode || "N/A";
  const priorityVal = priority      ? priority.toUpperCase() : "N/A";

  // Variable order must match your DLT template's {#var#} slots exactly
  const variables = [
    techName,      // {#var#} 1
    ticketNumber,  // {#var#} 2
    issueVal,      // {#var#} 3
    locationVal,   // {#var#} 4
    priorityVal,   // {#var#} 5
    slaFormatted,  // {#var#} 6
  ];

  // Plain-text fallback (Quick SMS mode)
  const plainText =
    `Hi ${techName}, ticket ${ticketNumber} for ${issueVal} at ${locationVal} ` +
    `has been assigned to you. Priority: ${priorityVal}. SLA: ${slaFormatted}. ` +
    `Please check your app.`;

  await sendSms(phone, plainText, variables);
}