import { Timestamp } from 'firebase/firestore';

export type TrackingRating = 'UNTRACKED' | 'WT' | 'PA' | 'A' | 'M' | 'NA';

export type InviteStatus = 'INVITED' | 'ACTIVE';

export type UserRole = 'STAFF' | 'ADMIN';

export type NotificationType =
  | 'INVITATION'
  | 'PENDING_ASSIGNMENT'
  | 'APPROACHING_DEADLINE'
  | 'ADMIN_REMINDER';

export const OWNER_ADMIN_EMAILS = [
  'j.alimajen_wis@gemswis.com',
  'buxkillian@gmail.com',
];

export function isOwnerAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (
    OWNER_ADMIN_EMAILS.includes(normalized) ||
    normalized === 'j.alimajen_wis@gemswis.com' ||
    normalized === 'buxkillian@gmail.com'
  );
}

export interface StaffMember {
  id: string;
  adminUid: string;
  name: string;
  email: string;
  department: string;
  role: UserRole;
  inviteStatus: InviteStatus;
  pin?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export function generateRandomStaffPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function isValidStaffPin(pin?: string | null): boolean {
  return typeof pin === 'string' && /^\d{4}$/.test(pin.trim());
}

export interface Student {
  id: string;
  adminUid: string;
  name: string;
  yearGroup: string;
  studentCode: string;
  mentorName?: string;
  subjects: string[];
  assignedStaffEmails: string[];
  remarks?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export function formatStudentYearAndGroup(student: Student): string {
  const yg = (student.yearGroup || 'Year 10').trim();
  if (yg.toLowerCase().includes('group')) {
    return yg;
  }
  if (student.id.includes('maya')) return `${yg} · Group B`;
  if (student.id.includes('amara')) return `${yg} · Group C`;
  return `${yg} · Group A`;
}

export function getStudentMentorName(student: Student): string {
  if (student.mentorName && student.mentorName.trim()) {
    return student.mentorName.trim();
  }
  if (student.id.includes('maya')) return 'Mr. Arthur Pendelton';
  if (student.id.includes('amara')) return 'Dr. Julian Thorne';
  return 'Ms. Eleanor Vance';
}

export type TargetFontColor = 'black' | 'red' | 'blue';

export function normalizeTargetFontColor(color?: string | null): TargetFontColor {
  if (color === 'red' || color === 'blue' || color === 'black') return color;
  return 'black';
}

export function getTargetFontColorClass(
  color?: string | null,
  isApplicable = true
): string {
  if (!isApplicable) return 'text-slate-400';
  switch (color) {
    case 'red':
      return 'text-red-600';
    case 'blue':
      return 'text-blue-600';
    default:
      return 'text-slate-900';
  }
}

export function getTargetFontColorRgb(
  color?: string | null
): [number, number, number] {
  switch (color) {
    case 'red':
      return [220, 38, 38];
    case 'blue':
      return [37, 99, 235];
    default:
      return [15, 23, 42];
  }
}

export interface Target {
  id: string;
  adminUid: string;
  studentId: string;
  studentName: string;
  subject: string;
  targetGroupId?: string;
  heading?: string;
  title: string;
  challenge?: string;
  suggestedStrategies?: string;
  internalNote?: string;
  fontColor?: TargetFontColor;
  trackingRequired: boolean;
  assignedStaffEmail: string;
  assignedStaffName: string;
  subjectStaffEmail: string;
  teacherName?: string;
  teacherEmail?: string;
  lsaName?: string;
  lsaEmail?: string;
  term?: string; // ALL CAPS, e.g. "TERM 1", "TERM 2", "TERM 3"
  currentWeekStatus: TrackingRating;
  currentWeekKey: string;
  progressScore: number;
  weeklyHistorySummary: string;
  lastTrackedByEmail: string;
  deadlineDate: string;
  notes: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}
export const DEFAULT_SUBJECT_TEACHERS: Record<string, string> = {
  Mathematics: 'Mrs. Gable',
  'Further Mathematics': 'Mr. Vance',
  English: 'Mr. Foster',
  Science: 'Dr. Aris',
  Robotics: 'Mr. Zhao',
  Geography: 'Mrs. Stone',
  History: 'Mr. Henderson',
  Art: 'Ms. Rivera',
  Music: 'Mr. Bradley',
  PE: 'Coach Jenkins',
  French: 'Mme. Dupont',
  Spanish: 'Sr. Morales',
  Computer: 'Mr. Turing',
  Computing: 'Mr. Turing',
};

export interface NotificationItem {
  id: string;
  adminUid: string;
  recipientEmail: string;
  recipientName: string;
  type: NotificationType;
  title: string;
  message: string;
  studentId: string;
  studentName: string;
  subject: string;
  dueDate: string;
  isRead: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface WeekScheduleInfo {
  weekKey: string;
  weekNumber: number;
  year: number;
  mondayDateStr: string;
  fridayDateStr: string;
  mondayIso: string;
  fridayIso: string;
  rangeLabel: string;
  endIsoDate: string;
  isPastEndDate: boolean;
  isCurrentWeek: boolean;
}

export const RATING_METADATA: Record<
  TrackingRating,
  {
    code: string;
    label: string;
    progressValue: number;
    barColorClass: string;
  }
> = {
  UNTRACKED: {
    code: '—',
    label: 'Untracked',
    progressValue: 0,
    barColorClass: 'bg-slate-300',
  },
  WT: {
    code: 'WT',
    label: 'Working Towards',
    progressValue: 35,
    barColorClass: 'bg-amber-500',
  },
  PA: {
    code: 'PA',
    label: 'Partly Achieved',
    progressValue: 70,
    barColorClass: 'bg-sky-600',
  },
  A: {
    code: 'A',
    label: 'Achieved',
    progressValue: 100,
    barColorClass: 'bg-emerald-600',
  },
  M: {
    code: 'M',
    label: 'Mastery',
    progressValue: 100,
    barColorClass: 'bg-purple-600',
  },
  NA: {
    code: 'NA',
    label: 'Not Applicable',
    progressValue: 0,
    barColorClass: 'bg-slate-400',
  },
};

export function sanitizeBoundedString(
  input: string,
  maxLength: number,
  fallback = ''
): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

export function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).substring(2, 10);
  const time = Date.now().toString(36);
  const raw = `${prefix}_${time}_${rand}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function computeIsoWeekAndYear(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return { year: d.getUTCFullYear(), week: weekNo };
}

function getMondayOfDate(baseDate: Date): Date {
  const d = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate()
  );
  const day = d.getDay();
  // Monday–Friday tracking week; if Saturday (6) or Sunday (0), keep current week's Monday until next Monday arrives
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

export const DEFAULT_ACADEMIC_YEAR = '2026-2027';

export function hasAcademicYearInTitle(termTitle: string): boolean {
  return /\b\d{4}\s*[-/]\s*\d{4}\b/.test(termTitle);
}

export function extractAcademicYearFromTitle(termTitle: string): string {
  const m = termTitle.match(/\b(\d{4}\s*[-/]\s*\d{4})\b/);
  return m ? m[1].replace(/\s+/g, '') : DEFAULT_ACADEMIC_YEAR;
}

export function formatTermTitleWithYear(
  rawTitle: string,
  academicYear?: string
): string {
  const cleanYear =
    (academicYear || '').trim().replace(/\s+/g, '') || DEFAULT_ACADEMIC_YEAR;
  const cleanTitle = (rawTitle || '').trim().toUpperCase();
  if (!cleanTitle) {
    return `TERM 1 ${cleanYear}`;
  }
  if (hasAcademicYearInTitle(cleanTitle)) {
    return cleanTitle;
  }
  return `${cleanTitle} ${cleanYear}`;
}

export function doesTargetMatchTerm(
  targetTerm: string | undefined,
  activeTermName: string
): boolean {
  if (!activeTermName || !activeTermName.trim()) return false;
  const rawTarget = (targetTerm || 'TERM 1').trim().toUpperCase();
  const rawActive = activeTermName.trim().toUpperCase();
  if (rawTarget === rawActive) return true;
  if (!hasAcademicYearInTitle(rawTarget) && rawActive.endsWith(DEFAULT_ACADEMIC_YEAR)) {
    const baseActive = rawActive
      .slice(0, rawActive.length - DEFAULT_ACADEMIC_YEAR.length)
      .trim();
    return baseActive === rawTarget;
  }
  return false;
}

export interface AcademicTerm {
  id: string; // e.g. "term-1", "term-2", "term-3"
  name: string; // Always ALL CAPS with academic year, e.g. "TERM 1 2026-2027"
  academicYear?: string; // e.g. "2026-2027"
  isLocked: boolean; // true = locked/unavailable to staff, false = unlocked
  isArchived?: boolean; // kept optional for backward compatibility
  createdAt?: string;
}

export const MAX_ACADEMIC_TERMS = 3;

export const DEFAULT_ACADEMIC_TERMS: AcademicTerm[] = [
  {
    id: 'term-1',
    name: `TERM 1 ${DEFAULT_ACADEMIC_YEAR}`,
    academicYear: DEFAULT_ACADEMIC_YEAR,
    isLocked: false,
    isArchived: false,
  },
];

export const ACADEMIC_TERMS_STORAGE_KEY = 'targettrack_academic_terms_list';

export function sanitizeAcademicTerms(
  terms: AcademicTerm[],
  allowEmpty = false
): AcademicTerm[] {
  if (!Array.isArray(terms)) {
    return allowEmpty ? [] : DEFAULT_ACADEMIC_TERMS.map((t) => ({ ...t }));
  }
  const activeOnly = terms.filter((t) => !t?.isArchived);
  if (activeOnly.length === 0) {
    return allowEmpty ? [] : DEFAULT_ACADEMIC_TERMS.map((t) => ({ ...t }));
  }
  return activeOnly.slice(0, MAX_ACADEMIC_TERMS).map((t, idx) => {
    const rawName =
      typeof t.name === 'string' && t.name.trim()
        ? t.name.trim().toUpperCase()
        : `TERM ${idx + 1}`;
    const fullName = formatTermTitleWithYear(rawName, t.academicYear);
    const clean: AcademicTerm = {
      id: typeof t.id === 'string' && t.id ? t.id : `term-${idx + 1}`,
      name: fullName,
      academicYear: extractAcademicYearFromTitle(fullName),
      isLocked: Boolean(t.isLocked),
      isArchived: false,
    };
    if (typeof t.createdAt === 'string' && t.createdAt.trim()) {
      clean.createdAt = t.createdAt.trim();
    }
    return clean;
  });
}

export function getSavedAcademicTerms(): AcademicTerm[] {
  if (typeof window === 'undefined') return DEFAULT_ACADEMIC_TERMS;
  try {
    const raw = window.localStorage.getItem(ACADEMIC_TERMS_STORAGE_KEY);
    if (raw === null) return DEFAULT_ACADEMIC_TERMS;
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return sanitizeAcademicTerms(list, true);
    }
    return DEFAULT_ACADEMIC_TERMS;
  } catch {
    return DEFAULT_ACADEMIC_TERMS;
  }
}

export function saveAcademicTermsToLocal(terms: AcademicTerm[]): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = sanitizeAcademicTerms(terms, true);
    window.localStorage.setItem(
      ACADEMIC_TERMS_STORAGE_KEY,
      JSON.stringify(clean)
    );
    window.dispatchEvent(new CustomEvent('targettrack-terms-updated'));
  } catch {
    // ignore
  }
}

export interface WeekSetupConfig {
  baseWeekNumber: number;
  baseMondayIso: string;
  baseFridayIso: string;
  term?: string; // Always ALL CAPS with academic year, e.g. "TERM 1 2026-2027"
  termsList?: AcademicTerm[];
  isTermLocked?: boolean;
}

export interface AcademicArchive {
  id: string;
  adminUid: string;
  folderName: string;
  academicYear: string;
  term: string; // ALL CAPS
  archivedAt: string; // ISO string
  archivedAtLabel: string;
  dateRangeLabel: string;
  weekRangeText: string;
  totalStudents: number;
  totalTargets: number;
  notes?: string;
  studentsSnapshot: Student[];
  targetsSnapshot: Target[];
  overallRemarksSnapshot: string;
  weekSetupSnapshot: WeekSetupConfig;
  createdAt?: any;
}

const WEEK_SETUP_STORAGE_KEY = 'targettrack_week_setup_config';

function formatDateToIsoLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseIsoDateLocal(iso: string, fallback: Date): Date {
  if (!iso || typeof iso !== 'string') return new Date(fallback);
  const parts = iso.split('-').map((p) => parseInt(p, 10));
  if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(fallback);
}

export function getDefaultWeekSetupConfig(): WeekSetupConfig {
  const now = new Date();
  const baseMonday = getMondayOfDate(now);
  const baseFriday = new Date(baseMonday);
  baseFriday.setDate(baseMonday.getDate() + 4);
  const { week } = computeIsoWeekAndYear(baseMonday);
  return {
    baseWeekNumber: week,
    baseMondayIso: formatDateToIsoLocal(baseMonday),
    baseFridayIso: formatDateToIsoLocal(baseFriday),
    term: `TERM 1 ${DEFAULT_ACADEMIC_YEAR}`,
    termsList: DEFAULT_ACADEMIC_TERMS,
    isTermLocked: false,
  };
}

export function getSavedWeekSetupConfig(): WeekSetupConfig {
  const def = getDefaultWeekSetupConfig();
  if (typeof window === 'undefined') return def;
  try {
    const raw = window.localStorage.getItem(WEEK_SETUP_STORAGE_KEY);
    const savedTerms = getSavedAcademicTerms();
    if (!raw) {
      return {
        ...def,
        term: savedTerms[0]?.name || '',
        termsList: savedTerms,
        isTermLocked: savedTerms[0]?.isLocked || false,
      };
    }
    const parsed = JSON.parse(raw) as Partial<WeekSetupConfig>;
    const wk = Number(parsed.baseWeekNumber);
    if (savedTerms.length === 0) {
      return {
        baseWeekNumber:
          Number.isFinite(wk) && wk >= 1 && wk <= 520
            ? Math.round(wk)
            : def.baseWeekNumber,
        baseMondayIso:
          typeof parsed.baseMondayIso === 'string' &&
          parsed.baseMondayIso.length >= 8
            ? parsed.baseMondayIso
            : def.baseMondayIso,
        baseFridayIso:
          typeof parsed.baseFridayIso === 'string' &&
          parsed.baseFridayIso.length >= 8
            ? parsed.baseFridayIso
            : def.baseFridayIso,
        term: '',
        termsList: [],
        isTermLocked: false,
      };
    }

    const rawTermVal =
      typeof parsed.term === 'string' && parsed.term.trim()
        ? formatTermTitleWithYear(parsed.term)
        : savedTerms[0].name;

    const activeTerm =
      savedTerms.find((t) => t.name === rawTermVal) || savedTerms[0];

    return {
      baseWeekNumber:
        Number.isFinite(wk) && wk >= 1 && wk <= 520
          ? Math.round(wk)
          : def.baseWeekNumber,
      baseMondayIso:
        typeof parsed.baseMondayIso === 'string' &&
        parsed.baseMondayIso.length >= 8
          ? parsed.baseMondayIso
          : def.baseMondayIso,
      baseFridayIso:
        typeof parsed.baseFridayIso === 'string' &&
        parsed.baseFridayIso.length >= 8
          ? parsed.baseFridayIso
          : def.baseFridayIso,
      term: activeTerm.name,
      termsList: savedTerms,
      isTermLocked: Boolean(activeTerm.isLocked),
    };
  } catch {
    return def;
  }
}

export function saveWeekSetupConfigToLocal(config: WeekSetupConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEEK_SETUP_STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent('targettrack-week-config-updated'));
  } catch {
    // ignore storage errors
  }
}

export function buildWeekScheduleFromOffset(
  weekOffset = 0,
  activeWeekOffset = 0,
  customSetup?: WeekSetupConfig | null
): WeekScheduleInfo {
  const setup = customSetup || getSavedWeekSetupConfig();
  const now = new Date();
  const defaultBaseMonday = getMondayOfDate(now);

  // Keep weekKey anchored so customizing the display week number or dates preserves current/past week target tracking records
  const keyAnchorMonday = new Date(defaultBaseMonday);
  keyAnchorMonday.setDate(defaultBaseMonday.getDate() + weekOffset * 7);
  const { year: keyYear, week: keyIsoWeek } =
    computeIsoWeekAndYear(keyAnchorMonday);
  const paddedWeek = String(keyIsoWeek).padStart(2, '0');
  const weekKey = `${keyYear}-W${paddedWeek}`;

  const configuredMonday = parseIsoDateLocal(
    setup.baseMondayIso,
    defaultBaseMonday
  );
  const defaultBaseFriday = new Date(configuredMonday);
  defaultBaseFriday.setDate(configuredMonday.getDate() + 4);
  const configuredFriday = parseIsoDateLocal(
    setup.baseFridayIso,
    defaultBaseFriday
  );

  const targetMonday = new Date(configuredMonday);
  targetMonday.setDate(configuredMonday.getDate() + weekOffset * 7);

  const targetFriday = new Date(configuredFriday);
  targetFriday.setDate(configuredFriday.getDate() + weekOffset * 7);

  const displayWeekNumber = Math.max(1, setup.baseWeekNumber + weekOffset);

  const monDay = targetMonday.getDate();
  const monMonth = SHORT_MONTHS[targetMonday.getMonth()];
  const friDay = targetFriday.getDate();
  const friMonth = SHORT_MONTHS[targetFriday.getMonth()];
  const friYear = targetFriday.getFullYear();

  const mondayDateStr = `Mon ${monDay} ${monMonth}`;
  const fridayDateStr = `Fri ${friDay} ${friMonth} ${friYear}`;
  const rangeLabel = `${mondayDateStr} – ${fridayDateStr}`;
  const mondayIso = formatDateToIsoLocal(targetMonday);
  const fridayIso = formatDateToIsoLocal(targetFriday);
  const endIsoDate = fridayIso;

  return {
    weekKey,
    weekNumber: displayWeekNumber,
    year: friYear,
    mondayDateStr,
    fridayDateStr,
    mondayIso,
    fridayIso,
    rangeLabel,
    endIsoDate,
    isPastEndDate: weekOffset < activeWeekOffset,
    isCurrentWeek: weekOffset === activeWeekOffset,
  };
}

export function getTrackingWeeksList(
  activeWeekOffset = 0,
  customSetup?: WeekSetupConfig | null
): WeekScheduleInfo[] {
  // Include active week first, followed by past weeks (which automatically collapse after their Friday end date)
  const offsets = [
    activeWeekOffset,
    activeWeekOffset - 1,
    activeWeekOffset - 2,
  ];
  return offsets.map((off) =>
    buildWeekScheduleFromOffset(off, activeWeekOffset, customSetup)
  );
}

export function getCurrentWeekKey(
  activeWeekOffset = 0,
  customSetup?: WeekSetupConfig | null
): string {
  return buildWeekScheduleFromOffset(
    activeWeekOffset,
    activeWeekOffset,
    customSetup
  ).weekKey;
}

export function getUpcomingFridayDeadline(
  activeWeekOffset = 0,
  customSetup?: WeekSetupConfig | null
): string {
  return buildWeekScheduleFromOffset(
    activeWeekOffset,
    activeWeekOffset,
    customSetup
  ).endIsoDate;
}

export function parseWeeklyHistoryMap(
  summary: string
): Record<string, TrackingRating> {
  const map: Record<string, TrackingRating> = {};
  if (!summary) return map;
  const entries = summary
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of entries) {
    const [wk, rating] = item.split(':');
    if (
      wk &&
      (rating === 'WT' ||
        rating === 'PA' ||
        rating === 'A' ||
        rating === 'M' ||
        rating === 'NA')
    ) {
      map[wk.trim()] = rating;
    }
  }
  return map;
}

export function getTargetRatingForWeek(
  target: Target,
  weekKey: string
): TrackingRating {
  const historyMap = parseWeeklyHistoryMap(target.weeklyHistorySummary);
  if (historyMap[weekKey]) {
    return historyMap[weekKey];
  }
  if (
    target.currentWeekKey === weekKey &&
    (target.currentWeekStatus === 'WT' ||
      target.currentWeekStatus === 'PA' ||
      target.currentWeekStatus === 'A' ||
      target.currentWeekStatus === 'M' ||
      target.currentWeekStatus === 'NA')
  ) {
    return target.currentWeekStatus;
  }
  return 'UNTRACKED';
}

export function computeUpdatedHistorySummary(
  existingSummary: string,
  weekKey: string,
  rating: TrackingRating
): string {
  const entries = (existingSummary || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const filtered = entries.filter((item) => !item.startsWith(`${weekKey}:`));
  if (rating !== 'UNTRACKED') {
    filtered.push(`${weekKey}:${rating}`);
  }
  const joined = filtered.slice(-12).join(',');
  return joined.slice(0, 500);
}

export function isTargetTrackedInWeek(
  target: Target,
  weekKey: string
): boolean {
  const rating = getTargetRatingForWeek(target, weekKey);
  return (
    rating === 'WT' ||
    rating === 'PA' ||
    rating === 'A' ||
    rating === 'M' ||
    rating === 'NA'
  );
}

export function isTargetTrackedThisWeek(
  target: Target,
  activeWeekKey?: string
): boolean {
  const wk = activeWeekKey || getCurrentWeekKey(0);
  return isTargetTrackedInWeek(target, wk);
}

export type SchoolTier = 'ALL' | 'MIDDLE' | 'UPPER';

export function getStudentSchoolTier(
  studentOrYear?: Student | string | null
): 'MIDDLE' | 'UPPER' {
  if (!studentOrYear) return 'UPPER';
  const raw =
    typeof studentOrYear === 'string'
      ? studentOrYear
      : studentOrYear.yearGroup || '';
  const yg = raw.toLowerCase().trim();

  // Middle School encompasses Year 7 and Year 8
  if (
    yg.includes('year 7') ||
    yg.includes('year 8') ||
    yg.includes('yr 7') ||
    yg.includes('yr 8') ||
    yg.includes('y7') ||
    yg.includes('y8') ||
    yg === '7' ||
    yg === '8'
  ) {
    return 'MIDDLE';
  }
  // Upper School encompasses Year 9 to Year 13
  return 'UPPER';
}

export function formatSchoolTierLabel(tier: 'MIDDLE' | 'UPPER'): string {
  return tier === 'MIDDLE'
    ? 'Middle School (Year 7–8)'
    : 'Upper School (Year 9–13)';
}

export function formatTargetDisplayTitle(
  title: string,
  targetNumber?: number
): string {
  const clean = (title || '').trim();
  if (!clean) {
    return typeof targetNumber === 'number'
      ? `Target ${targetNumber}`
      : 'Target';
  }
  if (/^target\s*\d+/i.test(clean)) {
    return clean;
  }
  if (typeof targetNumber === 'number') {
    return `Target ${targetNumber}: ${clean}`;
  }
  return clean;
}

export interface TargetGroupItemBase {
  title: string;
  heading?: string;
  targetGroupId?: string;
}

export interface OrderedTargetEntry<T extends TargetGroupItemBase> {
  item: T;
  groupNumber: number;
  subIndex: number;
  displayNumber: string;
  isSubTarget: boolean;
  groupSize: number;
}

export interface OrderedTargetGroup<T extends TargetGroupItemBase> {
  groupKey: string;
  groupNumber: number;
  sharedHeading: string;
  entries: OrderedTargetEntry<T>[];
}

export function groupTargetsHierarchically<T extends TargetGroupItemBase>(
  items: T[]
): {
  groups: OrderedTargetGroup<T>[];
  flatEntries: OrderedTargetEntry<T>[];
} {
  const groupOrder: string[] = [];
  const groupMap: Record<string, T[]> = {};

  for (const item of items) {
    const cleanGroupId = (item.targetGroupId || '').trim();
    const key = cleanGroupId
      ? `grp::${cleanGroupId}`
      : `single::${(item.title || '').trim().toLowerCase()}`;
    if (!groupMap[key]) {
      groupMap[key] = [];
      groupOrder.push(key);
    }
    groupMap[key].push(item);
  }

  const groups: OrderedTargetGroup<T>[] = [];
  const flatEntries: OrderedTargetEntry<T>[] = [];

  groupOrder.forEach((groupKey, gIdx) => {
    const groupNumber = gIdx + 1;
    const rawItems = groupMap[groupKey];
    const hasSubTargets = rawItems.length > 1;
    const firstWithHeading = rawItems.find((x) => (x.heading || '').trim());
    const sharedHeading = (firstWithHeading?.heading || '').trim();

    const entries: OrderedTargetEntry<T>[] = rawItems.map((item, sIdx) => {
      const displayNumber = hasSubTargets
        ? `${groupNumber}.${sIdx + 1}`
        : `${groupNumber}`;
      const entry: OrderedTargetEntry<T> = {
        item,
        groupNumber,
        subIndex: hasSubTargets ? sIdx + 1 : 0,
        displayNumber,
        isSubTarget: hasSubTargets,
        groupSize: rawItems.length,
      };
      flatEntries.push(entry);
      return entry;
    });

    groups.push({
      groupKey,
      groupNumber,
      sharedHeading,
      entries,
    });
  });

  return { groups, flatEntries };
}
