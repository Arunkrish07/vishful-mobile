// lib/ticketSla.ts — working-hours SLA deadline calc (client port of the
// helpers in convex/tickets.ts). Pure functions, no backend deps.
// Working hours: 9:30 AM – 5:30 PM IST (8h/day). SLA counts only working minutes.
const WORK_START_HOUR = 9;
const WORK_START_MINUTE = 30;
const WORK_END_HOUR = 17;
const WORK_END_MINUTE = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WORK_START_MINS = WORK_START_HOUR * 60 + WORK_START_MINUTE;
const WORK_END_MINS = WORK_END_HOUR * 60 + WORK_END_MINUTE;

function toISTMinutes(date: Date): number {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

function nextWorkStart(from: Date): Date {
  const istDate = new Date(from.getTime() + IST_OFFSET_MS);
  const minsNow = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
  if (minsNow < WORK_START_MINS) {
    istDate.setUTCHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
  } else {
    istDate.setUTCDate(istDate.getUTCDate() + 1);
    istDate.setUTCHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
  }
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}

export function calcWorkingHoursSlaDeadline(from: Date, slaHours: number): Date {
  const minsNow = toISTMinutes(from);
  const inWindow = minsNow >= WORK_START_MINS && minsNow < WORK_END_MINS;
  let cursor = inWindow ? new Date(from) : nextWorkStart(from);
  let remainingMs = slaHours * 3600000;
  while (remainingMs > 0) {
    const cursorIst = new Date(cursor.getTime() + IST_OFFSET_MS);
    const endIst = new Date(cursorIst);
    endIst.setUTCHours(WORK_END_HOUR, WORK_END_MINUTE, 0, 0);
    const endUtc = new Date(endIst.getTime() - IST_OFFSET_MS);
    const windowMs = endUtc.getTime() - cursor.getTime();
    if (remainingMs <= windowMs) {
      cursor = new Date(cursor.getTime() + remainingMs);
      remainingMs = 0;
    } else {
      remainingMs -= windowMs;
      cursor = nextWorkStart(endUtc);
    }
  }
  return cursor;
}
