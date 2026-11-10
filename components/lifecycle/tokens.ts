export const LC = {
  blue: '#2563EB', ink: '#0F172A', muted: '#64748B', pageBg: '#F7F8FA',
  cardBg: '#FFFFFF', cardRadius: 16, cardPad: 14, border: '#EEF1F5',
  green: '#16A34A', greenBg: '#DCFCE7', gray: '#64748B', grayBg: '#F1F5F9',
  orange: '#D97706', orangeBg: '#FEF3C7', red: '#DC2626', redBg: '#FEE2E2',
  cardShadow: {
    shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
} as const;

export const BADGE = {
  completed: { bg: LC.greenBg, fg: LC.green, text: 'Completed' },
  scheduled: { bg: LC.grayBg,  fg: LC.gray,  text: 'Scheduled' },
  cancelled: { bg: LC.grayBg,  fg: LC.gray,  text: 'Cancelled' },
  onNotice:  { bg: LC.orangeBg, fg: LC.orange, text: 'On Notice' },
  pending:   { bg: LC.orangeBg, fg: LC.orange, text: 'Pending' },
} as const;
export type BadgeKind = keyof typeof BADGE;
