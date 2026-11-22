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
  onSnapshot,
  doc,
  getDocFromServer,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  LogIn,
  ArrowLeft,
  Shield,
  Users,
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
  UserRole,
  WeekSetupConfig,
  getSavedWeekSetupConfig,
  saveWeekSetupConfigToLocal,
  saveAcademicTermsToLocal,
  sanitizeAcademicTerms,
  sanitizeBoundedString,
  formatTermTitleWithYear,
  buildWeekScheduleFromOffset,
  getUpcomingFridayDeadline,
  computeUpdatedHistorySummary,
  isOwnerAdminEmail,
  isAllowedDomainEmail,
} from './types';
import { seedAcademicCohortData } from './seedData';
import { StaffDashboard } from './components/StaffDashboard';
import { AdminOversight } from './components/AdminOversight';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  isPublicDeployedOrigin,
  extractStaffEmailFromLocation,
} from './utils/shareLinks';

const COPIED_STAFF_INTENT_KEY = 'targettrack_copied_staff_intent';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isCheckingAccess, setIsCheckingAccess] = useState(false);
  const [isAccessAuthorized, setIsAccessAuthorized] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Direct link (?staff=email#staff=email) from the URL
  const [urlStaffEmail, setUrlStaffEmail] = useState<string>(() =>
    extractStaffEmailFromLocation()
  );

  // Admin preview state (only active when signed in as an Admin)
  const [adminPreviewStaffEmail, setAdminPreviewStaffEmail] = useState<string>('');

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

  // Keep terms_config locked/archived state synced persistently once authorized
  useEffect(() => {
    if (!isAuthReady || !currentUser || !isAccessAuthorized) return;

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
  }, [isAuthReady, currentUser, isAccessAuthorized]);

  const hasAutoSeededRef = useRef(false);
  const hasBackfilledNotificationsRef = useRef(false);
  const hasBackfilledHistoryRef = useRef(false);
  const autoRegisteredEmailsRef = useRef<Set<string>>(new Set());
  const syncedAllowedEmailsRef = useRef<Set<string>>(new Set());

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
        try {
          localStorage.removeItem(COPIED_STAFF_INTENT_KEY);
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('hashchange', syncFromUrl);
    window.addEventListener('popstate', syncFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncFromUrl);
      window.removeEventListener('popstate', syncFromUrl);
    };
  }, []);

  const userEmail = currentUser?.email?.trim().toLowerCase() || '';

  const signedInUserRecord = userEmail
    ? staffList.find((s) => s.email.trim().toLowerCase() === userEmail)
    : undefined;

  // Only j.alimajen_wis@gemswis.com receives Admin automatically; others only receive Admin if manually promoted in Staff Management
  const isOwnerUser = Boolean(
    currentUser &&
      (isOwnerAdminEmail(userEmail) || signedInUserRecord?.role === 'ADMIN')
  );

  // Authenticated Admin can preview a staff dashboard via dropdown/Staff Portal tab OR by opening a ?staff= link while signed in as Admin
  const effectiveAdminPreviewEmail =
    currentUser && isOwnerUser
      ? (adminPreviewStaffEmail || urlStaffEmail).trim().toLowerCase()
      : '';

  // Effective staff email when viewing StaffDashboard
  const effectiveStaffEmail = (effectiveAdminPreviewEmail || userEmail)
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

  // Enforce Google Sign-In restriction: only @gemswis.com accounts or emails manually added by the administrator
  useEffect(() => {
    if (!isAuthReady) {
      return;
    }
    if (!currentUser || !userEmail) {
      setIsCheckingAccess(false);
      setIsAccessAuthorized(false);
      return;
    }
    if (!currentUser.emailVerified) {
      setIsCheckingAccess(false);
      setIsAccessAuthorized(false);
      setAuthError('Sign-in restricted. Please use an authorized account.');
      signOut(auth).catch(() => {});
      return;
    }
    if (isOwnerAdminEmail(userEmail) || isAllowedDomainEmail(userEmail)) {
      setIsAccessAuthorized(true);
      setIsCheckingAccess(false);
      setAuthError(null);
      return;
    }

    let isCancelled = false;
    let unsubRevoke: (() => void) | null = null;
    setIsCheckingAccess(true);
    setIsAccessAuthorized(false);

    const allowedDocRef = doc(db, 'allowed_emails', userEmail);
    const adminDocRef = doc(db, 'admin_emails', userEmail);

    (async () => {
      try {
        const [allowedSnap, adminSnap] = await Promise.all([
          getDocFromServer(allowedDocRef).catch(() => null),
          getDocFromServer(adminDocRef).catch(() => null),
        ]);
        if (isCancelled) return;

        if (allowedSnap?.exists() || adminSnap?.exists()) {
          setIsAccessAuthorized(true);
          setIsCheckingAccess(false);
          setAuthError(null);

          if (allowedSnap?.exists()) {
            unsubRevoke = onSnapshot(allowedDocRef, (liveSnap) => {
              if (isCancelled) return;
              if (!liveSnap.metadata.fromCache && !liveSnap.exists()) {
                setIsAccessAuthorized(false);
                setAuthError(
                  'Sign-in restricted. Access is no longer active for this account.'
                );
                signOut(auth).catch(() => {});
              }
            });
          }
          return;
        }
      } catch {
        // Fall through to access denial
      }

      if (isCancelled) return;
      setIsAccessAuthorized(false);
      setIsCheckingAccess(false);
      setAuthError(
        'Sign-in restricted. You do not have permission to access this application.'
      );
      signOut(auth).catch(() => {});
    })();

    return () => {
      isCancelled = true;
      if (unsubRevoke) unsubRevoke();
    };
  }, [isAuthReady, currentUser, userEmail]);

  const showAdminDashboard = Boolean(
    currentUser && isAccessAuthorized && isOwnerUser && !effectiveAdminPreviewEmail
  );

  const hasActiveSession = Boolean(
    isAuthReady &&
      currentUser &&
      userEmail &&
      currentUser.emailVerified &&
      isAccessAuthorized
  );

  useEffect(() => {
    if (!isAuthReady) {
      return;
    }
    if (!hasActiveSession || !currentUser) {
      setStaffList([]);
      setHasLoadedStaff(false);
      setStudents([]);
      setTargets([]);
      setNotifications([]);
      autoRegisteredEmailsRef.current.clear();
      syncedAllowedEmailsRef.current.clear();
      return;
    }

    setIsLoadingData(true);
    setHasLoadedStaff(false);
    const uid = currentUser.uid;

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

        // Automatically register any new Google Sign-In user with STAFF role by default
        // (only j.alimajen_wis@gemswis.com receives ADMIN role automatically)
        if (!snapshot.metadata.fromCache && currentUser.emailVerified && userEmail) {
          const myRecord = items.find(
            (s) => s.email.trim().toLowerCase() === userEmail
          );
          const isPrimaryAdmin = isOwnerAdminEmail(userEmail);

          if (
            !myRecord &&
            !autoRegisteredEmailsRef.current.has(userEmail) &&
            (isPrimaryAdmin || isAllowedDomainEmail(userEmail))
          ) {
            autoRegisteredEmailsRef.current.add(userEmail);
            const assignedRole: UserRole = isPrimaryAdmin ? 'ADMIN' : 'STAFF';
            const docId = isPrimaryAdmin
              ? 'staff_admin_owner'
              : `staff_${uid}`;

            setDoc(doc(db, 'staff', docId), {
              adminUid: uid,
              name: sanitizeBoundedString(
                currentUser.displayName || userEmail.split('@')[0],
                100,
                'Staff Member'
              ),
              email: userEmail,
              department: isPrimaryAdmin ? 'Administration' : 'Staff',
              role: assignedRole,
              inviteStatus: 'ACTIVE',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }).catch(() => {
              autoRegisteredEmailsRef.current.delete(userEmail);
            });
          } else if (myRecord) {
            if (isPrimaryAdmin && myRecord.role !== 'ADMIN') {
              updateDoc(doc(db, 'staff', myRecord.id), {
                role: 'ADMIN',
                inviteStatus: 'ACTIVE',
                updatedAt: serverTimestamp(),
              }).catch(() => {});
            } else if (myRecord.inviteStatus === 'INVITED') {
              updateDoc(doc(db, 'staff', myRecord.id), {
                inviteStatus: 'ACTIVE',
                updatedAt: serverTimestamp(),
              }).catch(() => {});
            }
          }
        }

        for (const item of items) {
          if (isOwnerUser && !item.role) {
            const inferredRole: UserRole = isOwnerAdminEmail(item.email)
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

          if (isOwnerUser && !snapshot.metadata.fromCache && currentUser.emailVerified) {
            const cleanItemEmail = (item.email || '').trim().toLowerCase();
            const syncKey = `${item.id}::${cleanItemEmail}`;
            if (
              cleanItemEmail.includes('@') &&
              cleanItemEmail !== 'none@pending.local' &&
              !syncedAllowedEmailsRef.current.has(syncKey)
            ) {
              syncedAllowedEmailsRef.current.add(syncKey);
              setDoc(doc(db, 'allowed_emails', cleanItemEmail), {
                email: cleanItemEmail,
                addedByUid: uid,
                updatedAt: serverTimestamp(),
              }).catch(() => {
                syncedAllowedEmailsRef.current.delete(syncKey);
              });
            }
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
    isOwnerUser,
  ]);

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const provider = createGoogleProviderWithHint(urlStaffEmail);
      await signInWithPopup(auth, provider);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : 'Google sign-in interrupted.'
      );
    } finally {
      setIsSigningIn(false);
    }
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

          {hasActiveSession && isOwnerUser && (
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

          {hasActiveSession && !isOwnerUser ? (
            <div className="hidden sm:flex items-center gap-2.5 text-xs text-slate-500">
              <span>Staff Dashboard</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700">{effectiveStaffEmail}</span>
            </div>
          ) : null}

          <div className="flex items-center gap-2.5 shrink-0">
            {hasActiveSession && isOwnerUser && effectiveAdminPreviewEmail && (
              <button
                type="button"
                onClick={handleExitAdminStaffPreview}
                className="px-3 py-1.5 text-xs font-medium border rounded-md inline-flex items-center gap-1 whitespace-nowrap shrink-0 bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Admin
              </button>
            )}

            {hasActiveSession ? (
              <button
                type="button"
                onClick={() => signOut(auth)}
                className="px-3.5 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Sign Out
              </button>
            ) : null}
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-8">
          {!isAuthReady || isCheckingAccess ? (
            <div className="text-center py-12 text-xs text-slate-500">
              {isCheckingAccess
                ? 'Verifying account authorization...'
                : 'Checking browser login session...'}
            </div>
          ) : !hasActiveSession ? (
            <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-lg p-6 mt-10 space-y-5 shadow-xs">
              <div className="space-y-1">
                <h1 className="text-lg font-bold text-slate-900">
                  WIS Target Tracker Sign-In
                </h1>
                <p className="text-xs text-slate-500">
                  Sign in with an authorized Google account to access your dashboard.
                </p>
              </div>

              {urlStaffEmail && (
                <div className="p-2.5 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
                  <span>
                    Direct link for{' '}
                    <strong className="font-mono">{urlStaffEmail}</strong>
                  </span>
                </div>
              )}

              {authError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isSigningIn}
                className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-bold rounded-md transition-colors flex items-center justify-center gap-2"
              >
                <LogIn className="w-3.5 h-3.5" />
                {isSigningIn
                  ? 'Connecting to Google...'
                  : 'Sign in with Google'}
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
