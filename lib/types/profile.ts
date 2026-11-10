/**
 * Tenant Profile Types
 * Used across profile fetch, display, and state management
 */

// ── Tenant Core Data ──────────────────────────────────────────────────────────
export interface TenantData {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  gender: string | null;
  permanentAddress: string | null;
  stayingStatus: string | null;
  userId: string | null;
}

// ── Accommodation / Allotment Data ────────────────────────────────────────────
export interface AccommodationData {
  allotmentId: string;
  stayingStatus: string; // 'Staying', 'On-Notice', 'Booked', 'pending'
  apartment: string; // apartment_code or 'Pending' / 'N/A'
  apartmentFloor: string | null;
  bed: string; // bed_code or 'Pending' / 'N/A'
  bedType: string | null;
  onboardingDate: string | null; // ISO date
  noticeDate: string | null; // ISO date
  estimatedExit: string | null; // ISO date
}

// ── Full Profile Response ────────────────────────────────────────────────────
export interface TenantProfileResponse {
  found: boolean;
  status?: 'active' | 'pending' | 'error'; // Optional, inferred from found
  reason?: 'tenant_not_found' | 'allotment_missing' | 'error';
  message?: string; // Human-readable error message
  tenant?: TenantData;
  accommodation?: AccommodationData | null;
}

// ── Errors ────────────────────────────────────────────────────────────────────
export interface ProfileError {
  type: 'not_found' | 'network' | 'pending_setup' | 'unknown';
  message: string;
  retryable: boolean;
  contactManager?: boolean;
}

// ── UI State ──────────────────────────────────────────────────────────────────
export interface ProfileUIState {
  loading: boolean;
  error: ProfileError | null;
  data: TenantProfileResponse | null;
  retryCount: number;
  lastUpdated: number | null; // timestamp
}

// ── Formatting Helpers ────────────────────────────────────────────────────────
export function formatProfileDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  try {
    return new Date(isoDate).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

export function getStayingStatusColor(status: string | null | undefined): {
  bg: string;
  text: string;
} {
  const colors: Record<string, { bg: string; text: string }> = {
    staying: { bg: '#dcfce7', text: '#16a34a' },
    onboarding: { bg: '#dbeafe', text: '#2563eb' },
    'on-notice': { bg: '#ffedd5', text: '#ea580c' },
    new: { bg: '#ede9fe', text: '#7c3aed' },
    exited: { bg: '#f1f5f9', text: '#64748b' },
    booked: { bg: '#fce7f3', text: '#be185d' },
    pending: { bg: '#f3e8ff', text: '#7c3aed' },
  };
  return colors[(status || '').toLowerCase()] ?? { bg: '#ede9fe', text: '#7c3aed' };
}

export function mapProfileError(response: TenantProfileResponse): ProfileError | null {
  if (response.found) return null;

  const type = response.reason === 'tenant_not_found' ? 'not_found' : 'unknown';
  const message = response.message || 'Could not load profile. Please try again.';
  const retryable = type !== 'not_found';

  return {
    type,
    message,
    retryable,
    contactManager: type === 'not_found',
  };
}
