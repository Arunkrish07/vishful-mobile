// ============================================================
// ownerImport.ts — bulk import of OWNER RENTAL PAYMENTS from CSV.
//
// Direct-Supabase port of the web Owners.tsx xlsx import —
// C:/vishful-web-v7/external-db-guide-f04b8927-main/src/pages/Owners.tsx
//   • downloadPaymentTemplate  (lines ~735-825)
//   • handleImportPayments     (lines ~893-980)
//
// DEVIATION: the web app reads/writes .xlsx via the `xlsx` package. That
// dependency is NOT installed in mobile and must not be added, so this
// module uses CSV instead (template download + CSV parse). The DB
// table/columns, the apartment-code→contract mapping, the per-row payload,
// append/replace semantics and the batch-insert size (50) are identical.
//
// Owner fns live in lib/supabaseService.ts (imported by OwnersScreen) — that
// file must not be edited, so this NEW module owns the import logic and reads
// owner_contracts itself (getOwnerDetail does not expose contract.apartment_id).
// ============================================================
import { supabase } from "./supabase";
import { ORG_ID, safeList, DELETES_ENABLED, deleteDisabledResult, toISODate } from "./supabaseDb";
import { shareCsv } from "./csvExport";

// Column headers — VERBATIM from web downloadPaymentTemplate (Owners.tsx ~736-749),
// so a file exported from either app imports identically.
export const OWNER_PAYMENT_HEADERS = [
  "Payment Month (YYYY-MM)",
  "Apartment Code",
  "Contract Type",
  "Bill Date (YYYY-MM-DD)",
  "Due Date (YYYY-MM-DD)",
  "Base Amount",
  "Escalated Amount",
  "Status (pending/paid)",
  "Paid Date (YYYY-MM-DD)",
  "Payment Mode (transfer/cash/cheque/upi/credit_card)",
  "Reference Number",
  "Notes",
];

const SAMPLE_ROW = [
  "2025-04", "APT-101", "rent", "2025-04-01", "2025-04-05",
  "25000", "26250", "paid", "2025-04-03", "transfer", "UTR123456", "April rent payment",
];

/** Share a blank CSV template (headers + one sample row) via the OS share sheet. */
export async function downloadOwnerPaymentsTemplate(): Promise<void> {
  await shareCsv("owner-payments-template", OWNER_PAYMENT_HEADERS, [SAMPLE_ROW]);
}

// ── RFC-4180 CSV parser (handles quotes, escaped "" quotes, commas & newlines) ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      // Only end a row on a newline not immediately preceded by \r already handled.
      if (c === "\r" && s[i + 1] === "\n") i++; // CRLF → single break
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // flush trailing field/row (file without a final newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse CSV text into header-keyed row objects (first non-empty row = header). */
export function parseOwnerPaymentsCsv(text: string): Record<string, string>[] {
  const matrix = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (matrix.length < 2) return [];
  const headers = matrix[0].map((h) => h.trim());
  return matrix.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? "").trim(); });
    return obj;
  });
}

export type ImportResult =
  | { success: true; inserted: number; mode: "append" | "replace"; skipped: number }
  | { success: boolean; disabled: true; message: string }
  | { success: false; message: string };

/**
 * Import owner rental payments from CSV text.
 * Verbatim port of handleImportPayments (Owners.tsx ~893-980), CSV in place of xlsx.
 *
 * Mapping (identical to web):
 *   apartment code → owner_contract for this owner → contract.id / contract.apartment_id.
 *   Rows with no month or no matching contract are skipped.
 *
 * mode "replace": delete this owner's existing owner_payments (per contract) first.
 * That delete is money-adjacent, so it is routed through DELETES_ENABLED — when deletes
 * are disabled, nothing is deleted OR inserted and a disabled result is returned.
 */
export async function importOwnerPayments(args: {
  ownerId: string;
  csvText: string;
  mode: "append" | "replace";
}): Promise<ImportResult> {
  const { ownerId, csvText, mode } = args;

  // This owner's contracts, joined to apartment code (getOwnerDetail omits apartment_id).
  const contracts = await safeList(
    supabase.from("owner_contracts")
      .select("id, apartment_id, apartments(apartment_code)")
      .eq("owner_id", ownerId).eq("organization_id", ORG_ID),
  );
  if ((contracts as any[]).length === 0) {
    return { success: false, message: "This owner has no contracts to attach payments to." };
  }

  // apartment_code(lower) → contract  (web ownerContractsByApt)
  const ownerContractsByApt = new Map<string, any>();
  (contracts as any[]).forEach((c: any) => {
    const code = String(c.apartments?.apartment_code || "").toLowerCase();
    if (code) ownerContractsByApt.set(code, c);
  });

  const rows = parseOwnerPaymentsCsv(csvText);
  if (rows.length === 0) return { success: false, message: "No data found in file." };

  let skipped = 0;
  const paymentRows: any[] = [];
  for (const row of rows) {
    const month = String(row["Payment Month (YYYY-MM)"] || "").trim();
    const aptCode = String(row["Apartment Code"] || "").trim().toLowerCase();
    const contract = ownerContractsByApt.get(aptCode);
    if (!month || !contract) { skipped++; continue; }

    const status = String(row["Status (pending/paid)"] || "pending").toLowerCase();
    const billDate = toISODate(row["Bill Date (YYYY-MM-DD)"]) || null;
    const dueDate = toISODate(row["Due Date (YYYY-MM-DD)"]) || null;
    const paidDate = toISODate(row["Paid Date (YYYY-MM-DD)"]) || null;
    paymentRows.push({
      organization_id: ORG_ID,
      owner_id: ownerId,
      contract_id: contract.id,
      apartment_id: contract.apartment_id,
      payment_month: month,
      bill_date: billDate,
      due_date: dueDate,
      actual_due_date: dueDate,
      base_amount: parseFloat(row["Base Amount"]) || 0,
      escalated_amount: parseFloat(row["Escalated Amount"]) || 0,
      status: status === "paid" ? "paid" : "pending",
      paid_date: paidDate,
      payment_mode: row["Payment Mode (transfer/cash/cheque/upi/credit_card)"] || null,
      reference_number: row["Reference Number"] ? String(row["Reference Number"]) : null,
      notes: row["Notes"] || null,
    });
  }

  if (paymentRows.length === 0) return { success: false, message: "No valid rows to import (check apartment codes)." };

  // REPLACE: clear this owner's existing payments first — a real delete, gated.
  if (mode === "replace") {
    if (!DELETES_ENABLED) return deleteDisabledResult();
    for (const c of contracts as any[]) {
      const { error } = await supabase
        .from("owner_payments").delete().eq("contract_id", c.id).eq("organization_id", ORG_ID);
      if (error) return { success: false, message: `Replace failed while clearing existing payments: ${error.message}` };
    }
  }

  // Batch insert (size 50, same as web).
  const batchSize = 50;
  for (let i = 0; i < paymentRows.length; i += batchSize) {
    const batch = paymentRows.slice(i, i + batchSize);
    const { error } = await supabase.from("owner_payments").insert(batch as any);
    if (error) return { success: false, message: `Insert failed: ${error.message}` };
  }

  return { success: true, inserted: paymentRows.length, mode, skipped };
}
