/**
 * Shared ticket ↔ allocated-asset resolution (create-ticket flow).
 *
 * Ported verbatim from the web app's `src/lib/ticket-asset-resolution.ts`
 * (Vishful Living) so mobile ranks candidate assets identically. The web
 * source is the canonical contract — keep the scoring/suggestion logic in
 * sync with it.
 *
 * Mobile note: our issue types do not carry the `issue_type_asset_types`
 * junction (the backend `getIssueTypes` returns plain rows), so
 * `hasTypeLinks` is always false here and the resolver falls back to
 * semantic ranking over the location's active allocated assets — exactly
 * the path the web app uses for issue types with no linked asset types.
 */

export function normalizeTicketIssueText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

export function getTicketLinkedAssetTypeNameOverlap(description: string, issueType: any, asset: any) {
  const text = normalizeTicketIssueText(description);
  const assetTypeNorm = normalizeTicketIssueText(asset?.asset_types?.name || '');
  let s = 0;
  const names = (issueType?.issue_type_asset_types || [])
    .map((l: any) => l.asset_types?.name)
    .filter(Boolean) as string[];
  for (const nm of names) {
    const nt = normalizeTicketIssueText(nm);
    if (nt.length >= 3 && text.includes(nt)) s += 3;
    nt.split(/\s+/)
      .filter((w) => w.length >= 3)
      .forEach((w) => {
        if (text.includes(w)) s += 1;
      });
    if (nt && assetTypeNorm && (nt === assetTypeNorm || assetTypeNorm.includes(nt) || nt.includes(assetTypeNorm)))
      s += 4;
  }
  return s;
}

export function getTicketAssetMatchScore(asset: any, description: string) {
  const text = normalizeTicketIssueText(description);
  const assetTypeName = normalizeTicketIssueText(asset?.asset_types?.name || '');
  const tokens = assetTypeName.split(/\s+/).filter((t) => t.length >= 3);

  const synonymMap: Record<string, string[]> = {
    bed: ['cot', 'bunk', 'diwan', 'bed', 'mattress', 'pillow', 'bedsheet'],
    wardrobe: ['almirah', 'godrej', 'wardrobe', 'cupboard', 'closet'],
    chair: ['chair', 'stool', 'seating'],
    table: ['table', 'desk', 'study'],
    sofa: ['sofa', 'couch', 'settee'],
    fan: ['fan'],
    light: ['light', 'bulb', 'tube', 'led', 'cfl'],
    geyser: ['geyser', 'water heater'],
    furniture: [
      'drawer',
      'hinge',
      'wardrobe',
      'almirah',
      'cupboard',
      'closet',
      'shelf',
      'rack',
      'wobble',
      'squeak',
      'squeaking',
      'loose',
      'broken',
      'torn',
      'bent',
      'cracked',
      'collapsed',
      'stuck',
      'furniture',
      'furnishing',
      'woodwork',
      'interior',
    ],
  };

  let score = 0;
  if (assetTypeName && text.includes(assetTypeName)) score += 6;

  tokens.forEach((tok) => {
    if (text.includes(tok)) score += 1;
  });

  Object.entries(synonymMap).forEach(([key, synonyms]) => {
    const keyMatchesType =
      assetTypeName.includes(key) ||
      (key === 'furniture' &&
        /\b(furniture|furnish|wood|interior|wardrobe|chair|sofa|table|desk|almirah|cupboard)\b/.test(assetTypeName));
    if (!keyMatchesType) return;
    synonyms.forEach((s) => {
      const ns = normalizeTicketIssueText(s);
      if (ns.length >= 2 && text.includes(ns)) score += 4;
    });
  });

  const isHvacType =
    /\b(hvac|air[\s-]?condition|cooling|split|compressor|condenser|heat\s?pump)\b/.test(assetTypeName) ||
    (assetTypeName.includes('air') && assetTypeName.includes('condition')) ||
    /\bac\b/.test(` ${assetTypeName} `);
  const hvacCues =
    /\b(ac|a\s*c|air[\s-]?con|aircon|air[\s-]?condition|split|window[\s-]?ac|hvac|cooling|not[\s-]?cool|not[\s-]?cold|gas[\s-]?refill|compressor|condenser|leak|drip|ice|freeze)\b/.test(
      text,
    );
  if (isHvacType && hvacCues) score += 8;
  if (isHvacType && (text.includes(' ac ') || text.endsWith(' ac') || text.startsWith('ac '))) score += 5;

  if (asset?.brand && text.includes(normalizeTicketIssueText(asset.brand))) score += 2;
  if (asset?.model && text.includes(normalizeTicketIssueText(asset.model))) score += 2;
  if (asset?.asset_code && text.includes(normalizeTicketIssueText(String(asset.asset_code)))) score += 2;
  if (asset?.serial_number && text.includes(normalizeTicketIssueText(String(asset.serial_number)))) score += 2;

  return score;
}

export type TicketAssetSuggestionInput = {
  apartmentId: string;
  bedId: string;
  propertyId: string;
  issueTypeId: string;
  description: string;
  issueTypes: any[];
  assetAllocations: any[];
  /** When ticket has no specific bed, include all bed IDs in this apartment so bed-level allocations match. */
  apartmentBedIds?: string[];
};

export function allocType(a: any): string {
  return String(a?.allocation_type || '').toLowerCase();
}

/**
 * Assets allocated to bed → apartment → property for an issue type.
 * Uses issue_type_asset_types when configured; otherwise ranks using issue name + description.
 */
export function computeTicketAssetSuggestion(input: TicketAssetSuggestionInput): {
  candidates: any[];
  suggestedId: string | null;
} {
  const { apartmentId, bedId, propertyId, issueTypeId, description, issueTypes, assetAllocations, apartmentBedIds } =
    input;
  if (!apartmentId || !issueTypeId) return { candidates: [], suggestedId: null };

  const issueType = (issueTypes as any[]).find((it) => it.id === issueTypeId);
  const linkedAssetTypeIds: Set<string> = new Set(
    (issueType?.issue_type_asset_types || []).flatMap((l: any) => {
      const id = l?.asset_type_id ?? l?.asset_types?.id;
      return id ? [String(id)] : [];
    }),
  );
  const hasTypeLinks = linkedAssetTypeIds.size > 0;

  const allAllocs = assetAllocations as any[];
  const getAsset = (alloc: any) => alloc.assets || null;

  const INACTIVE_STATUSES = new Set(['retired', 'inactive', 'disposed']);
  const isAssetActive = (asset: any) => asset && !INACTIVE_STATUSES.has(String(asset.status || '').toLowerCase());

  const typeMatches = (alloc: any) => {
    const asset = getAsset(alloc);
    if (!isAssetActive(asset)) return false;
    if (!hasTypeLinks) return true;
    const at = asset?.asset_type_id != null ? String(asset.asset_type_id) : '';
    return !!at && linkedAssetTypeIds.has(at);
  };

  let candidates: any[] = [];

  const bedScopeIds: string[] = [];
  if (bedId && bedId !== '__none') {
    bedScopeIds.push(String(bedId));
  } else {
    bedScopeIds.push(...(apartmentBedIds || []).map(String).filter(Boolean));
  }

  if (bedScopeIds.length > 0) {
    const bedSet = new Set(bedScopeIds);
    const bedAllocs = allAllocs.filter(
      (a) => allocType(a) === 'bed' && a.bed_id != null && bedSet.has(String(a.bed_id)) && typeMatches(a),
    );
    candidates = bedAllocs.map(getAsset).filter(Boolean);
  }

  if (candidates.length === 0) {
    const aptAllocs = allAllocs.filter(
      (a) => allocType(a) === 'apartment' && String(a.apartment_id || '') === String(apartmentId) && typeMatches(a),
    );
    candidates = aptAllocs.map(getAsset).filter(Boolean);
  }

  if (candidates.length === 0 && propertyId) {
    const propAllocs = allAllocs.filter(
      (a) => allocType(a) === 'property' && String(a.property_id || '') === String(propertyId) && typeMatches(a),
    );
    candidates = propAllocs.map(getAsset).filter(Boolean);
  }

  const seen = new Set<string>();
  candidates = candidates.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  const textBlob = [issueType?.name, description].filter(Boolean).join(' ').trim();

  const ranked = candidates
    .map((asset) => ({
      asset,
      score: getTicketAssetMatchScore(asset, textBlob),
      secondary: issueType ? getTicketLinkedAssetTypeNameOverlap(textBlob, issueType, asset) : 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.secondary !== a.secondary) return b.secondary - a.secondary;
      return new Date(b.asset.created_at || 0).getTime() - new Date(a.asset.created_at || 0).getTime();
    });

  if (ranked.length === 0) return { candidates: [], suggestedId: null };

  const best = ranked[0].asset;
  const bestScore = ranked[0].score;
  const bestSecondary = ranked[0].secondary;
  const nextScore = ranked[1]?.score ?? -1;
  const nextSecondary = ranked[1]?.secondary ?? -1;
  candidates = ranked.map((r) => r.asset);

  const clearWinner =
    candidates.length === 1 ||
    (best &&
      (bestScore > nextScore ||
        (bestScore === nextScore && (bestSecondary > nextSecondary || (bestScore > 0 && bestSecondary > 0)))));

  const distinctAssetTypes = new Set(candidates.map((c) => c.asset_type_id).filter(Boolean));
  const singleLinkedAssetTypeInRoom =
    hasTypeLinks && distinctAssetTypes.size === 1 && candidates.length >= 1 && !!best;

  const semanticPick =
    !hasTypeLinks && !!best && (bestScore > 0 || bestSecondary > 0) && (!ranked[1] || bestScore > nextScore);

  let suggestedId: string | null = null;
  if (clearWinner || singleLinkedAssetTypeInRoom || semanticPick) suggestedId = best.id;

  return { candidates, suggestedId };
}

/**
 * Human label for a candidate asset in the picker.
 * Ported from the web app's `formatTicketAssetLabel` (src/lib/format-utils.ts).
 */
export function formatTicketAssetLabel(asset: {
  asset_code?: string | null;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  notes?: string | null;
  asset_types?: { name?: string | null } | null;
} | null | undefined): string {
  if (!asset) return '';

  const typeName = asset.asset_types?.name?.trim() || '';

  let middle = '';
  if (asset.brand && asset.brand.trim()) {
    middle = asset.brand.trim();
  } else if (asset.model && asset.model.trim()) {
    middle = asset.model.trim();
  } else {
    const fallback = (asset.description || asset.notes || '').trim();
    if (fallback) {
      middle = fallback.length > 30 ? fallback.slice(0, 30).trimEnd() + '…' : fallback;
    }
  }

  const code = asset.asset_code?.trim() || '';

  return [typeName, middle, code].filter(Boolean).join(' - ');
}
