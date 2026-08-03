// ─── Types ────────────────────────────────────────────────────────────────────

export type BedTypeBCD = "B" | "C" | "D";

export type MatchType =
  | "PERFECT_LANGUAGE_ROOM_MATCH"
  | "LANGUAGE_APARTMENT_MATCH"
  | "SAME_STATE_MATCH"
  | "COMPANY_MATCH"
  | "PROFESSION_MATCH"
  | "MIXED_COMPATIBILITY_MATCH"
  | "NO_MATCH";

export type AvailabilityTenantInput = {
  name: string;
  preferredBedTypes: BedTypeBCD[];
  jobType: string;
  language?: string;
  state?: string;
  company_name?: string;
  industry?: string;
};

export type AvailabilityApartmentInput = {
  apartmentId: string;
  beds: {
    bedId: string;
    bedCode: string;
    bedType: BedTypeBCD;
    vacant: boolean;
    vacancyDays: number;
    adjacentBeds: string[];
  }[];
  tenants: {
    name: string;
    bedId: string;
    language?: string;
    state?: string;
    jobType?: string;
    company_name?: string;
    designation?: string;
  }[];
};

export type AvailabilityInput = {
  tenant: AvailabilityTenantInput;
  apartments: AvailabilityApartmentInput[];
};

export type InferredState = { state: string; confidence: number };

export type Recommendation = {
  rank: number;
  bedId: string;
  bedCode: string;
  apartmentId: string;
  vacancyDays: number;
  compatibilityScore: number;
  matchType: MatchType;
  matchedState: string;
  matchedLanguage: string;
  matchedProfession: string;
  adjacentTenantNames: string[];
  confidence: "High" | "Medium" | "Low";
  reason: string;
};

export type AvailabilityOutput = {
  inferredStates?: InferredState[];
  recommendations: Record<BedTypeBCD, Recommendation[]>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_TO_LANGUAGE: Record<string, string> = {
  "Tamil Nadu": "Tamil",
  Kerala: "Malayalam",
  Karnataka: "Kannada",
  "Andhra Pradesh": "Telugu",
  Telangana: "Telugu",
  Maharashtra: "Marathi",
  Gujarat: "Gujarati",
  "West Bengal": "Bengali",
  Punjab: "Punjabi",
  Rajasthan: "Hindi",
  Delhi: "Hindi",
  "Uttar Pradesh": "Hindi",
  Bihar: "Hindi",
  Odisha: "Odia",
};

const NEIGHBORING_STATES: Record<string, Set<string>> = {
  "Tamil Nadu": new Set(["Kerala", "Karnataka", "Andhra Pradesh", "Telangana"]),
  Kerala: new Set(["Tamil Nadu", "Karnataka"]),
  Karnataka: new Set(["Tamil Nadu", "Kerala", "Andhra Pradesh", "Telangana", "Maharashtra"]),
  "Andhra Pradesh": new Set(["Tamil Nadu", "Karnataka", "Telangana", "Odisha"]),
  Telangana: new Set(["Karnataka", "Andhra Pradesh", "Maharashtra"]),
  Maharashtra: new Set(["Karnataka", "Gujarat", "Telangana"]),
};

// Practical max raw score for realistic scenarios (language+state+profession+social+vacancy)
const SCORE_DENOMINATOR = 130;

const SIMILAR_INDUSTRIES = new Set([
  "tech|corporate", "corporate|tech",
  "student|education", "education|student",
  "bpo|corporate", "corporate|bpo",
  "finance|corporate", "corporate|finance",
  "bpo|tech", "tech|bpo",
]);

// ─── Utilities ────────────────────────────────────────────────────────────────

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

function lower(s: unknown): string {
  return norm(s).toLowerCase();
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function inferLanguageFromState(state: string | undefined): string | undefined {
  const s = norm(state);
  return s ? STATE_TO_LANGUAGE[s] : undefined;
}

function inferStatesFromName(name: string): InferredState[] {
  const n = lower(name);
  if (!n) return [];

  const hits: InferredState[] = [];
  if (/(selvan|selvi|rajan|raj|murugan|vel|sundar|arul|ramesh|ganesh|vignesh|karthik)/.test(n))
    hits.push({ state: "Tamil Nadu", confidence: 0.55 });
  if (/(nair|menon|pillai|kurup|varma|unni)/.test(n))
    hits.push({ state: "Kerala", confidence: 0.55 });
  if (/(gowda|shetty|hegde|nayak)/.test(n))
    hits.push({ state: "Karnataka", confidence: 0.5 });
  if (/(reddy|naidu|rao|teja)/.test(n)) {
    hits.push({ state: "Andhra Pradesh", confidence: 0.5 });
    hits.push({ state: "Telangana", confidence: 0.35 });
  }
  if (/(singh|verma|sharma|gupta|yadav)/.test(n)) {
    hits.push({ state: "Uttar Pradesh", confidence: 0.25 });
    hits.push({ state: "Bihar", confidence: 0.2 });
    hits.push({ state: "Delhi", confidence: 0.15 });
  }

  const m = new Map<string, number>();
  for (const h of hits) m.set(h.state, Math.max(m.get(h.state) ?? 0, h.confidence));
  const merged = [...m.entries()].map(([state, confidence]) => ({ state, confidence }));
  const sum = merged.reduce((s, x) => s + x.confidence, 0);
  if (sum > 1) return merged.map(x => ({ ...x, confidence: x.confidence / sum })).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  return merged.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

function companyMatch(a?: string, b?: string): boolean {
  const A = lower(a);
  const B = lower(b);
  return !!A && !!B && A === B;
}

function jobCategory(job: string | undefined): string {
  const j = lower(job);
  if (!j) return "unknown";
  if (/(software|developer|engineer|it\b|programmer|qa\b|tester|devops|tech)/.test(j)) return "tech";
  if (/(nurse|doctor|medical|hospital|pharma|health)/.test(j)) return "healthcare";
  if (/(teacher|professor|tutor|faculty|education)/.test(j)) return "education";
  if (/(account|finance|audit|bank|ca\b|cfa\b)/.test(j)) return "finance";
  if (/(sales|marketing|business|bd\b|hr\b|management)/.test(j)) return "corporate";
  if (/(student|intern|trainee)/.test(j)) return "student";
  if (/(driver|delivery|logistics|warehouse)/.test(j)) return "operations";
  if (/(bpo|call.?cent|customer.?care|support)/.test(j)) return "bpo";
  return "other";
}

function areSimilarIndustries(a: string, b: string): boolean {
  return SIMILAR_INDUSTRIES.has(`${a}|${b}`);
}

function tenantLang(t: { language?: string; state?: string }): string {
  return norm(t.language) || inferLanguageFromState(norm(t.state)) || "";
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

interface ScoredBed {
  raw: number;
  compatibilityScore: number;
  matchType: MatchType;
  confidence: "High" | "Medium" | "Low";
  matchedState: string;
  matchedLanguage: string;
  matchedProfession: string;
  adjacentTenantNames: string[];
  reason: string;
  bedId: string;
  bedCode: string;
  bedType: BedTypeBCD;
  vacancyDays: number;
  apartmentId: string;
}

function scoreBed(
  tenant: AvailabilityTenantInput,
  tenantState: string,
  tenantLanguage: string,
  apt: AvailabilityApartmentInput,
  bed: AvailabilityApartmentInput["beds"][number],
  preferred: BedTypeBCD[],
): ScoredBed {
  let raw = 0;
  const aptTenants = apt.tenants ?? [];
  const adjacentPool = aptTenants.filter(t => bed.adjacentBeds.includes(t.bedId));

  let adjacentLanguageMatch = false;
  let aptLanguageMatch = false;
  let stateMatch = false;
  let hadCompanyMatch = false;
  let professionMatch = false;
  let industryMatch = false;

  let matchedState = "";
  let matchedLanguage = "";
  let matchedProfession = "";
  const adjacentTenantNames: string[] = [];
  const reasonParts: string[] = [];

  for (const t of adjacentPool) {
    if (t.name) adjacentTenantNames.push(t.name);
  }

  // ── +50: adjacent same-language
  if (tenantLanguage) {
    for (const t of adjacentPool) {
      const tl = tenantLang(t);
      if (tl && tl === tenantLanguage) {
        adjacentLanguageMatch = true;
        raw += 50;
        matchedLanguage = tl;
        break;
      }
    }
  }

  // ── +35: apartment same-language (not adjacent)
  if (!adjacentLanguageMatch && tenantLanguage) {
    for (const t of aptTenants) {
      const tl = tenantLang(t);
      if (tl && tl === tenantLanguage) {
        aptLanguageMatch = true;
        raw += 35;
        matchedLanguage = tl;
        break;
      }
    }
  }

  // ── +20: same state
  if (tenantState) {
    for (const t of aptTenants) {
      const ts = norm(t.state);
      if (ts && ts === tenantState) {
        stateMatch = true;
        raw += 20;
        matchedState = ts;
        if (!matchedLanguage) matchedLanguage = inferLanguageFromState(tenantState) ?? "";
        break;
      }
    }
  }

  // ── +30: same company
  if (tenant.company_name) {
    for (const t of aptTenants) {
      if (companyMatch(tenant.company_name, t.company_name)) {
        hadCompanyMatch = true;
        raw += 30;
        break;
      }
    }
  }

  // ── +20 / +10: profession / industry
  const tenantCat = jobCategory(tenant.jobType);
  for (const t of aptTenants) {
    const tCat = jobCategory(t.jobType ?? t.designation);
    if (tenantCat !== "unknown" && tCat !== "unknown") {
      if (!professionMatch && tenantCat === tCat) {
        professionMatch = true;
        raw += 20;
        matchedProfession = tenantCat;
      } else if (!industryMatch && !professionMatch && areSimilarIndustries(tenantCat, tCat)) {
        industryMatch = true;
        raw += 10;
        matchedProfession = `${tenantCat}/${tCat}`;
      }
    }
  }

  // ── +15: social balance (≥2 existing tenants)
  if (aptTenants.length >= 2) raw += 15;

  // ── +5: recently vacant (≤30 days)
  if (bed.vacancyDays <= 30) raw += 5;

  // ── +10: preferred bed type
  if (preferred.includes(bed.bedType)) raw += 10;

  // ── Normalize 0-100
  const compatibilityScore = Math.min(100, Math.round(clamp01(raw / SCORE_DENOMINATOR) * 100));

  // ── Match type (priority order)
  let matchType: MatchType;
  if (adjacentLanguageMatch)        matchType = "PERFECT_LANGUAGE_ROOM_MATCH";
  else if (aptLanguageMatch)        matchType = "LANGUAGE_APARTMENT_MATCH";
  else if (stateMatch)              matchType = "SAME_STATE_MATCH";
  else if (hadCompanyMatch)         matchType = "COMPANY_MATCH";
  else if (professionMatch)         matchType = "PROFESSION_MATCH";
  else if (compatibilityScore >= 40) matchType = "MIXED_COMPATIBILITY_MATCH";
  else                              matchType = "NO_MATCH";

  // ── Confidence
  const confidence: "High" | "Medium" | "Low" =
    compatibilityScore >= 70 ? "High" : compatibilityScore >= 40 ? "Medium" : "Low";

  // ── Human-readable reason
  if (adjacentLanguageMatch && adjacentTenantNames.length > 0) {
    const names = adjacentTenantNames.join(", ");
    reasonParts.push(`Adjacent tenant${adjacentTenantNames.length > 1 ? "s" : ""} ${names} speak${adjacentTenantNames.length === 1 ? "s" : ""} ${matchedLanguage} — perfect room match`);
  } else if (aptLanguageMatch && matchedLanguage) {
    reasonParts.push(`Apartment has ${matchedLanguage}-speaking tenants`);
  }
  if (stateMatch && matchedState) reasonParts.push(`same state (${matchedState})`);
  if (hadCompanyMatch) reasonParts.push(`same company (${tenant.company_name})`);
  if (professionMatch && matchedProfession) reasonParts.push(`same profession (${matchedProfession})`);
  else if (industryMatch && matchedProfession) reasonParts.push(`similar industry (${matchedProfession.replace("/", " & ")})`);
  if (bed.vacancyDays <= 30 && reasonParts.length > 0) reasonParts.push(`recently vacated (${bed.vacancyDays}d)`);
  else if (reasonParts.length === 0) reasonParts.push(`vacant ${bed.vacancyDays} days, no strong compatibility signals`);

  const resolvedProfession = matchedProfession || (tenantCat !== "unknown" ? tenantCat : "Unknown");

  return {
    raw,
    compatibilityScore,
    matchType,
    confidence,
    matchedState: matchedState || tenantState || "Unknown",
    matchedLanguage: matchedLanguage || tenantLanguage || "Unknown",
    matchedProfession: resolvedProfession,
    adjacentTenantNames,
    reason: reasonParts.join(". ") + ".",
    bedId: bed.bedId,
    bedCode: bed.bedCode,
    bedType: bed.bedType,
    vacancyDays: bed.vacancyDays,
    apartmentId: apt.apartmentId,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function recommendBeds(input: AvailabilityInput): AvailabilityOutput {
  const tenant = input.tenant;
  const preferred = (tenant.preferredBedTypes ?? []).filter(Boolean) as BedTypeBCD[];

  const inferredStates =
    !tenant.state || !norm(tenant.state)
      ? inferStatesFromName(tenant.name)
      : [{ state: tenant.state, confidence: 1 }];

  const bestInferredState = inferredStates[0]?.state ?? "";
  const tenantState = norm(tenant.state) || bestInferredState;
  const tenantLanguage = norm(tenant.language) || inferLanguageFromState(tenantState) || "";

  const out: AvailabilityOutput = {
    ...(inferredStates.length && (!tenant.state || !norm(tenant.state)) ? { inferredStates } : {}),
    recommendations: { B: [], C: [], D: [] },
  };

  for (const bedType of preferred) {
    const candidates: ScoredBed[] = [];

    for (const apt of input.apartments) {
      const vacantOfType = apt.beds.filter(b => b.vacant && b.bedType === bedType);
      if (vacantOfType.length === 0) continue;

      for (const bed of vacantOfType) {
        candidates.push(scoreBed(tenant, tenantState, tenantLanguage, apt, bed, preferred));
      }
    }

    out.recommendations[bedType] = candidates
      .sort((a, b) =>
        b.compatibilityScore !== a.compatibilityScore ? b.compatibilityScore - a.compatibilityScore
          : b.raw !== a.raw ? b.raw - a.raw
          : b.vacancyDays - a.vacancyDays,
      )
      .slice(0, 3)
      .map((s, idx): Recommendation => ({
        rank: idx + 1,
        bedId: s.bedId,
        bedCode: s.bedCode,
        apartmentId: s.apartmentId,
        vacancyDays: s.vacancyDays,
        compatibilityScore: s.compatibilityScore,
        matchType: s.matchType,
        matchedState: s.matchedState,
        matchedLanguage: s.matchedLanguage,
        matchedProfession: s.matchedProfession,
        adjacentTenantNames: s.adjacentTenantNames,
        confidence: s.confidence,
        reason: s.reason,
      }));
  }

  for (const t of ["B", "C", "D"] as BedTypeBCD[]) {
    out.recommendations[t] ??= [];
  }

  return out;
}