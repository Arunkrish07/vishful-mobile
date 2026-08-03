/**
 * lib/availabilityRecommender.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, synchronous bed-recommendation engine.
 * No network calls — all inputs are passed in from AvailabilityScreen.
 *
 * Exports:
 *   mapBedTypeToBCD(rawType)   →  'B' | 'C' | 'D'
 *   recommendBeds(input)       →  AvailabilityOutput
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** The three bed-category letters used throughout the app */
export type BedTypeBCD = 'B' | 'C' | 'D';

export interface BedInput {
  bedId: string;
  bedCode: string;
  bedType: BedTypeBCD;
  vacant: boolean;
  vacancyDays: number;
  adjacentBeds: string[]; // IDs of neighbouring beds in the same apartment
}

export interface TenantInApartment {
  name: string;
  bedId: string;
  language?: string;
  state?: string;
  jobType: string;
}

export interface ApartmentInput {
  apartmentId: string;
  apartmentCode: string;
  beds: BedInput[];
  tenants: TenantInApartment[];
}

export interface IncomingTenant {
  name: string;
  preferredBedTypes: BedTypeBCD[];
  jobType: string;
  language?: string;
  state?: string;
}

export interface AvailabilityInput {
  tenant: IncomingTenant;
  apartments: ApartmentInput[];
}

export interface Recommendation {
  bedId: string;
  bedCode: string;
  apartmentCode: string;
  rank: number;
  compatibilityScore: number; // 0–100
  reason: string;
  vacancyDays: number;
  matchedState: string;    // 'Unknown' when no match
  matchedLanguage: string; // 'Unknown' when no match
  matchedJobType: string;  // 'Unknown' when no match
}

export interface AvailabilityOutput {
  recommendations: Record<BedTypeBCD, Recommendation[]>;
  inferredStates?: Array<{ state: string; confidence: number }>;
}

// ─── mapBedTypeToBCD ────────────────────────────────────────────────────────

/**
 * Maps a raw database bed-type string to one of the three category letters.
 *
 *  B  →  Single / private / independent bed
 *  C  →  Semi-private / double / twin sharing
 *  D  →  Dormitory / bunk / triple-sharing or above
 */
export function mapBedTypeToBCD(rawType: string | null | undefined): BedTypeBCD {
  if (!rawType) return 'D';
  const t = rawType.trim().toLowerCase();

  // ── Category B — single / private ──────────────────────────────
  if (
    t === 'b' ||
    t.includes('single') ||
    t.includes('private') ||
    t.includes('studio') ||
    t.includes('independent') ||
    t.includes('1-share') ||
    t.includes('one share')
  ) return 'B';

  // ── Category C — double / semi-private ─────────────────────────
  if (
    t === 'c' ||
    t.includes('double') ||
    t.includes('twin') ||
    t.includes('2-share') ||
    t.includes('two share') ||
    t.includes('semi')
  ) return 'C';

  // ── Category D — dormitory / bunk / large sharing ───────────────
  return 'D';
}

// ─── Name → State inference ─────────────────────────────────────────────────

const STATE_NAME_PATTERNS: Array<{ state: string; patterns: RegExp }> = [
  { state: 'Tamil Nadu',    patterns: /kumar|murugan|selvam|arjun|rajan|lakshmi|devi|pillai|nair|chettiar|gounder|nadar|iyengar|iyer|subramani/i },
  { state: 'Kerala',        patterns: /nair|menon|pillai|varma|krishnan|unni|babu|george|thomas|joseph|paul|mathew/i },
  { state: 'Karnataka',     patterns: /gowda|reddy|hegde|naik|rao|swamy|murthy|shetty|kamath|prabhu/i },
  { state: 'Andhra Pradesh',patterns: /reddy|naidu|raju|rao|varma|chowdary|prasad|babu/i },
  { state: 'Maharashtra',   patterns: /patil|desai|kulkarni|joshi|kadam|shinde|more|deshpande|bhosale/i },
  { state: 'Gujarat',       patterns: /patel|shah|mehta|parikh|desai|thakkar|gandhi|jain/i },
  { state: 'Rajasthan',     patterns: /sharma|gupta|jain|singhal|agarwal|maheshwari|pareek|khandelwal/i },
  { state: 'Punjab',        patterns: /singh|kaur|gill|sidhu|dhillon|grewal|brar|sandhu/i },
  { state: 'Bengal',        patterns: /banerjee|chatterjee|mukherjee|ghosh|das|bose|sen|chakraborty/i },
  { state: 'Bihar',         patterns: /kumar|prasad|singh|yadav|mishra|pandey|thakur/i },
];

function inferStatesFromName(name: string): Array<{ state: string; confidence: number }> {
  if (!name) return [];
  const results: Array<{ state: string; confidence: number }> = [];
  const parts = name.trim().split(/\s+/);
  for (const { state, patterns } of STATE_NAME_PATTERNS) {
    const hit = parts.some(p => patterns.test(p));
    if (hit) results.push({ state, confidence: 0.65 });
  }
  // Deduplicate (a name can match multiple, keep highest-confidence)
  return results.slice(0, 2);
}

// ─── Scoring helpers ────────────────────────────────────────────────────────

function normalize(val: string | undefined): string {
  return (val || '').trim().toLowerCase();
}

function softMatch(a: string | undefined, b: string | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Score a single vacant bed against the incoming tenant profile.
 * Returns a score 0–100 and a short reason string.
 */
function scoreBed(
  bed: BedInput,
  apt: ApartmentInput,
  tenant: IncomingTenant,
  inferredStates: Array<{ state: string; confidence: number }>,
): { score: number; reason: string; matchedState: string; matchedLanguage: string; matchedJobType: string } {
  let score = 40; // base score for any vacant bed
  const reasons: string[] = [];
  let matchedState = 'Unknown';
  let matchedLanguage = 'Unknown';
  let matchedJobType = 'Unknown';

  // ── Vacancy freshness bonus (up to +10) ─────────────────────────
  // Prefer beds that have been vacant longer (helps fill stale vacancies)
  const vacancyBonus = Math.min(10, Math.floor(bed.vacancyDays / 7));
  if (vacancyBonus > 0) {
    score += vacancyBonus;
    reasons.push(`Vacant ${bed.vacancyDays}d`);
  }

  // ── Neighbour compatibility scoring ─────────────────────────────
  const adjacentTenants = apt.tenants.filter(t => bed.adjacentBeds.includes(t.bedId));

  for (const neighbour of adjacentTenants) {
    // State match
    const tenantState = tenant.state || inferredStates[0]?.state || '';
    if (tenantState && softMatch(neighbour.state, tenantState)) {
      score += 15;
      matchedState = tenantState;
      reasons.push(`Same state as neighbour`);
      break;
    }
  }

  for (const neighbour of adjacentTenants) {
    // Language match
    if (tenant.language && softMatch(neighbour.language, tenant.language)) {
      score += 12;
      matchedLanguage = tenant.language;
      reasons.push(`Shares language with neighbour`);
      break;
    }
  }

  for (const neighbour of adjacentTenants) {
    // Job-type match
    if (tenant.jobType && softMatch(neighbour.jobType, tenant.jobType)) {
      score += 10;
      matchedJobType = tenant.jobType;
      reasons.push(`Similar profession as neighbour`);
      break;
    }
  }

  // ── Inferred state match against apartment's current tenants ────
  if (matchedState === 'Unknown' && inferredStates.length > 0) {
    const aptTenantStates = apt.tenants.map(t => normalize(t.state));
    for (const { state, confidence } of inferredStates) {
      if (aptTenantStates.some(s => s && s.includes(state.toLowerCase()))) {
        score += Math.round(confidence * 8);
        matchedState = state;
        reasons.push(`Cultural match (inferred: ${state})`);
        break;
      }
    }
  }

  // ── Fewer neighbours = more privacy ─────────────────────────────
  const activeTenantCount = apt.tenants.length;
  if (activeTenantCount === 0) {
    score += 5;
    reasons.push('Apt currently empty');
  } else if (activeTenantCount <= 2) {
    score += 3;
  }

  // ── Cap at 100 ───────────────────────────────────────────────────
  score = Math.min(100, score);

  const reason = reasons.length > 0
    ? reasons.join(' · ')
    : 'Available bed in good standing';

  return { score, reason, matchedState, matchedLanguage, matchedJobType };
}

// ─── Main entry-point ───────────────────────────────────────────────────────

export function recommendBeds(input: AvailabilityInput): AvailabilityOutput {
  const { tenant, apartments } = input;

  const inferredStates = inferStatesFromName(tenant.name);

  // Collect all vacant beds across all apartments
  const candidates: Array<{
    bed: BedInput;
    apt: ApartmentInput;
    score: number;
    reason: string;
    matchedState: string;
    matchedLanguage: string;
    matchedJobType: string;
  }> = [];

  for (const apt of apartments) {
    for (const bed of apt.beds) {
      if (!bed.vacant) continue;
      if (tenant.preferredBedTypes.length > 0 && !tenant.preferredBedTypes.includes(bed.bedType)) continue;

      const { score, reason, matchedState, matchedLanguage, matchedJobType } =
        scoreBed(bed, apt, tenant, inferredStates);

      candidates.push({ bed, apt, score, reason, matchedState, matchedLanguage, matchedJobType });
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  // Group into B / C / D and assign ranks within each group
  const groups: Record<BedTypeBCD, Recommendation[]> = { B: [], C: [], D: [] };

  for (const c of candidates) {
    const group = groups[c.bed.bedType];
    group.push({
      bedId: c.bed.bedId,
      bedCode: c.bed.bedCode,
      apartmentCode: c.apt.apartmentCode,
      rank: group.length + 1,
      compatibilityScore: c.score,
      reason: c.reason,
      vacancyDays: c.bed.vacancyDays,
      matchedState: c.matchedState,
      matchedLanguage: c.matchedLanguage,
      matchedJobType: c.matchedJobType,
    });
  }

  return {
    recommendations: groups,
    inferredStates: inferredStates.length > 0 ? inferredStates : undefined,
  };
}