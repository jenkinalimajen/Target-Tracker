export interface StaffPinSession {
  email: string;
  pin: string;
  remember: boolean;
  loggedInAt: number;
  expiresAt: number;
}

export interface LoadedStaffSessionState {
  session: StaffPinSession | null;
  expiredByRefresh: boolean;
  rememberedEmail: string;
}

const STAFF_SESSION_LOCAL_KEY = 'targettrack_staff_pin_session_v1';
const STAFF_SESSION_TAB_KEY = 'targettrack_staff_pin_session_tab_v1';
const REMEMBERED_USERNAME_KEY = 'targettrack_remembered_staff_email_v1';

// Daily system refresh occurs at 3:15 PM (15:15) local time
export const SYSTEM_REFRESH_HOUR = 15;
export const SYSTEM_REFRESH_MINUTE = 15;

export function getNextDailyRefreshTimestamp(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const nextRefresh = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    SYSTEM_REFRESH_HOUR,
    SYSTEM_REFRESH_MINUTE,
    0,
    0
  );
  if (now.getTime() >= nextRefresh.getTime()) {
    nextRefresh.setDate(nextRefresh.getDate() + 1);
  }
  return nextRefresh.getTime();
}

export function formatNextRefreshSummary(expiresAt: number): string {
  const target = new Date(expiresAt);
  const now = new Date();
  const isToday =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  return isToday ? '3:15 PM today' : '3:15 PM tomorrow';
}

export function getRememberedStaffEmail(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (window.localStorage.getItem(REMEMBERED_USERNAME_KEY) || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

export function saveStaffPinSession(params: {
  email: string;
  pin: string;
  remember: boolean;
  nowMs?: number;
}): StaffPinSession {
  const nowMs = params.nowMs ?? Date.now();
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanPin = params.pin.trim();
  const expiresAt = getNextDailyRefreshTimestamp(nowMs);

  const session: StaffPinSession = {
    email: cleanEmail,
    pin: cleanPin,
    remember: params.remember,
    loggedInAt: nowMs,
    expiresAt,
  };

  if (typeof window !== 'undefined') {
    const serialized = JSON.stringify(session);
    try {
      if (params.remember) {
        window.localStorage.setItem(STAFF_SESSION_LOCAL_KEY, serialized);
        window.localStorage.setItem(REMEMBERED_USERNAME_KEY, cleanEmail);
        window.sessionStorage.removeItem(STAFF_SESSION_TAB_KEY);
      } else {
        window.sessionStorage.setItem(STAFF_SESSION_TAB_KEY, serialized);
        window.localStorage.removeItem(STAFF_SESSION_LOCAL_KEY);
        window.localStorage.removeItem(REMEMBERED_USERNAME_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }

  return session;
}

export function loadActiveStaffPinSession(
  nowMs: number = Date.now()
): LoadedStaffSessionState {
  if (typeof window === 'undefined') {
    return { session: null, expiredByRefresh: false, rememberedEmail: '' };
  }

  let rawLocal: string | null = null;
  let rawTab: string | null = null;
  try {
    rawLocal = window.localStorage.getItem(STAFF_SESSION_LOCAL_KEY);
    rawTab = window.sessionStorage.getItem(STAFF_SESSION_TAB_KEY);
  } catch {
    return { session: null, expiredByRefresh: false, rememberedEmail: '' };
  }

  const raw = rawLocal || rawTab;
  if (!raw) {
    return {
      session: null,
      expiredByRefresh: false,
      rememberedEmail: getRememberedStaffEmail(),
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StaffPinSession>;
    const cleanEmail = (parsed.email || '').trim().toLowerCase();
    const cleanPin = (parsed.pin || '').trim();
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0;
    const remember = Boolean(parsed.remember);

    if (!cleanEmail || !/^\d{4}$/.test(cleanPin) || !expiresAt) {
      clearActiveStaffPinSession(false);
      return {
        session: null,
        expiredByRefresh: false,
        rememberedEmail: getRememberedStaffEmail(),
      };
    }

    // Check if the daily 3:15 PM system refresh has passed
    if (nowMs >= expiresAt) {
      try {
        window.localStorage.removeItem(STAFF_SESSION_LOCAL_KEY);
        window.sessionStorage.removeItem(STAFF_SESSION_TAB_KEY);
        if (remember) {
          window.localStorage.setItem(REMEMBERED_USERNAME_KEY, cleanEmail);
        } else {
          window.localStorage.removeItem(REMEMBERED_USERNAME_KEY);
        }
      } catch {
        // ignore
      }
      return {
        session: null,
        expiredByRefresh: true,
        rememberedEmail: remember ? cleanEmail : '',
      };
    }

    return {
      session: {
        email: cleanEmail,
        pin: cleanPin,
        remember,
        loggedInAt: typeof parsed.loggedInAt === 'number' ? parsed.loggedInAt : nowMs,
        expiresAt,
      },
      expiredByRefresh: false,
      rememberedEmail: remember ? cleanEmail : '',
    };
  } catch {
    clearActiveStaffPinSession(false);
    return {
      session: null,
      expiredByRefresh: false,
      rememberedEmail: getRememberedStaffEmail(),
    };
  }
}

export function clearActiveStaffPinSession(keepRememberedEmail: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STAFF_SESSION_LOCAL_KEY);
    window.sessionStorage.removeItem(STAFF_SESSION_TAB_KEY);
    if (!keepRememberedEmail) {
      window.localStorage.removeItem(REMEMBERED_USERNAME_KEY);
    }
  } catch {
    // ignore
  }
}
