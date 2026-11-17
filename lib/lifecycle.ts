// ============================================================
// lifecycle.ts — Tenant Lifecycle direct-Supabase port.
//
// Verbatim port of the tenant-lifecycle actions from
// convex/tenants.ts + convex/tenantsextraactions.ts + convex/exiteb.ts,
// running through the logged-in user's `supabase` client (RLS) instead
// of the Convex service-role layer. Money-critical: booking / onboarding /
// room-switch / exit / refund billing. Each exported fn keeps the SAME
// single-object arg shape as the Convex action it replaces, so the screen
// rewire is a pure dispatch swap.
//
// Deletes honour the org-wide DELETES_ENABLED switch (product decision):
// undo-onboarding, cancel-notice and delete-absence throw until deletes
// are enabled.
// ============================================================
import { supabase } from "./supabase";
import { ORG_ID, safeList, insertRow, deleteRow, DELETES_ENABLED } from "./supabaseDb";

// ════════════════════════════════════════════════════════════════════
// EXIT-MONTH ESTIMATED EB — pure helpers (port of convex/exiteb.ts)
// ════════════════════════════════════════════════════════════════════
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMMMyy = (d: Date) => `${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
const fmtYYYYMM = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const daysInMonthOf = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const diffDaysInclusive = (start: Date, end: Date) => Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
const TENANT_DAY_STATUSES = ["Staying", "On-Notice", "Exited", "Booked"];

function pureTenantDaysInMonth(allotments: any[], aptId: string, monthStart: Date): number {
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const aptAllotments = (allotments || []).filter(
    (a: any) => a.apartment_id === aptId && a.onboarding_date && TENANT_DAY_STATUSES.includes(a.staying_status),
  );
  let totalDays = 0;
  for (const a of aptAllotments) {
    const onboard = new Date(a.onboarding_date);
    const exit = a.actual_exit_date ? new Date(a.actual_exit_date) : null;
    const stayStart = onboard > monthStart ? onboard : monthStart;
    const stayEnd = exit && exit < monthEnd ? exit : monthEnd;
    const days = diffDaysInclusive(stayStart, stayEnd);
    if (days > 0) totalDays += days;
  }
  return totalDays || daysInMonthOf(monthStart);
}

function findPrevMonthReading(readings: any[], aptId: string, exitDate: Date): any | null {
  const prevMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() - 1, 1);
  const s1 = fmtMMMyy(prevMonth);
  const s2 = fmtYYYYMM(prevMonth);
  return (readings || []).find((r: any) => r.apartment_id === aptId && (r.billing_month === s1 || r.billing_month === s2)) || null;
}

function getExitMonthEbBreakdown(aptId: string, exitDate: Date, readings: any[], allotments: any[]) {
  const daysInExitMonth = exitDate.getDate();
  const reading = findPrevMonthReading(readings, aptId, exitDate);
  if (!reading) return { perDayRate: 0, daysInExitMonth, estimatedAmount: 0 };
  const totalUnits = Number(reading.reading_end) - Number(reading.reading_start);
  const unitCost = Number(reading.unit_cost);
  const totalBill = totalUnits * unitCost;
  const prevMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() - 1, 1);
  const totalTenantDays = pureTenantDaysInMonth(allotments, aptId, prevMonth);
  const perDayRate = totalTenantDays > 0 ? totalBill / totalTenantDays : 0;
  return { perDayRate, daysInExitMonth, estimatedAmount: Math.ceil(perDayRate * daysInExitMonth) };
}

/** What estimated EB (if any) is already invoiced for the exit billing month. */
async function fetchExitMonthEstimatedEb(allotmentId: string, billingMonth: string, exitDateIso: string): Promise<{ included: boolean; amount: number }> {
  const invoices = await safeList(
    supabase.from("invoices").select("id, estimated_eb")
      .eq("allotment_id", allotmentId).eq("billing_month", billingMonth).lte("invoice_date", exitDateIso)
      .or("is_deleted.is.null,is_deleted.eq.false"),
  );
  let amount = 0;
  let included = false;
  for (const inv of invoices as any[]) {
    const e = Number(inv.estimated_eb || 0);
    if (e > 0) { amount += e; included = true; }
  }
  if (!included && (invoices as any[]).length > 0) {
    const ids = (invoices as any[]).map((i: any) => i.id).filter(Boolean);
    const lines = await safeList(
      supabase.from("invoice_line_items").select("amount").in("invoice_id", ids).eq("line_type", "estimated_eb"),
    );
    for (const l of lines as any[]) {
      const a = Number(l.amount || 0);
      if (a > 0) { amount += a; included = true; }
    }
  }
  return { included, amount: Math.round(amount) };
}

/** Replace the already-invoiced estimated EB for the exit billing month with a revised value. */
async function reviseExitEbInvoice(params: { allotmentId: string; exitBillingMonth: string; exitDateIso: string; targetEb: number }) {
  const { allotmentId, exitBillingMonth, exitDateIso } = params;
  const newEb = Math.max(0, Math.round(params.targetEb));
  const invoices = await safeList(
    supabase.from("invoices")
      .select("id, estimated_eb, rent_amount, electricity_amount, other_charges, late_fee, amount_paid, locked")
      .eq("allotment_id", allotmentId).eq("billing_month", exitBillingMonth).lte("invoice_date", exitDateIso)
      .or("is_deleted.is.null,is_deleted.eq.false"),
  );
  const invIds = (invoices as any[]).map((i: any) => i.id).filter(Boolean);
  let lines: any[] = [];
  if (invIds.length > 0) {
    lines = await safeList(
      supabase.from("invoice_line_items").select("id, invoice_id, amount, description").in("invoice_id", invIds).eq("line_type", "estimated_eb"),
    );
  }
  const byId = new Map((invoices as any[]).map((i: any) => [i.id, i]));
  let carrier: any =
    (invoices as any[]).filter((i: any) => Number(i.estimated_eb || 0) > 0)
      .sort((a: any, b: any) => Number(b.estimated_eb || 0) - Number(a.estimated_eb || 0))[0] || null;
  let carrierLine = carrier ? lines.find((l: any) => l.invoice_id === carrier.id) || null : null;
  if (!carrier && lines.length > 0) {
    carrierLine = [...lines].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0];
    carrier = byId.get(carrierLine.invoice_id) || null;
  }
  if (!carrier) return { changed: false, locked: false, oldEb: 0, newEb, delta: 0 };
  const oldEb = Math.round(Number(carrier.estimated_eb || 0) > 0 ? Number(carrier.estimated_eb) : Number(carrierLine?.amount || 0));
  const delta = newEb - oldEb;
  if (Math.abs(delta) < 1) return { changed: false, locked: false, oldEb, newEb, delta: 0 };
  if (carrier.locked) return { changed: false, locked: true, oldEb, newEb, delta };
  const rent = Number(carrier.rent_amount || 0);
  const elec = Number(carrier.electricity_amount || 0);
  const other = Number(carrier.other_charges || 0);
  const late = Number(carrier.late_fee || 0);
  const paid = Number(carrier.amount_paid || 0);
  const totalAmount = rent + elec + newEb + other + late;
  const balance = Math.max(0, totalAmount - paid);
  const status = balance <= 0 ? "paid" : paid > 0 ? "partial" : "pending";
  await supabase.from("invoices").update({ estimated_eb: newEb, total_amount: totalAmount, balance, status }).eq("id", carrier.id);
  const dir = delta > 0 ? "increased" : "decreased";
  const note = `Estimated EB ${dir} by ₹${Math.abs(delta)} due to change of exit date (as of ${exitDateIso}).`;
  if (carrierLine) {
    const baseDesc = String(carrierLine.description || "").split(" | Estimated EB ")[0];
    await supabase.from("invoice_line_items").update({ amount: newEb, description: `${baseDesc} | ${note}` }).eq("id", carrierLine.id);
  } else {
    await insertRow("invoice_line_items", { invoice_id: carrier.id, line_type: "estimated_eb", amount: newEb, description: note });
  }
  return { changed: true, locked: false, oldEb, newEb, delta };
}

// ════════════════════════════════════════════════════════════════════
// ROOM-SWITCH financial helpers (port of convex/tenants.ts)
// ════════════════════════════════════════════════════════════════════

// Sum of each tenant's occupied days in `apartmentId` during the month of prevMonth (DB-backed).
async function getTotalTenantDaysInMonthDb(apartmentId: string, prevMonth: Date): Promise<number> {
  const y = prevMonth.getFullYear(), m = prevMonth.getMonth();
  const monthStart = new Date(y, m, 1);
  const monthEnd = new Date(y, m + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const { data: allots } = await supabase.from("tenant_allotments")
    .select("onboarding_date, actual_exit_date, staying_status")
    .eq("apartment_id", apartmentId).eq("organization_id", ORG_ID);
  const eligible = (allots || []).filter((a: any) =>
    !!a.onboarding_date && ["Staying", "On-Notice", "Exited", "Booked"].includes(a.staying_status));
  if (eligible.length === 0) return daysInMonth;
  let total = 0;
  for (const a of eligible) {
    const onb = new Date(a.onboarding_date);
    const ext = a.actual_exit_date ? new Date(a.actual_exit_date) : monthEnd;
    const start = onb > monthStart ? onb : monthStart;
    const end = ext < monthEnd ? ext : monthEnd;
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days > 0) total += days;
  }
  return total > 0 ? total : daysInMonth;
}

async function computeSwitchDepositDiff(allotmentId: string, oldRate: number, newRate: number, cutoffStr: string): Promise<number> {
  const advanceRatio = 1.5;
  const baseDeposit = Math.round(oldRate * advanceRatio);
  const cutoff = (cutoffStr || "").slice(0, 10);
  const onOrBefore = (d?: string | null) => !d || String(d).slice(0, 10) <= cutoff;
  const [addInvRes, depAdjRes] = await Promise.all([
    supabase.from("invoices").select("total_amount, invoice_date, due_date, created_at")
      .eq("allotment_id", allotmentId).eq("invoice_type", "additional_deposit"),
    supabase.from("tenant_adjustments").select("amount, adjustment_type, adjustment_date, created_at")
      .eq("allotment_id", allotmentId).eq("category", "Deposit Adjustment"),
  ]);
  const addDepTotal = (addInvRes.data || [])
    .filter((i: any) => onOrBefore(i.invoice_date || i.due_date || i.created_at))
    .reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
  const depAdjTotal = (depAdjRes.data || [])
    .filter((a: any) => onOrBefore(a.adjustment_date || a.created_at))
    .reduce((s: number, a: any) => s + (a.adjustment_type === "credit_note" ? -1 : 1) * Number(a.amount || 0), 0);
  const existingDeposit = baseDeposit + addDepTotal + depAdjTotal;
  if (newRate > oldRate) return Math.round((newRate - oldRate) * advanceRatio);
  if (newRate < oldRate) return Math.round(newRate * advanceRatio - existingDeposit);
  return 0;
}

async function postSwitchFinancials(p: {
  tenantId: string; allotmentId: string; bedId: string;
  apartmentId: string | null; propertyId: string | null;
  oldRate: number; newRate: number;
  switchDateStr: string; effectiveDateStr: string;
  onboardingDate: string | null; switchId: string; depositDiff: number;
}): Promise<void> {
  const sd = new Date(p.switchDateStr);
  const daysInMonth = new Date(sd.getFullYear(), sd.getMonth() + 1, 0).getDate();
  const currentMonth = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, "0")}`;
  const onbSame = !!p.onboardingDate && String(p.onboardingDate).slice(0, 10) === String(p.switchDateStr).slice(0, 10);
  const chargeDays = onbSame ? 0 : daysInMonth - sd.getDate() + 1;
  const switchRentAmount = onbSame ? 0 : ((p.newRate - p.oldRate) / daysInMonth) * chargeDays;
  if (Math.abs(switchRentAmount) > 1) {
    if (switchRentAmount > 0) {
      const inv = await insertRow("invoices", {
        tenant_id: p.tenantId, allotment_id: p.allotmentId,
        property_id: p.propertyId || undefined, apartment_id: p.apartmentId || undefined,
        bed_id: p.bedId, invoice_type: "regular", billing_month: currentMonth,
        rent_amount: Math.ceil(switchRentAmount), total_amount: Math.ceil(switchRentAmount),
        balance: Math.ceil(switchRentAmount), invoice_date: p.effectiveDateStr, due_date: p.effectiveDateStr,
        status: "pending", reference_type: "room_switch", reference_id: p.switchId,
      });
      if (inv && inv.id) {
        await insertRow("invoice_line_items", {
          invoice_id: inv.id, line_type: "rent", amount: Math.ceil(switchRentAmount),
          description: `Rent Adjustment — Room upgrade for ${chargeDays} days`,
          metadata: {
            bed_rate: p.newRate, effective_rate: p.newRate,
            discount: 0, premium: 0, stay_days: chargeDays, total_days_in_month: daysInMonth,
            per_day_rent: chargeDays > 0 ? switchRentAmount / chargeDays : 0,
            old_rent: p.oldRate, new_rent: p.newRate, remaining_days: chargeDays, days_in_month: daysInMonth,
          },
        });
      }
    } else {
      await insertRow("tenant_adjustments", {
        tenant_id: p.tenantId, allotment_id: p.allotmentId, adjustment_type: "credit_note",
        amount: Math.abs(Math.ceil(switchRentAmount)),
        reason: `Rental Credit — Room downgrade for ${chargeDays} remaining days`,
        billing_month: currentMonth, property_id: p.propertyId || undefined,
        apartment_id: p.apartmentId || undefined, bed_id: p.bedId, adjustment_date: p.effectiveDateStr,
        reference_type: "room_switch", reference_id: p.switchId, created_by: null,
      });
    }
  }
  if (Math.abs(p.depositDiff) > 1) {
    if (p.depositDiff > 0) {
      await insertRow("invoices", {
        tenant_id: p.tenantId, allotment_id: p.allotmentId, property_id: p.propertyId || undefined,
        apartment_id: p.apartmentId || undefined, bed_id: p.bedId, invoice_type: "additional_deposit",
        billing_month: currentMonth, total_amount: Math.ceil(p.depositDiff), balance: Math.ceil(p.depositDiff),
        invoice_date: p.effectiveDateStr, due_date: p.effectiveDateStr, status: "pending",
        reference_type: "room_switch", reference_id: p.switchId,
      });
    } else {
      await insertRow("tenant_adjustments", {
        tenant_id: p.tenantId, allotment_id: p.allotmentId, adjustment_type: "credit_note",
        amount: Math.abs(Math.ceil(p.depositDiff)), reason: `Deposit returned — Room Switch downgrade`,
        category: "Deposit Adjustment", billing_month: currentMonth, property_id: p.propertyId || undefined,
        apartment_id: p.apartmentId || undefined, bed_id: p.bedId, adjustment_date: p.effectiveDateStr,
        reference_type: "room_switch", reference_id: p.switchId, created_by: null,
      });
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// LIFECYCLE ACTIONS (same single-object arg shapes as the Convex actions)
// ════════════════════════════════════════════════════════════════════

export async function listLifecycleReceipts() {
  const receipts = await safeList(
    supabase.from("receipts").select("*")
      .eq("organization_id", ORG_ID)
      .in("receipt_type", ["booking", "onboarding", "additional_payment", "settlement"])
      .order("created_at", { ascending: false })
  );
  const tenants = await safeList(supabase.from("tenants").select("id,full_name,phone").eq("organization_id", ORG_ID));
  const tMap: Record<string, any> = {};
  (tenants as any[]).forEach((t: any) => { tMap[t.id] = t; });
  return (receipts as any[]).map((r: any) => ({
    _id: r.id, tenantId: r.tenant_id,
    tenantName: tMap[r.tenant_id]?.full_name || "Unknown",
    tenantPhone: tMap[r.tenant_id]?.phone || "",
    allotmentId: r.tenant_allotment_id,
    amountPaid: Number(r.amount_paid) || 0, baseAmount: Number(r.base_amount) || 0,
    processingFee: Number(r.processing_fee) || 0, paymentMode: r.payment_mode || "",
    referenceNumber: r.reference_number || "", paymentDate: r.payment_date || r.created_at?.split("T")[0] || "",
    receiptType: r.receipt_type || "", createdAt: r.created_at,
  }));
}

export async function createBookingFull(args: { data: any }) {
  const data = args.data;
  const today = new Date().toISOString().split("T")[0];
  const allotment = await insertRow("tenant_allotments", {
    tenant_id: data.tenantId, property_id: data.propertyId, apartment_id: data.apartmentId, bed_id: data.bedId,
    booking_date: today, onboarding_date: data.onboardingDate || null, staying_status: "Booked",
    deposit_paid: 0, onboarding_charges: data.amount, paid_amount: data.amount, payment_status: "partial",
    discount: data.discount || 0, premium: data.premium || 0,
  });
  await insertRow("receipts", {
    tenant_id: data.tenantId, tenant_allotment_id: allotment.id, amount_paid: data.amount, base_amount: data.amount,
    processing_fee: 0, payment_mode: data.paymentMode, reference_number: data.referenceNumber || null,
    payment_date: today, receipt_type: "booking",
    ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
  });
  const bedStatus = data.isBedOnNotice ? "notice-booked" : "booked";
  await supabase.from("beds").update({ bed_lifecycle_status: bedStatus } as any).eq("id", data.bedId);
  await supabase.from("tenants").update({ staying_status: "booked" } as any).eq("id", data.tenantId);
  return { success: true, allotmentId: allotment.id };
}

export async function cancelBookingFull(args: { allotmentId: string; reason: string }) {
  const { allotmentId } = args;
  const allots = await safeList(
    supabase.from("tenant_allotments").select("*").eq("id", allotmentId).eq("organization_id", ORG_ID).limit(1)
  );
  const allot: any = allots[0];
  if (!allot) throw new Error("Allotment not found");
  await supabase.from("tenant_allotments").update({ staying_status: "Cancelled" } as any).eq("id", allotmentId).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", allot.bed_id);
  const others = await safeList(
    supabase.from("tenant_allotments").select("id").eq("tenant_id", allot.tenant_id)
      .eq("organization_id", ORG_ID).in("staying_status", ["Booked", "Staying", "On-Notice"]).neq("id", allotmentId)
  );
  if (others.length === 0) {
    const exitedOnes = await safeList(
      supabase.from("tenant_allotments").select("id").eq("tenant_id", allot.tenant_id)
        .eq("organization_id", ORG_ID).eq("staying_status", "Exited")
    );
    const newStatus = exitedOnes.length > 0 ? "exited" : "new";
    await supabase.from("tenants").update({ staying_status: newStatus } as any).eq("id", allot.tenant_id);
  }
  return { success: true };
}

export async function processOnboardingFull(args: { data: any }) {
  const data = args.data;
  const allots = await safeList(
    supabase.from("tenant_allotments").select("*").eq("id", data.allotmentId).eq("organization_id", ORG_ID).limit(1)
  );
  const allot: any = allots[0];
  if (!allot) throw new Error("Allotment not found");
  const paidNow = data.paidAmount || 0;
  const alreadyPaid = Math.max(allot.paid_amount || 0, allot.deposit_paid || 0);
  const totalPaid = alreadyPaid + paidNow;
  const balanceDue = Math.max(0, (data.totalDue || 0) - totalPaid);
  const paymentStatus = balanceDue <= 0 ? "paid" : "partial";
  const bedId = data.bedId || allot.bed_id;
  await supabase.from("tenant_allotments").update({
    staying_status: "Staying", onboarding_date: data.onboardingDate, bed_id: bedId,
    monthly_rental: data.monthlyRent, deposit_paid: data.advance, prorated_rent: data.proratedRent,
    onboarding_charges: data.onboardingCharges, total_due: data.totalDue, paid_amount: totalPaid,
    balance_due: balanceDue, payment_status: paymentStatus,
  } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  const ccChargesOnboard = Number(data.ccCharges) || 0;
  if (paidNow > 0) {
    await insertRow("receipts", {
      tenant_id: allot.tenant_id, tenant_allotment_id: data.allotmentId, amount_paid: paidNow, base_amount: paidNow,
      processing_fee: ccChargesOnboard, payment_mode: data.paymentMode, reference_number: data.referenceNumber || null,
      payment_date: data.onboardingDate || new Date().toISOString().split("T")[0], receipt_type: "onboarding",
      ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
    });
  }
  if (ccChargesOnboard > 0) {
    await insertRow("tenant_adjustments", {
      tenant_id: allot.tenant_id, allotment_id: data.allotmentId, adjustment_type: "debit_note",
      category: "cc_charges", reason: "CC Charges", amount: Math.ceil(ccChargesOnboard),
      adjustment_date: data.onboardingDate || new Date().toISOString().split("T")[0],
    });
  }
  await supabase.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", bedId);
  if (bedId !== allot.bed_id) {
    await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", allot.bed_id);
  }
  await supabase.from("tenants").update({ staying_status: "staying" } as any).eq("id", allot.tenant_id);
  return { success: true };
}

export async function addLifecyclePayment(args: { data: any }) {
  const data = args.data;
  const allots = await safeList(
    supabase.from("tenant_allotments").select("*").eq("id", data.allotmentId).eq("organization_id", ORG_ID).limit(1)
  );
  const allot: any = allots[0];
  if (!allot) throw new Error("Allotment not found");
  const amt = data.amount || 0;
  const ccChargesPayment = Number(data.ccCharges) || 0;
  await insertRow("receipts", {
    tenant_id: allot.tenant_id, tenant_allotment_id: data.allotmentId, amount_paid: amt, base_amount: amt,
    processing_fee: ccChargesPayment, payment_mode: data.paymentMode, reference_number: data.referenceNumber || null,
    payment_date: new Date().toISOString().split("T")[0], receipt_type: "additional_payment",
    ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
  });
  if (ccChargesPayment > 0) {
    await insertRow("tenant_adjustments", {
      tenant_id: allot.tenant_id, allotment_id: data.allotmentId, adjustment_type: "debit_note",
      category: "cc_charges", reason: "CC Charges", amount: Math.ceil(ccChargesPayment),
      adjustment_date: new Date().toISOString().split("T")[0],
    });
  }
  const newPaid = (allot.paid_amount || 0) + amt;
  const newBalance = Math.max(0, (allot.total_due || 0) - newPaid);
  await supabase.from("tenant_allotments").update({
    paid_amount: newPaid, balance_due: newBalance, payment_status: newBalance <= 0 ? "paid" : "partial",
  } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function processSwitchFull(args: { data: any }) {
  const data = args.data;
  const oldRate = data.oldRate || 0;
  const newRate = data.newRate || 0;
  const rentDiff = newRate - oldRate;
  const today = new Date().toISOString().split("T")[0];
  const switchType: "immediate" | "future" = data.switchType === "future" ? "future" : "immediate";
  const switchDateStr = data.switchDate || today;
  const effectiveDateStr = switchType === "future" ? (data.effectiveDate || switchDateStr) : switchDateStr;
  const { data: allotRow } = await supabase.from("tenant_allotments")
    .select("id, apartment_id, onboarding_date").eq("id", data.allotmentId).eq("organization_id", ORG_ID).single();
  const oldAptId = (allotRow as any)?.apartment_id || data.oldApartmentId;
  let ebCharges = 0;
  const switchDate = new Date(switchDateStr);
  const prevMonth = new Date(switchDate.getFullYear(), switchDate.getMonth() - 1, 1);
  const mmmYy = prevMonth.toLocaleString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-");
  const yyyyMm = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}`;
  const { data: ebRows } = await supabase.from("electricity_readings")
    .select("reading_start, reading_end, unit_cost, billing_month").eq("apartment_id", oldAptId);
  const ebReading = (ebRows || []).find((r: any) => r.billing_month === mmmYy || r.billing_month === yyyyMm);
  if (ebReading) {
    const totalUnits = Number(ebReading.reading_end) - Number(ebReading.reading_start);
    const totalBill = totalUnits * Number(ebReading.unit_cost);
    const totalTenantDays = await getTotalTenantDaysInMonthDb(oldAptId, prevMonth);
    const perDay = totalTenantDays > 0 ? totalBill / totalTenantDays : 0;
    const prevMonthStart = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
    const prevMonthEnd = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0);
    const onb = (allotRow as any)?.onboarding_date ? new Date((allotRow as any).onboarding_date) : prevMonthStart;
    const start = onb > prevMonthStart ? onb : prevMonthStart;
    const daysUsed = start > prevMonthEnd ? 0 : Math.max(1, Math.floor((prevMonthEnd.getTime() - start.getTime()) / 86400000) + 1);
    ebCharges = Math.ceil(perDay * daysUsed);
  }
  const depositDifference = await computeSwitchDepositDiff(data.allotmentId, oldRate, newRate, effectiveDateStr);
  const status = switchType === "immediate" ? "completed" : "scheduled";
  const swRow = await insertRow("room_switches", {
    tenant_id: data.tenantId, allotment_id: data.allotmentId, old_allotment_id: data.allotmentId,
    old_bed_id: data.oldBedId, new_bed_id: data.newBedId, old_apartment_id: oldAptId,
    new_apartment_id: data.newApartmentId || null, switch_type: switchType, switch_date: switchDateStr,
    effective_date: effectiveDateStr, rent_difference: rentDiff, deposit_difference: depositDifference,
    eb_charges: ebCharges, old_rent: oldRate, new_rent: newRate, new_property_id: data.newPropertyId || null,
    adjustment_type: rentDiff > 0 ? "tenant_pays" : rentDiff < 0 ? "credit_tenant" : "none",
    status, notes: data.notes || null, completed_at: status === "completed" ? new Date().toISOString() : null,
  });
  const switchId = swRow.id;
  if (switchType === "immediate") {
    await supabase.from("tenant_allotments").update({
      bed_id: data.newBedId, apartment_id: data.newApartmentId || undefined,
      property_id: data.newPropertyId || undefined, monthly_rental: newRate,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
    await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", data.oldBedId);
    await supabase.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", data.newBedId);
    await postSwitchFinancials({
      tenantId: data.tenantId, allotmentId: data.allotmentId, bedId: data.newBedId,
      apartmentId: data.newApartmentId || oldAptId || null, propertyId: data.newPropertyId || null,
      oldRate, newRate, switchDateStr, effectiveDateStr,
      onboardingDate: (allotRow as any)?.onboarding_date || null, switchId, depositDiff: depositDifference,
    });
  } else {
    await supabase.from("tenant_allotments").update({
      staying_status: "On-Notice", notice_date: today, estimated_exit_date: effectiveDateStr,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
    await supabase.from("beds").update({ bed_lifecycle_status: "notice" } as any).eq("id", data.oldBedId);
    await supabase.from("beds").update({ bed_lifecycle_status: "booked" } as any).eq("id", data.newBedId);
  }
  return { success: true, ebCharges, depositDifference, status };
}

export async function completeSwitch(args: { switchId: string }) {
  const { switchId } = args;
  const { data: sw } = await supabase.from("room_switches").select("*").eq("id", switchId).eq("organization_id", ORG_ID).single();
  if (!sw || (sw as any).status !== "scheduled") return { success: false, error: "not scheduled" };
  const s: any = sw;
  const { data: allotRow2 } = await supabase.from("tenant_allotments").select("onboarding_date")
    .eq("id", s.allotment_id).eq("organization_id", ORG_ID).single();
  const oldRate = Number(s.old_rent || 0);
  const newRate = Number(s.new_rent || 0);
  const effDate = s.effective_date || s.switch_date;
  const depositDiff = await computeSwitchDepositDiff(s.allotment_id, oldRate, newRate, effDate);
  await supabase.from("tenant_allotments").update({
    bed_id: s.new_bed_id, apartment_id: s.new_apartment_id || undefined,
    property_id: s.new_property_id || undefined, monthly_rental: newRate,
    staying_status: "Staying", notice_date: null, estimated_exit_date: null,
  } as any).eq("id", s.allotment_id).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", s.old_bed_id);
  await supabase.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", s.new_bed_id);
  await postSwitchFinancials({
    tenantId: s.tenant_id, allotmentId: s.allotment_id, bedId: s.new_bed_id,
    apartmentId: s.new_apartment_id || null, propertyId: s.new_property_id || null,
    oldRate, newRate, switchDateStr: effDate, effectiveDateStr: effDate,
    onboardingDate: (allotRow2 as any)?.onboarding_date || null, switchId, depositDiff,
  });
  await supabase.from("room_switches").update({
    status: "completed", completed_at: new Date().toISOString(), deposit_difference: depositDiff,
  } as any).eq("id", switchId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function cancelSwitch(args: { switchId: string }) {
  const { switchId } = args;
  const { data: sw } = await supabase.from("room_switches").select("*").eq("id", switchId).eq("organization_id", ORG_ID).single();
  if (!sw || (sw as any).status !== "scheduled") return { success: false, error: "not scheduled" };
  const s: any = sw;
  await supabase.from("tenant_allotments").update({
    staying_status: "Staying", notice_date: null, estimated_exit_date: null,
  } as any).eq("id", s.allotment_id).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", s.old_bed_id);
  await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", s.new_bed_id);
  await supabase.from("room_switches").update({ status: "cancelled" } as any).eq("id", switchId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function createNoticeFull(args: { data: any }) {
  const data = args.data;
  const today = new Date().toISOString().split("T")[0];
  await insertRow("tenant_notices", {
    tenant_id: data.tenantId, allotment_id: data.allotmentId, bed_id: data.bedId,
    notice_date: today, exit_date: data.exitDate, notes: data.notes || null,
  });
  await supabase.from("tenant_allotments").update({
    staying_status: "On-Notice", notice_date: today, estimated_exit_date: data.exitDate,
  } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "notice" } as any).eq("id", data.bedId);
  await supabase.from("tenants").update({ staying_status: "on-notice" } as any).eq("id", data.tenantId);
  return { success: true };
}

export async function updateNoticeFull(args: { data: any }) {
  const data = args.data;
  if (data.noticeId) {
    await supabase.from("tenant_notices").update({
      notice_date: data.noticeDate, exit_date: data.exitDate, notes: data.notes || null,
    } as any).eq("id", data.noticeId).eq("organization_id", ORG_ID);
  }
  if (data.allotmentId) {
    await supabase.from("tenant_allotments").update({
      notice_date: data.noticeDate, estimated_exit_date: data.exitDate,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  }
  return { success: true };
}

export async function deleteNoticeFull(args: { noticeId: string; allotmentId: string; bedId: string; tenantId: string }) {
  if (!DELETES_ENABLED) throw new Error("Deleting is currently disabled.");
  const { noticeId, allotmentId, bedId, tenantId } = args;
  await supabase.from("tenant_notices").delete().eq("id", noticeId).eq("organization_id", ORG_ID);
  await supabase.from("tenant_allotments").update({
    staying_status: "Staying", notice_date: null, estimated_exit_date: null,
  } as any).eq("id", allotmentId).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", bedId);
  await supabase.from("tenants").update({ staying_status: "staying" } as any).eq("id", tenantId);
  return { success: true };
}

export async function computeExitMonthEb(args: { allotmentId: string; exitDate: string }) {
  const { allotmentId, exitDate } = args;
  const allotRows = await safeList(
    supabase.from("tenant_allotments").select("id, apartment_id").eq("id", allotmentId).eq("organization_id", ORG_ID),
  );
  const allot: any = (allotRows as any[])[0];
  const empty = { recomputed: 0, invoicedOriginal: 0, estimatedEbIncluded: false, perDayRate: 0, daysInExitMonth: 0, canRecompute: false };
  if (!allot?.apartment_id || !exitDate) return empty;
  const aptId = allot.apartment_id;
  const exitD = new Date(exitDate);
  const exitBillingMonth = String(exitDate).slice(0, 7);
  const [readings, aptAllotments] = await Promise.all([
    safeList(supabase.from("electricity_readings").select("apartment_id, billing_month, reading_start, reading_end, unit_cost").eq("organization_id", ORG_ID)),
    safeList(supabase.from("tenant_allotments").select("apartment_id, onboarding_date, actual_exit_date, staying_status").eq("organization_id", ORG_ID).eq("apartment_id", aptId)),
  ]);
  const breakdown = getExitMonthEbBreakdown(aptId, exitD, readings as any[], aptAllotments as any[]);
  const { included, amount: invoicedOriginal } = await fetchExitMonthEstimatedEb(allotmentId, exitBillingMonth, exitDate);
  const canRecompute = breakdown.perDayRate > 0;
  const recomputed = canRecompute ? Math.max(0, breakdown.estimatedAmount) : invoicedOriginal;
  return {
    recomputed: Math.round(recomputed), invoicedOriginal, estimatedEbIncluded: included,
    perDayRate: breakdown.perDayRate, daysInExitMonth: breakdown.daysInExitMonth, canRecompute,
  };
}

export async function processExitFull(args: { data: any }) {
  const data = args.data;
  const today = data.exitDate || new Date().toISOString().split("T")[0];
  await insertRow("tenant_exits", {
    tenant_id: data.tenantId, allotment_id: data.allotmentId, bed_id: data.bedId, exit_date: today,
    has_notice: data.hasNotice || false, room_inspection: data.roomInspection || false,
    key_returned: data.keyReturned !== false, damage_charges: data.damageCharges || 0,
    key_loss_fee: data.keyLossFee || 0, exit_charges: data.exitCharges || 0, eb_charges: data.ebCharges || 0,
    pending_rent: data.pendingRent || 0, total_deductions: data.totalDeductions || 0,
    advance_held: data.advanceHeld || 0, refund_due: data.refundDue > 0 ? data.refundDue : 0,
    refund_status: data.refundDue > 0 ? "pending" : "none", notes: data.notes || null,
  });
  await supabase.from("tenant_allotments").update({
    staying_status: "Exited", actual_exit_date: today,
  } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", data.bedId);
  const others = await safeList(
    supabase.from("tenant_allotments").select("id").eq("tenant_id", data.tenantId)
      .eq("organization_id", ORG_ID).in("staying_status", ["Booked", "Staying", "On-Notice"]).neq("id", data.allotmentId)
  );
  if (others.length === 0) {
    await supabase.from("tenants").update({ staying_status: "exited" } as any).eq("id", data.tenantId);
  }
  let ebRevision: any = null;
  if (data.reviseEstimatedEb && data.estimatedEbTarget != null) {
    try {
      ebRevision = await reviseExitEbInvoice({
        allotmentId: data.allotmentId, exitBillingMonth: data.exitBillingMonth || String(today).slice(0, 7),
        exitDateIso: today, targetEb: Number(data.estimatedEbTarget) || 0,
      });
    } catch (e: any) {
      console.warn("[processExitFull] EB revision failed:", e?.message);
    }
  }
  return { success: true, ebRevision };
}

export async function updateExitFull(args: { data: any }) {
  const data = args.data;
  await supabase.from("tenant_exits").update({
    exit_date: data.exitDate, has_notice: data.hasNotice, damage_charges: data.damageCharges || 0,
    key_returned: data.keyReturned, key_loss_fee: data.keyLossFee || 0, exit_charges: data.exitCharges || 0,
    total_deductions: data.totalDeductions || 0, refund_due: data.refundDue > 0 ? data.refundDue : 0, notes: data.notes || null,
  } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);
  if (data.allotmentId) {
    await supabase.from("tenant_allotments").update({ actual_exit_date: data.exitDate } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  }
  return { success: true };
}

export async function updateExitRefund(args: { data: any }) {
  const data = args.data;
  const total = (data.pendingRent || 0) + (data.ebCharges || 0) + (data.exitCharges || 0) + (data.damageCharges || 0) + (data.keyLossFee || 0);
  const refundDue = Math.max(0, (data.advanceHeld || 0) - total);
  await supabase.from("tenant_exits").update({
    pending_rent: data.pendingRent || 0, eb_charges: data.ebCharges || 0, exit_charges: data.exitCharges || 0,
    damage_charges: data.damageCharges || 0, key_loss_fee: data.keyLossFee || 0, total_deductions: total, refund_due: refundDue,
  } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function completeRefundFull(args: { data: any }) {
  const data = args.data;
  const exitRows = await safeList(
    supabase.from("tenant_exits").select("*").eq("id", data.exitId).eq("organization_id", ORG_ID).limit(1)
  );
  const exitRec: any = exitRows[0];
  if (!exitRec) throw new Error("Exit record not found");
  await insertRow("deposit_settlements", {
    tenant_id: data.tenantId, allotment_id: data.allotmentId, deposit_amount: exitRec.advance_held || 0,
    pending_rent: exitRec.pending_rent || 0, pending_eb: exitRec.eb_charges || 0, damages: exitRec.damage_charges || 0,
    other_deductions: (exitRec.exit_charges || 0) + (exitRec.key_loss_fee || 0), total_deductions: exitRec.total_deductions || 0,
    refund_amount: exitRec.refund_due || 0, settlement_date: data.refundDate, status: "completed",
    notes: `Refund ref: ${data.referenceNumber}`,
    ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
  });
  await supabase.from("tenant_exits").update({
    refund_status: "completed", refund_date: data.refundDate, refund_reference: data.referenceNumber,
  } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function updateAllotmentDetails(args: { data: any }) {
  const data = args.data;
  await supabase.from("tenant_allotments").update({
    onboarding_date: data.onboardingDate, discount: data.discount || 0,
    premium: data.premium || 0, deposit_paid: data.depositPaid || 0,
  } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function undoOnboardingFull(args: { allotmentId: string }) {
  const { allotmentId } = args;
  const allots = await safeList(
    supabase.from("tenant_allotments").select("*").eq("id", allotmentId).eq("organization_id", ORG_ID).limit(1)
  );
  const allot: any = allots[0];
  if (!allot) throw new Error("Allotment not found");
  if (allot.staying_status !== "Staying") throw new Error("Only Staying tenants can be reverted");
  if (!DELETES_ENABLED) throw new Error("Deleting is currently disabled.");
  await supabase.from("receipts").delete()
    .eq("tenant_allotment_id", allotmentId).eq("receipt_type", "onboarding").eq("organization_id", ORG_ID);
  await supabase.from("tenant_allotments").update({
    staying_status: "Booked", onboarding_date: null, monthly_rental: null, deposit_paid: 0,
    prorated_rent: null, total_due: null, paid_amount: allot.onboarding_charges || 0,
    balance_due: 0, payment_status: "partial",
  } as any).eq("id", allotmentId).eq("organization_id", ORG_ID);
  await supabase.from("beds").update({ bed_lifecycle_status: "booked" } as any).eq("id", allot.bed_id);
  await supabase.from("tenants").update({ staying_status: "booked" } as any).eq("id", allot.tenant_id);
  return { success: true };
}

export async function listRoomSwitches() {
  const switches = await safeList(
    supabase.from("room_switches").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
  );
  const tenants = await safeList(supabase.from("tenants").select("id,full_name").eq("organization_id", ORG_ID));
  const tMap: Record<string, any> = {};
  (tenants as any[]).forEach((t: any) => { tMap[t.id] = t; });
  return (switches as any[]).map((s: any) => ({
    _id: s.id, tenantId: s.tenant_id, tenantName: tMap[s.tenant_id]?.full_name || "Unknown",
    allotmentId: s.allotment_id, oldBedId: s.old_bed_id, newBedId: s.new_bed_id,
    switchType: s.switch_type || "immediate", switchDate: s.switch_date,
    rentDifference: Number(s.rent_difference) || 0, ebCharges: Number(s.eb_charges) || 0,
    depositDifference: Number(s.deposit_difference) || 0, status: s.status || "completed",
    notes: s.notes || "", adjustmentType: s.adjustment_type || "none", createdAt: s.created_at,
  }));
}

export async function createAbsenceRecord(args: { data: any }) {
  const data = args.data;
  return insertRow("tenant_absence_records", {
    tenant_id: data.tenantId, allotment_id: data.allotmentId || null,
    from_date: data.fromDate, to_date: data.toDate, reason: data.reason || null,
  });
}

export async function updateAbsenceRecord(args: { id: string; data: any }) {
  const { id, data } = args;
  await supabase.from("tenant_absence_records").update({
    from_date: data.fromDate, to_date: data.toDate, reason: data.reason || null,
  } as any).eq("id", id).eq("organization_id", ORG_ID);
  return { success: true };
}

export async function deleteAbsenceRecord(args: { id: string }) {
  await deleteRow("tenant_absence_records", args.id);
  return { success: true };
}

export async function getLifecycleFullData() {
  const [allotments, tenants, beds, apartments, properties, exits, notices, bedRates, lifecycleConfigRows, bankAccounts, absenceRecords] = await Promise.all([
    safeList(supabase.from("tenant_allotments").select("*, tenants(full_name,phone,kyc_completed,gender), properties(property_name), apartments(apartment_code,gender_allowed,status), beds(bed_code,bed_type,toilet_type,bed_lifecycle_status)").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
    safeList(supabase.from("tenants").select("*").eq("organization_id", ORG_ID).order("full_name")),
    safeList(supabase.from("beds").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("apartments").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("properties").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("tenant_exits").select("*, tenants(full_name,phone), tenant_allotments(apartment_id, apartments(apartment_code))").eq("organization_id", ORG_ID).eq("is_deleted", false).order("created_at", { ascending: false })),
    safeList(supabase.from("tenant_notices").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
    safeList(supabase.from("bed_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
    safeList(supabase.from("lifecycle_config").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
    safeList(supabase.from("organization_bank_accounts").select("id,bank_name,account_number,ifsc_code,is_primary,status").eq("organization_id", ORG_ID).eq("status", "active").order("is_primary", { ascending: false })),
    safeList(supabase.from("tenant_absence_records").select("*, tenants(full_name, phone)").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
  ]);
  const today = new Date().toISOString().split("T")[0];
  const activeConfig: any = (lifecycleConfigRows as any[]).find((c: any) => c.from_date <= today && (!c.to_date || c.to_date >= today)) || {
    booking_fee: 1000, onboarding_fee: 1000, advance_ratio: 1.5,
    exit_fee_under_1yr: 2250, key_loss_fee: 500, notice_period_days: 30,
    refund_deadline_days: 5, cc_charge_percent: 1.5,
  };
  if (activeConfig.cc_charge_percent == null) activeConfig.cc_charge_percent = 1.5;
  return { allotments, tenants, beds, apartments, properties, exits, notices, bedRates, config: activeConfig, bankAccounts, absenceRecords };
}

// ─── EXIT TASKS (port of convex/tenantsextraactions.ts) ──────────────
export async function listExitTasks() {
  return safeList(
    supabase.from("exit_tasks").select("*, tenants(full_name)").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
  );
}

export async function createExitTask(args: { data: { allotmentId: string; tenantId: string; exitDate: string } }) {
  const data = args.data;
  const { data: orgData } = await supabase.from("organizations")
    .select("exit_task_assignee_1, exit_task_assignee_2").eq("id", ORG_ID).single();
  const org: any = orgData;
  let assignee = org?.exit_task_assignee_1 || null;
  if (org?.exit_task_assignee_1 && org?.exit_task_assignee_2) {
    const { count: a1Tasks } = await supabase.from("exit_tasks")
      .select("id", { count: "exact", head: true })
      .eq("assigned_to", org.exit_task_assignee_1).eq("status", "pending").eq("organization_id", ORG_ID);
    assignee = (a1Tasks || 0) < 3 ? org.exit_task_assignee_1 : org.exit_task_assignee_2;
  }
  const { data: row, error } = await supabase.from("exit_tasks").insert({
    organization_id: ORG_ID, allotment_id: data.allotmentId, tenant_id: data.tenantId,
    exit_date: data.exitDate, assigned_to: assignee || null,
  }).select().single();
  if (error) throw new Error(`Create exit task failed: ${error.message}`);
  return row;
}

// ════════════════════════════════════════════════════════════════════
// EXIT REFUNDS — Collect (negative refund) + Cancel/Reverse a processed exit
// ════════════════════════════════════════════════════════════════════

/**
 * COLLECT PAYMENT for a NEGATIVE exit refund (tenant owes money at exit).
 * Verbatim port of web collectPayment mutation —
 * C:/vishful-web-v7/.../src/pages/TenantLifecycle.tsx lines 4810-4868.
 *
 * Sequence (money-critical, signs identical to web):
 *   1. INSERT receipts (receipt_type = "additional_payment").
 *   2. refund_due moves toward 0: newRefundDue = oldRefundDue(negative) + amt;
 *      status "none" when |new| < 0.01 else "pending"; UPDATE tenant_exits.
 *   3. Sync open deposit_settlements.refund_amount = max(newRefundDue, 0)
 *      (web calls syncOpenDepositSettlementWithExit — inlined here as an UPDATE,
 *       not a delete, so no DELETES_ENABLED gate is needed).
 *   4. Best-effort audit_logs row (web parity; wrapped so it never breaks the money write).
 *
 * `amountOwed` is the SIGNED stored refund_due (negative when the tenant owes),
 * used as web's `oldRefundDue` — no re-read of the exits list.
 */
export async function collectExitPayment(args: {
  data: {
    exitId: string;
    allotmentId: string | null;
    tenantId: string;
    amount: number;
    amountOwed: number; // signed; negative = tenant owes
    paymentMode: string;
    referenceNumber?: string | null;
    bankAccountId?: string | null;
  };
}) {
  const d = args.data;
  const amt = Number(d.amount) || 0;
  if (amt <= 0) throw new Error("Amount must be positive");
  const owed = Number(d.amountOwed) || 0; // negative
  const absOwed = Math.abs(owed);
  if (amt > absOwed + 0.01) throw new Error(`Amount cannot exceed ₹${Math.round(absOwed)}`);
  if (!d.paymentMode) throw new Error("Please select a payment mode");

  // 1. Insert receipt. (Web omits bank_account_id on this insert; mobile stores it
  //    conditionally for parity with its other receipt inserts — not a money change.)
  await insertRow("receipts", {
    tenant_id: d.tenantId,
    tenant_allotment_id: d.allotmentId,
    amount_paid: amt,
    base_amount: amt,
    processing_fee: 0,
    payment_mode: d.paymentMode,
    reference_number: d.referenceNumber || null,
    payment_date: new Date().toISOString().split("T")[0],
    receipt_type: "additional_payment",
    ...(d.bankAccountId ? { bank_account_id: d.bankAccountId } : {}),
  });

  // 2. Recalculate refund_due (old is negative; adding collection moves toward 0).
  const oldRefundDue = owed;
  const newRefundDue = oldRefundDue + amt;
  const newStatus = Math.abs(newRefundDue) < 0.01 ? "none" : "pending";
  await supabase
    .from("tenant_exits")
    .update({
      refund_due: Math.abs(newRefundDue) < 0.01 ? 0 : newRefundDue,
      refund_status: newStatus,
    } as any)
    .eq("id", d.exitId)
    .eq("organization_id", ORG_ID);

  // 3. Keep open deposit_settlements in sync (UPDATE, not delete).
  if (d.allotmentId) {
    await supabase
      .from("deposit_settlements")
      .update({ refund_amount: Math.max(newRefundDue, 0) } as any)
      .eq("allotment_id", d.allotmentId)
      .eq("organization_id", ORG_ID);
  }

  // 4. Audit log (best-effort — web writes one; never block the money write on it).
  try {
    const { data: authData } = await supabase.auth.getUser();
    await supabase.from("audit_logs").insert({
      organization_id: ORG_ID,
      table_name: "tenant_exits",
      record_id: d.exitId,
      action: "COLLECT_PAYMENT",
      performed_by: authData?.user?.id || null,
      old_value: { refund_due: oldRefundDue },
      new_value: { refund_due: newRefundDue, amount_collected: amt, payment_mode: d.paymentMode },
    } as any);
  } catch (e: any) {
    console.warn("[collectExitPayment] audit log skipped:", e?.message);
  }

  return { success: true };
}

/**
 * CANCEL / REVERSE a processed exit — tenant reverts to On-Notice.
 * Port of web cancelExit mutation (bed-not-occupied path) —
 * C:/vishful-web-v7/.../src/pages/TenantLifecycle.tsx lines 4272-4324.
 *
 * Web reversal sequence (simple path):
 *   1. purgeRefundRecordsForAllotment → HARD-delete deposit_settlements (DB trigger
 *      reverses any journal entries those settlement INSERTs posted). This is the
 *      ONLY money-bearing step; tenant_exits itself has no journal trigger.
 *   2. HARD-delete the tenant_exits row.
 *   3. UPDATE tenant_allotments → staying_status "On-Notice", actual_exit_date null.
 *   4. UPDATE beds → "notice-booked" if another Booked allotment holds the bed, else "notice".
 *   5. UPDATE tenants → On-Notice.
 *
 * Mobile adaptation (honours the no-deletes product switch):
 *   • deposit_settlements removal triggers the money reversal, so it must be a real
 *     delete → routed through DELETES_ENABLED. When settlement rows exist and deletes
 *     are disabled, we surface "Deleting is currently disabled." and do NOT touch anything.
 *     (A pending/none refund normally has NO settlements, so the common case proceeds.)
 *   • tenant_exits is removed by VOIDING it (is_deleted = true) instead of hard delete —
 *     getLifecycleFullData() filters is_deleted=false so the row disappears, and there is
 *     no journal side-effect (web comment, same file ~line 4416).
 *   • Occupied-bed case (web opens a deposit-settlement dialog / processOccupiedSettlement)
 *     is NOT ported — blocked with a message pointing to the web app.
 */
export async function cancelExitFull(args: {
  data: { exitId: string; allotmentId: string; bedId: string; tenantId: string; refundStatus?: string };
}) {
  const { exitId, allotmentId, bedId, tenantId } = args.data;
  const refundStatus = args.data.refundStatus || "none";

  // Precondition: refund must still be pending/none (not completed).
  if (refundStatus !== "pending" && refundStatus !== "none") {
    throw new Error("Cannot cancel exit: refund has already been processed.");
  }

  // Bed occupancy / booking state (live from DB, like web's in-memory allotments scan).
  const bedAllots = await safeList(
    supabase.from("tenant_allotments")
      .select("id, staying_status, tenants(full_name)")
      .eq("bed_id", bedId).eq("organization_id", ORG_ID),
  );
  const occupied = (bedAllots as any[]).find(
    (a: any) => a.staying_status === "Staying" && a.id !== allotmentId,
  );
  if (occupied) {
    const who = occupied?.tenants?.full_name || "another tenant";
    throw new Error(
      `This bed is now occupied by ${who}. Settling and reversing an occupied-bed exit is only available in the web app.`,
    );
  }

  // Money reversal (deposit_settlements). Web hard-deletes; mobile gates on DELETES_ENABLED.
  const settlements = await safeList(
    supabase.from("deposit_settlements").select("id").eq("allotment_id", allotmentId).eq("organization_id", ORG_ID),
  );
  if ((settlements as any[]).length > 0) {
    if (!DELETES_ENABLED) throw new Error("Deleting is currently disabled.");
    const { error: delErr } = await supabase
      .from("deposit_settlements").delete().eq("allotment_id", allotmentId).eq("organization_id", ORG_ID);
    if (delErr) throw new Error(`Purge deposit settlements failed: ${delErr.message}`);
  }

  // Remove the exit record by VOIDING it (no hard delete, no journal side-effect).
  await supabase.from("tenant_exits").update({ is_deleted: true } as any).eq("id", exitId).eq("organization_id", ORG_ID);

  // Revert allotment → On-Notice.
  await supabase.from("tenant_allotments")
    .update({ staying_status: "On-Notice", actual_exit_date: null } as any)
    .eq("id", allotmentId).eq("organization_id", ORG_ID);

  // Bed → notice-booked when a Booked allotment holds the bed, else notice.
  const bookedForBed = (bedAllots as any[]).find(
    (a: any) => a.staying_status === "Booked" && a.id !== allotmentId,
  );
  await supabase.from("beds")
    .update({ bed_lifecycle_status: bookedForBed ? "notice-booked" : "notice" } as any)
    .eq("id", bedId);

  // Revert tenant → on-notice (mobile tenants.staying_status convention is lowercase,
  // cf. createNoticeFull; web uses "On-Notice").
  await supabase.from("tenants").update({ staying_status: "on-notice" } as any).eq("id", tenantId);

  return { success: true };
}
