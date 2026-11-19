/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  getDocs,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  LogIn,
  ArrowLeft,
  Shield,
  Users,
  KeyRound,
  Eye,
  EyeOff,
  Clock,
} from 'lucide-react';
import {
  auth,
  db,
  createGoogleProviderWithHint,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  StaffMember,
  Student,
  Target,
  NotificationItem,
  WeekSetupConfig,
  getSavedWeekSetupConfig,
  saveWeekSetupConfigToLocal,
  getSavedAcademicTerms,
  saveAcademicTermsToLocal,
  sanitizeAcademicTerms,
  formatTermTitleWithYear,
  buildWeekScheduleFromOffset,
  getUpcomingFridayDeadline,
  computeUpdatedHistorySummary,
  isOwnerAdminEmail,
  generateRandomStaffPin,
  isValidStaffPin,
} from './types';
import { seedAcademicCohortData } from './seedData';
import { StaffDashboard } from './components/StaffDashboard';
import { AdminOversight } from './components/AdminOversight';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  isPublicDeployedOrigin,
  extractStaffEmailFromLocation,
} from './utils/shareLinks';
import {
  StaffPinSession,
  loadActiveStaffPinSession,
  saveStaffPinSession,
  clearActiveStaffPinSession,
  formatNextRefreshSummary,
} from './utils/staffAuthSession';

const COPIED_STAFF_INTENT_KEY = 'targettrack_copied_staff_intent';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Direct link (?staff=email#staff=email) from the URL (never grants access without PIN unless Admin is viewing)
  const [urlStaffEmail, setUrlStaffEmail] = useState<string>(() =>
    extractStaffEmailFromLocation()
  );

  // Admin preview state (only active when signed in as verified Admin)
  const [adminPreviewStaffEmail, setAdminPreviewStaffEmail] = useState<string>('');

  // Initial Staff PIN session state (checks 3:15 PM daily refresh expiry on load)
  const initialPinStateRef = useRef(loadActiveStaffPinSession());
  const [staffSession, setStaffSession] = useState<StaffPinSession | null>(
    () => {
      const initialUrlEmail = extractStaffEmailFromLocation();
      const loaded = initialPinStateRef.current.session;
      // Keep direct links exclusive: if URL specifies a different staff email, require PIN for that email
      if (loaded && initialUrlEmail && loaded.email !== initialUrlEmail) {
        return null;
      }
      return loaded;
    }
  );

  const [loginEmailInput, setLoginEmailInput] = useState<string>(() => {
    const initialUrlEmail = extractStaffEmailFromLocation();
    return (
      initialUrlEmail ||
      initialPinStateRef.current.rememberedEmail ||
      ''
    );
  });
  const [loginPinInput, setLoginPinInput] = useState<string>('');
  const [showPinDigits, setShowPinDigits] = useState(false);
  const [rememberCredentials, setRememberCredentials] = useState<boolean>(() =>
    Boolean(initialPinStateRef.current.rememberedEmail)
  );
  const [isVerifyingPin, setIsVerifyingPin] = useState(false);
  const [pinLoginError, setPinLoginError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(() =>
    initialPinStateRef.current.expiredByRefresh
      ? 'Daily 3:15 PM system refresh completed. Please re-enter your 4-digit PIN to stay signed in today.'
      : null
  );

  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [hasLoadedStaff, setHasLoadedStaff] = useState(false);
  const [configuredPublicUrl, setConfiguredPublicUrl] = useState<string>('');
  const [weekSetup, setWeekSetup] = useState<WeekSetupConfig>(() =>
    getSavedWeekSetupConfig()
  );

  const handleSaveWeekSetup = (nextSetup: WeekSetupConfig) => {
    setWeekSetup(nextSetup);
    saveWeekSetupConfigToLocal(nextSetup);
  };

  useEffect(() => {
    const syncWeekConfig = () => {
      setWeekSetup(getSavedWeekSetupConfig());
    };
    window.addEventListener('storage', syncWeekConfig);
    window.addEventListener('targettrack-week-config-updated', syncWeekConfig);
    window.addEventListener('targettrack-terms-updated', syncWeekConfig);
    return () => {
      window.removeEventListener('storage', syncWeekConfig);
      window.removeEventListener(
        'targettrack-week-config-updated',
        syncWeekConfig
      );
      window.removeEventListener(
        'targettrack-terms-updated',
        syncWeekConfig
      );
    };
  }, []);

  // Keep terms_config locked/archived state synced persistently
  useEffect(() => {
    const unsubTerms = onSnapshot(
      doc(db, 'settings', 'terms_config'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (Array.isArray(data.terms)) {
            const cleanTerms = sanitizeAcademicTerms(data.terms, true);
            saveAcademicTermsToLocal(cleanTerms);
            const rawActiveName =
              typeof data.activeTerm === 'string' && data.activeTerm.trim()
                ? formatTermTitleWithYear(data.activeTerm)
                : cleanTerms[0]?.name || '';
            const matched =
              cleanTerms.find((t) => t.name === rawActiveName) ||
              cleanTerms[0] ||
              null;
            setWeekSetup((prev) => {
              const nextSetup: WeekSetupConfig = {
                baseWeekNumber:
                  typeof data.baseWeekNumber === 'number'
                    ? data.baseWeekNumber
                    : prev.baseWeekNumber,
                baseMondayIso:
                  typeof data.baseMondayIso === 'string' &&
                  data.baseMondayIso.length >= 8
                    ? data.baseMondayIso
                    : prev.baseMondayIso,
                baseFridayIso:
                  typeof data.baseFridayIso === 'string' &&
                  data.baseFridayIso.length >= 8
                    ? data.baseFridayIso
                    : prev.baseFridayIso,
                term: matched ? matched.name : '',
                termsList: cleanTerms,
                isTermLocked: matched ? Boolean(matched.isLocked) : false,
              };
              try {
                window.localStorage.setItem(
                  'targettrack_week_setup_config',
                  JSON.stringify(nextSetup)
                );
              } catch {
                // ignore
              }
              return nextSetup;
            });
          }
        }
      },
      (error) => {
        console.warn('Settings sync warning:', error);
      }
    );

    const unsubShare = onSnapshot(
      doc(db, 'settings', 'share_config'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          const savedUrl =
            typeof data.publicAppUrl === 'string'
              ? data.publicAppUrl.trim()
              : '';
          setConfiguredPublicUrl(savedUrl);
        }
      },
      (error) => {
        console.warn('Share config sync warning:', error);
      }
    );

    return () => {
      unsubTerms();
      unsubShare();
    };
  }, []);

  const hasAutoSeededRef = useRef(false);
  const hasBackfilledNotificationsRef = useRef(false);
  const hasBackfilledHistoryRef = useRef(false);
  const backfilledPinIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Listen for URL changes (e.g. opening or pasting a personal staff link)
  useEffect(() => {
    const syncFromUrl = () => {
      const fromUrl = extractStaffEmailFromLocation();
      if (fromUrl) {
        setUrlStaffEmail(fromUrl);
        setLoginEmailInput(fromUrl);
        setPinLoginError(null);
        try {
          localStorage.removeItem(COPIED_STAFF_INTENT_KEY);
        } catch {
          // ignore
        }
        setStaffSession((prev) => {
          if (prev && prev.email !== fromUrl) {
            return null;
          }
          return prev;
        });
      }
    };

    window.addEventListener('hashchange', syncFromUrl);
    window.addEventListener('popstate', syncFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncFromUrl);
      window.removeEventListener('popstate', syncFromUrl);
    };
  }, []);

  // Enforce daily 3:15 PM system refresh:
  // If user ticked Remember, keep ONLY username after 3:15 PM and require re-entering PIN password.
  // If user did NOT tick Remember, clear both username and password after 3:15 PM.
  useEffect(() => {
    if (!staffSession) return;

    const triggerDailyRefreshIfDue = () => {
      if (Date.now() < staffSession.expiresAt) return;

      const wasRemembered = staffSession.remember;
      const rememberedEmail = wasRemembered ? staffSession.email : '';
      clearActiveStaffPinSession(wasRemembered);
      setStaffSession(null);
      setLoginPinInput('');
      setRememberCredentials(wasRemembered);
      setLoginEmailInput(urlStaffEmail || rememberedEmail || '');
      setRefreshNotice(
        'Daily 3:15 PM system refresh completed. Please enter your 4-digit PIN to sign in for today.'
      );
    };

    triggerDailyRefreshIfDue();
    const msRemaining = Math.max(500, staffSession.expiresAt - Date.now());
    const timeoutId = window.setTimeout(
      triggerDailyRefreshIfDue,
      Math.min(msRemaining, 2147483647)
    );
    const intervalId = window.setInterval(triggerDailyRefreshIfDue, 30000);
    window.addEventListener('focus', triggerDailyRefreshIfDue);
    document.addEventListener('visibilitychange', triggerDailyRefreshIfDue);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      window.removeEventListener('focus', triggerDailyRefreshIfDue);
      document.removeEventListener('visibilitychange', triggerDailyRefreshIfDue);
    };
  }, [staffSession, urlStaffEmail]);

  const userEmail = currentUser?.email?.trim().toLowerCase() || '';

  const signedInUserRecord = userEmail
    ? staffList.find((s) => s.email.trim().toLowerCase() === userEmail)
    : undefined;

  const isOwnerUser = Boolean(
    currentUser &&
      (isOwnerAdminEmail(userEmail) ||
        signedInUserRecord?.role === 'ADMIN' ||
        staffList.length === 0)
  );

  // Authenticated Admin can preview a staff dashboard via dropdown/Staff Portal tab OR by opening a ?staff= link while signed in as Admin
  const effectiveAdminPreviewEmail =
    currentUser && isOwnerUser
      ? (adminPreviewStaffEmail || urlStaffEmail).trim().toLowerCase()
      : '';

  // Effective staff email when viewing StaffDashboard
  const effectiveStaffEmail = (
    effectiveAdminPreviewEmail ||
    staffSession?.email ||
    userEmail
  )
    .trim()
    .toLowerCase();

  const matchedUserRecord = staffList.find(
    (s) => s.email.trim().toLowerCase() === effectiveStaffEmail
  );

  // If Admin opens the app from a true public deployed URL (e.g. Cloud Run or Firebase Hosting without ais-pre/ais-dev),
  // automatically persist that public origin so future Share Links bypass AI Studio's workspace gate.
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !currentUser ||
      !isOwnerUser ||
      !currentUser.emailVerified
    ) {
      return;
    }
    const currentOrigin = (window.location?.origin || '').replace(/\/+$/, '');
    if (
      isPublicDeployedOrigin(currentOrigin) &&
      !isPublicDeployedOrigin(configuredPublicUrl)
    ) {
      setDoc(
        doc(db, 'settings', 'share_config'),
        {
          publicAppUrl: currentOrigin,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      ).catch(() => {});
    }
  }, [currentUser, isOwnerUser, configuredPublicUrl]);

  const showAdminDashboard = Boolean(
    currentUser && isOwnerUser && !effectiveAdminPreviewEmail
  );

  const hasActiveSession = Boolean(
    (currentUser && userEmail) ||
      (staffSession &&
        Date.now() < staffSession.expiresAt &&
        (!urlStaffEmail || staffSession.email === urlStaffEmail))
  );

  useEffect(() => {
    if (!isAuthReady && !staffSession) {
      return;
    }
    if (!hasActiveSession) {
      setStaffList([]);
      setHasLoadedStaff(false);
      setStudents([]);
      setTargets([]);
      setNotifications([]);
      return;
    }

    setIsLoadingData(true);
    setHasLoadedStaff(false);
    const uid = currentUser?.uid || '';

    // Unified real-time collection listeners so Admin and authenticated Staff receive identical real-time updates
    const staffQuery = collection(db, 'staff');
    const studentsQuery = collection(db, 'students');
    const targetsQuery = collection(db, 'targets');
    const notificationsQuery = collection(db, 'notifications');

    const unsubStaff = onSnapshot(
      staffQuery,
      (snapshot) => {
        const items: StaffMember[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<StaffMember, 'id'>),
        }));
        setStaffList(items);
        setHasLoadedStaff(true);

        // If signed in via Staff PIN session, verify staff record & PIN still match
        if (staffSession && !currentUser) {
          const activeRec = items.find(
            (s) => s.email.trim().toLowerCase() === staffSession.email
          );
          if (
            !activeRec ||
            (isValidStaffPin(activeRec.pin) && activeRec.pin !== staffSession.pin)
          ) {
            clearActiveStaffPinSession(staffSession.remember);
            setStaffSession(null);
            setLoginPinInput('');
            setPinLoginError(
              'Your login details were updated by an administrator. Please sign in again.'
            );
            return;
          }
        }

        for (const item of items) {
          // Backfill fixed random 4-digit PIN for any existing staff doc lacking one when Admin is online
          if (
            isOwnerUser &&
            currentUser?.emailVerified &&
            !isValidStaffPin(item.pin) &&
            !backfilledPinIdsRef.current.has(item.id)
          ) {
            backfilledPinIdsRef.current.add(item.id);
            updateDoc(doc(db, 'staff', item.id), {
              pin: generateRandomStaffPin(),
              updatedAt: serverTimestamp(),
            }).catch(() => {
              backfilledPinIdsRef.current.delete(item.id);
            });
          } else if (
            item.email.trim().toLowerCase() === effectiveStaffEmail &&
            item.inviteStatus === 'INVITED' &&
            item.role
          ) {
            updateDoc(doc(db, 'staff', item.id), {
              inviteStatus: 'ACTIVE',
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } else if (isOwnerUser && !item.role) {
            const inferredRole = isOwnerAdminEmail(item.email)
                ? 'ADMIN'
                : 'STAFF';
            updateDoc(doc(db, 'staff', item.id), {
              name: item.name,
              email: item.email,
              department: item.department,
              role: inferredRole,
              inviteStatus: item.inviteStatus || 'ACTIVE',
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'staff');
      }
    );

    const unsubStudents = onSnapshot(
      studentsQuery,
      (snapshot) => {
        const items: Student[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Student, 'id'>),
        }));
        setStudents(items);
        setIsLoadingData(false);

        if (
          !snapshot.metadata.fromCache &&
          isOwnerUser &&
          uid &&
          snapshot.empty &&
          !hasAutoSeededRef.current &&
          currentUser?.emailVerified
        ) {
          hasAutoSeededRef.current = true;
          seedAcademicCohortData(
            uid,
            userEmail,
            currentUser.displayName || 'Administrator'
          ).catch((err) => {
            hasAutoSeededRef.current = false;
            console.warn('Auto-seed skipped until connection stabilizes:', err);
          });
        }
      },
      (error) => {
        setIsLoadingData(false);
        handleFirestoreError(error, OperationType.LIST, 'students');
      }
    );

    const unsubTargets = onSnapshot(
      targetsQuery,
      (snapshot) => {
        const items: Target[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Target, 'id'>),
        }));
        setTargets(items);

        // One-time backfill of past weeks (Week -1 & Week -2) and Further Mathematics on Maya Patel
        if (
          !snapshot.metadata.fromCache &&
          isOwnerUser &&
          uid &&
          items.length > 0 &&
          !hasBackfilledHistoryRef.current &&
          currentUser?.emailVerified
        ) {
          hasBackfilledHistoryRef.current = true;
          const prevWeek1Key = buildWeekScheduleFromOffset(-1, 0).weekKey;
          const prevWeek2Key = buildWeekScheduleFromOffset(-2, 0).weekKey;
          const currentWeekKeyVal = buildWeekScheduleFromOffset(0, 0).weekKey;
          const deadlineVal = getUpcomingFridayDeadline(0);

          for (const tgt of items) {
            if (
              tgt.trackingRequired &&
              !tgt.weeklyHistorySummary.includes(prevWeek1Key)
            ) {
              const step1 = computeUpdatedHistorySummary(
                tgt.weeklyHistorySummary,
                prevWeek2Key,
                'WT'
              );
              const step2 = computeUpdatedHistorySummary(
                step1,
                prevWeek1Key,
                'PA'
              );
              updateDoc(doc(db, 'targets', tgt.id), {
                weeklyHistorySummary: step2,
                updatedAt: serverTimestamp(),
              }).catch(() => {});
            }
          }

          // Ensure Maya Patel has Further Mathematics tracked by Hannah Lin so Maya Patel appears on 2 subject buttons on Hannah Lin's Staff Dashboard
          const hasMayaFurtherMath = items.some(
            (t) =>
              t.studentId === 'stu_maya_patel' &&
              t.subject === 'Further Mathematics'
          );
          if (!hasMayaFurtherMath) {
            const mayaMathTargets = items.filter(
              (t) =>
                t.studentId === 'stu_maya_patel' &&
                t.subject === 'Mathematics'
            );
            mayaMathTargets.forEach((mTgt, idx) => {
              const newId = `tgt_maya_fmath_${idx + 1}`;
              setDoc(doc(db, 'targets', newId), {
                adminUid: uid,
                studentId: 'stu_maya_patel',
                studentName: 'Maya Patel',
                subject: 'Further Mathematics',
                title: mTgt.title,
                trackingRequired: mTgt.trackingRequired,
                assignedStaffEmail: mTgt.assignedStaffEmail,
                assignedStaffName: mTgt.assignedStaffName,
                subjectStaffEmail: 'hannah.lin@oakridge.edu',
                currentWeekStatus: 'UNTRACKED',
                currentWeekKey: currentWeekKeyVal,
                progressScore: 0,
                weeklyHistorySummary: mTgt.trackingRequired
                  ? `${prevWeek2Key}:WT,${prevWeek1Key}:PA`
                  : '',
                lastTrackedByEmail: 'none',
                deadlineDate: deadlineVal,
                notes: '',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }).catch(() => {});
            });
          }
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'targets');
      }
    );

    const unsubNotifications = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        const items: NotificationItem[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<NotificationItem, 'id'>),
        }));
        setNotifications(items);

        // Ensure seeded staff have initial notifications once, and never re-seed after deletion
        const alreadySeededNotifs =
          typeof window !== 'undefined' &&
          window.localStorage?.getItem('targettrack_initial_notifs_seeded') ===
            'true';
        if (
          !snapshot.metadata.fromCache &&
          isOwnerUser &&
          uid &&
          !hasBackfilledNotificationsRef.current &&
          !alreadySeededNotifs &&
          currentUser?.emailVerified &&
          items.length === 0
        ) {
          hasBackfilledNotificationsRef.current = true;
          try {
            window.localStorage?.setItem(
              'targettrack_initial_notifs_seeded',
              'true'
            );
          } catch {
            // ignore
          }
          const deadline = getUpcomingFridayDeadline(0);
          const seedNotifs = [
            {
              id: 'notif_hannah_maya_assign',
              recipientEmail: 'hannah.lin@oakridge.edu',
              recipientName: 'Hannah Lin',
              title: 'Student Assigned & Targets Updated: Maya Patel',
              message:
                'Maya Patel (Mathematics & Further Mathematics) was assigned to you with applicable and non-applicable targets.',
              studentId: 'stu_maya_patel',
              studentName: 'Maya Patel',
              subject: 'Mathematics',
            },
            {
              id: 'notif_clara_amara_assign',
              recipientEmail: 'clara.vance@oakridge.edu',
              recipientName: 'Clara Vance',
              title: 'Student Assigned & Targets Updated: Amara Osei',
              message:
                'Amara Osei (English) has updated weekly targets ready for your tracking.',
              studentId: 'stu_amara_osei',
              studentName: 'Amara Osei',
              subject: 'English',
            },
            {
              id: 'notif_david_maya_assign',
              recipientEmail: 'david.okafor@oakridge.edu',
              recipientName: 'David Okafor',
              title: 'Student Assigned & Targets Updated: Maya Patel',
              message:
                'Maya Patel (Science) was assigned to your dashboard with updated subject target applicability.',
              studentId: 'stu_maya_patel',
              studentName: 'Maya Patel',
              subject: 'Science',
            },
          ];
          for (const sn of seedNotifs) {
            setDoc(doc(db, 'notifications', sn.id), {
              adminUid: uid,
              recipientEmail: sn.recipientEmail,
              recipientName: sn.recipientName,
              type: 'PENDING_ASSIGNMENT',
              title: sn.title,
              message: sn.message,
              studentId: sn.studentId,
              studentName: sn.studentName,
              subject: sn.subject,
              dueDate: deadline,
              isRead: false,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'notifications');
      }
    );

    return () => {
      unsubStaff();
      unsubStudents();
      unsubTargets();
      unsubNotifications();
    };
  }, [
    isAuthReady,
    hasActiveSession,
    currentUser,
    userEmail,
    staffSession,
    effectiveStaffEmail,
    isOwnerUser,
  ]);

  const handleAdminGoogleSignIn = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const provider = createGoogleProviderWithHint(urlStaffEmail || loginEmailInput);
      await signInWithPopup(auth, provider);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : 'Admin sign-in interrupted.'
      );
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleStaffPinSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = loginEmailInput.trim().toLowerCase();
    const cleanPin = loginPinInput.trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setPinLoginError('Please enter your registered staff email username.');
      return;
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      setPinLoginError('Please enter your 4-digit numeric PIN password.');
      return;
    }

    setIsVerifyingPin(true);
    setPinLoginError(null);
    setRefreshNotice(null);

    try {
      const snapshot = await getDocs(collection(db, 'staff'));
      const matchedDoc = snapshot.docs
        .map((d) => ({
          id: d.id,
          ...(d.data() as Omit<StaffMember, 'id'>),
        }))
        .find((s) => s.email.trim().toLowerCase() === cleanEmail);

      if (!matchedDoc) {
        setPinLoginError(
          'Username not found. It must match the exact email registered by your administrator.'
        );
        return;
      }

      if (!isValidStaffPin(matchedDoc.pin)) {
        setPinLoginError(
          'A 4-digit PIN has not been assigned to this account yet. Ask your administrator to click "View Login Details" in Staff Management.'
        );
        return;
      }

      if (matchedDoc.pin !== cleanPin) {
        setPinLoginError(
          'Incorrect 4-digit PIN password. If you forgot it, ask your administrator to view your login details.'
        );
        return;
      }

      const nextSession = saveStaffPinSession({
        email: cleanEmail,
        pin: cleanPin,
        remember: rememberCredentials,
      });

      setStaffSession(nextSession);
      setLoginPinInput('');
    } catch (error) {
      setPinLoginError(
        error instanceof Error
          ? error.message
          : 'Unable to verify login details. Check connection and try again.'
      );
    } finally {
      setIsVerifyingPin(false);
    }
  };

  const handleStaffSignOut = () => {
    const keepEmail = Boolean(staffSession?.remember);
    const prevEmail = staffSession?.email || '';
    clearActiveStaffPinSession(keepEmail);
    setStaffSession(null);
    setLoginPinInput('');
    setPinLoginError(null);
    setRefreshNotice(null);
    setLoginEmailInput(urlStaffEmail || (keepEmail ? prevEmail : ''));
  };

  const handleOpenAdminStaffPreview = (staffEmail: string) => {
    const clean = staffEmail.trim().toLowerCase();
    setAdminPreviewStaffEmail(clean);
    try {
      const encoded = encodeURIComponent(clean);
      window.history.replaceState(
        {},
        '',
        `/?staff=${encoded}#staff=${encoded}`
      );
    } catch {
      // ignore
    }
  };

  const handleExitAdminStaffPreview = () => {
    setAdminPreviewStaffEmail('');
    setUrlStaffEmail('');
    try {
      window.history.replaceState({}, '', '/');
    } catch {
      // ignore
    }
  };

  const staffOnlyMembers = staffList.filter(
    (s) =>
      (s.role ||
        (isOwnerAdminEmail(s.email)
          ? 'ADMIN'
          : 'STAFF')) === 'STAFF'
  );

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Top Bar with High-Visibility Portal Tabs */}
        <header className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5 bg-white border-b border-slate-200 text-slate-900">
          <div className="flex items-center gap-3">
            <span className="text-base font-black tracking-tight whitespace-nowrap shrink-0 text-slate-900">
              TargetTrack
            </span>
          </div>

          {currentUser && isOwnerUser && (
            <div className="flex flex-wrap items-center gap-3">
              {/* High-Visibility Portal Switcher Tabs */}
              <div className="inline-flex items-center gap-1.5 p-1 rounded-xl border border-slate-300 bg-slate-100 shadow-xs">
                <button
                  type="button"
                  onClick={handleExitAdminStaffPreview}
                  className={`px-3.5 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all inline-flex items-center gap-2 ${
                    showAdminDashboard
                      ? 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900'
                      : 'text-slate-700 hover:text-slate-900 hover:bg-white/80 font-bold'
                  }`}
                >
                  <Shield className="w-4 h-4" />
                  <span>Admin Portal</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const defaultStaff =
                      effectiveAdminPreviewEmail ||
                      staffOnlyMembers[0]?.email ||
                      'hannah.lin@oakridge.edu';
                    handleOpenAdminStaffPreview(defaultStaff);
                  }}
                  className={`px-3.5 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all inline-flex items-center gap-2 ${
                    !showAdminDashboard
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40 ring-1 ring-emerald-400/60'
                      : 'text-slate-700 hover:text-slate-900 hover:bg-white/80 font-bold'
                  }`}
                >
                  <Users className="w-4 h-4" />
                  <span>Staff Portal</span>
                </button>
              </div>

              {staffOnlyMembers.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold hidden sm:inline text-slate-500">
                    Direct Staff View:
                  </span>
                  <select
                    value={effectiveAdminPreviewEmail || ''}
                    onChange={(e) => {
                      if (e.target.value) {
                        handleOpenAdminStaffPreview(e.target.value);
                      } else {
                        handleExitAdminStaffPreview();
                      }
                    }}
                    className="text-xs border rounded-md px-2.5 py-1.5 font-medium cursor-pointer shadow-2xs focus:outline-none bg-white border-slate-300 text-slate-800 hover:border-slate-400 focus:border-slate-900"
                  >
                    <option value="">Admin Oversight (All Staff)</option>
                    {staffOnlyMembers.map((st) => (
                      <option key={st.id} value={st.email.toLowerCase()}>
                        {st.name} — {st.department}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {((currentUser && !isOwnerUser) || (!currentUser && staffSession)) ? (
            <div className="hidden sm:flex items-center gap-2.5 text-xs text-slate-500">
              <span>
                {showAdminDashboard ? 'Admin Account' : 'Staff Dashboard'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700">
                {showAdminDashboard ? userEmail : effectiveStaffEmail}
              </span>
              {!currentUser && staffSession && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
                    <Clock className="w-3 h-3" />
                    Active until {formatNextRefreshSummary(staffSession.expiresAt)}
                  </span>
                </>
              )}
            </div>
          ) : null}

          <div className="flex items-center gap-2.5 shrink-0">
            {currentUser && isOwnerUser && effectiveAdminPreviewEmail && (
              <button
                type="button"
                onClick={handleExitAdminStaffPreview}
                className="px-3 py-1.5 text-xs font-medium border rounded-md inline-flex items-center gap-1 whitespace-nowrap shrink-0 bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Admin
              </button>
            )}

            {!currentUser &&
              staffSession &&
              (matchedUserRecord?.role === 'ADMIN' ||
                isOwnerAdminEmail(staffSession.email)) && (
                <button
                  type="button"
                  onClick={handleAdminGoogleSignIn}
                  disabled={isSigningIn}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 bg-slate-900 text-white hover:bg-slate-800"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>Open Admin Portal</span>
                </button>
              )}

            {currentUser ? (
              <button
                type="button"
                onClick={() => signOut(auth)}
                className="px-3.5 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Sign Out
              </button>
            ) : staffSession ? (
              <button
                type="button"
                onClick={handleStaffSignOut}
                className="px-3.5 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Sign Out
              </button>
            ) : null}
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-8">
          {!isAuthReady && !staffSession ? (
            <div className="text-center py-12 text-xs text-slate-500">
              Checking browser login session...
            </div>
          ) : !hasActiveSession ? (
            <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-lg p-6 mt-10 space-y-5 shadow-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                    <KeyRound className="w-4 h-4" />
                  </div>
                  <div>
                    <h1 className="text-lg font-bold text-slate-900">
                      TargetTrack Staff Sign-In
                    </h1>
                    <p className="text-xs text-slate-500">
                      Sign in with your registered email username and 4-digit PIN.
                    </p>
                  </div>
                </div>
              </div>

              {urlStaffEmail && (
                <div className="p-2.5 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
                  <span>
                    Personal link for{' '}
                    <strong className="font-mono">{urlStaffEmail}</strong>
                  </span>
                </div>
              )}

              {refreshNotice && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 flex items-start gap-2">
                  <Clock className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                  <span>{refreshNotice}</span>
                </div>
              )}

              {pinLoginError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  {pinLoginError}
                </div>
              )}

              <form onSubmit={handleStaffPinSignIn} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Username (Registered Email)
                  </label>
                  <input
                    type="email"
                    required
                    autoComplete="username"
                    placeholder="e.g. name@gemswis.com"
                    value={loginEmailInput}
                    onChange={(e) => setLoginEmailInput(e.target.value)}
                    className="w-full text-xs bg-white border border-slate-300 rounded-md px-3 py-2.5 text-slate-900 focus:outline-none focus:border-slate-900 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    4-Digit PIN Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPinDigits ? 'text' : 'password'}
                      required
                      inputMode="numeric"
                      maxLength={4}
                      pattern="\d{4}"
                      autoComplete="current-password"
                      placeholder="••••"
                      value={loginPinInput}
                      onChange={(e) => {
                        const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                        setLoginPinInput(digitsOnly);
                      }}
                      className="w-full text-sm tracking-[0.35em] bg-white border border-slate-300 rounded-md pl-3 pr-10 py-2.5 text-slate-900 focus:outline-none focus:border-slate-900 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPinDigits((prev) => !prev)}
                      className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-700"
                      title={showPinDigits ? 'Hide PIN' : 'Show PIN'}
                    >
                      {showPinDigits ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <label className="flex items-start gap-2.5 cursor-pointer select-none pt-0.5">
                  <input
                    type="checkbox"
                    checked={rememberCredentials}
                    onChange={(e) => setRememberCredentials(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  <span className="text-xs text-slate-700 leading-snug">
                    <span className="font-semibold">
                      Remember username and password
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      Keeps you signed in until the daily 3:15 PM system refresh. After 3:15 PM, only your username is remembered and you will re-enter your PIN.
                    </span>
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={isVerifyingPin}
                  className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-bold rounded-md transition-colors flex items-center justify-center gap-2"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {isVerifyingPin ? 'Verifying PIN...' : 'Sign In with PIN'}
                </button>
              </form>

              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-slate-400 font-medium text-[10px]">
                    Administrator Access
                  </span>
                </div>
              </div>

              {authError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={handleAdminGoogleSignIn}
                disabled={isSigningIn}
                className="w-full py-2 px-4 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold rounded-md transition-colors flex items-center justify-center gap-2"
              >
                <LogIn className="w-3.5 h-3.5" />
                {isSigningIn
                  ? 'Connecting to Google...'
                  : 'Admin Sign-In with Google'}
              </button>
            </div>
          ) : isLoadingData || !hasLoadedStaff ? (
            <div className="text-center py-12 text-xs text-slate-500">
              Loading your personal dashboard...
            </div>
          ) : showAdminDashboard && currentUser ? (
            <AdminOversight
              adminUid={currentUser.uid}
              staffList={staffList}
              students={students}
              targets={targets}
              weekSetup={weekSetup}
              configuredPublicUrl={configuredPublicUrl}
              onSaveWeekSetup={handleSaveWeekSetup}
              onOpenStaffSharePreview={handleOpenAdminStaffPreview}
            />
          ) : (
            <StaffDashboard
              staffEmail={effectiveStaffEmail}
              staffName={
                matchedUserRecord?.name ||
                (effectiveStaffEmail === userEmail
                  ? currentUser?.displayName
                  : effectiveStaffEmail.split('@')[0]) ||
                'Staff Member'
              }
              staffDepartment={matchedUserRecord?.department || 'Subject Staff'}
              students={students}
              targets={targets}
              notifications={notifications}
              weekSetup={weekSetup}
              configuredPublicUrl={configuredPublicUrl}
              isAdminViewing={Boolean(
                currentUser && isOwnerUser && effectiveAdminPreviewEmail
              )}
              onBackToAdmin={handleExitAdminStaffPreview}
            />
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
