import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  CheckCircle2,
  Clock,
  Plus,
  Send,
  Trash2,
  Link2,
  Check,
  ExternalLink,
  UserPlus,
  BookOpen,
  Target as TargetIcon,
  User,
  Calendar,
  Pencil,
  BarChart3,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  Users,
  ClipboardCheck,
  Shield,
  FolderArchive,
  Archive,
  Bookmark,
  Eye,
  AlertTriangle,
  ArrowLeft,
  FolderOpen,
  Lock,
  Unlock,
  Download,
  Layers,
  RotateCcw,
  Search,
  KeyRound,
} from 'lucide-react';
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  orderBy,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { DataSummaryTab } from './DataSummaryTab';
import { exportStudentTargetsPdf } from '../utils/exportStudentTargetsPdf';
import { buildStaffShareLink as buildShareLinkUtil } from '../utils/shareLinks';
import {
  Student,
  Target,
  StaffMember,
  UserRole,
  WeekSetupConfig,
  AcademicArchive,
  AcademicTerm,
  MAX_ACADEMIC_TERMS,
  DEFAULT_ACADEMIC_TERMS,
  DEFAULT_ACADEMIC_YEAR,
  getSavedAcademicTerms,
  saveAcademicTermsToLocal,
  sanitizeAcademicTerms,
  formatTermTitleWithYear,
  extractAcademicYearFromTitle,
  doesTargetMatchTerm,
  TrackingRating,
  isOwnerAdminEmail,
  RATING_METADATA,
  sanitizeBoundedString,
  generateSafeId,
  getDefaultWeekSetupConfig,
  buildWeekScheduleFromOffset,
  getTrackingWeeksList,
  getCurrentWeekKey,
  getUpcomingFridayDeadline,
  getTargetRatingForWeek,
  isTargetTrackedInWeek,
  formatStudentYearAndGroup,
  getStudentMentorName,
  getStudentSchoolTier,
  formatTargetDisplayTitle,
  TargetFontColor,
  normalizeTargetFontColor,
  getTargetFontColorClass,
  groupTargetsHierarchically,
  generateRandomStaffPin,
  isValidStaffPin,
} from '../types';

const COPIED_STAFF_INTENT_KEY = 'targettrack_copied_staff_intent';

function recordCopiedStaffIntent(staffEmail: string) {
  const clean = staffEmail.trim().toLowerCase();
  if (!clean) return;
  try {
    localStorage.setItem(
      COPIED_STAFF_INTENT_KEY,
      JSON.stringify({ email: clean, copiedAt: Date.now() })
    );
  } catch {
    // ignore storage errors
  }
}

const UNASSIGNED_SUBJECT_PLACEHOLDER = 'Unassigned Subject';

interface TargetDraftInput {
  heading: string;
  internalNote: string;
  description: string;
  challenge: string;
  suggestedStrategies: string;
  fontColor: TargetFontColor;
}

const createEmptyTargetDraft = (): TargetDraftInput => ({
  heading: '',
  internalNote: '',
  description: '',
  challenge: '',
  suggestedStrategies: '',
  fontColor: 'black',
});

function copyToClipboardFallback(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.className = 'fixed -left-full top-0 opacity-0 pointer-events-none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

interface AdminOversightProps {
  adminUid: string;
  staffList: StaffMember[];
  students: Student[];
  targets: Target[];
  weekSetup: WeekSetupConfig;
  configuredPublicUrl?: string | null;
  onSaveWeekSetup: (nextSetup: WeekSetupConfig) => Promise<void> | void;
  onOpenStaffSharePreview?: (staffEmail: string) => void;
}

export const AdminOversight: React.FC<AdminOversightProps> = ({
  adminUid,
  staffList,
  students,
  targets,
  weekSetup,
  configuredPublicUrl,
  onSaveWeekSetup,
  onOpenStaffSharePreview,
}) => {
  const [activeTab, setActiveTab] = useState<
    | 'STUDENTS'
    | 'STAFF_OVERVIEW'
    | 'DATA_SUMMARY'
    | 'STAFF_MANAGEMENT'
    | 'ARCHIVES'
  >('STUDENTS');

  const [termsList, setTermsList] = useState<AcademicTerm[]>(() => {
    return Array.isArray(weekSetup.termsList)
      ? weekSetup.termsList.filter((t) => !t.isArchived)
      : getSavedAcademicTerms();
  });

  const [activeAdminTerm, setActiveAdminTerm] = useState<string>(() => {
    return (weekSetup.term ?? termsList[0]?.name ?? '').trim().toUpperCase();
  });

  useEffect(() => {
    if (Array.isArray(weekSetup.termsList)) {
      setTermsList(weekSetup.termsList.filter((t) => !t.isArchived));
    }
  }, [weekSetup.termsList]);

  useEffect(() => {
    if (typeof weekSetup.term === 'string') {
      setActiveAdminTerm(weekSetup.term.trim().toUpperCase());
    }
  }, [weekSetup.term]);

  const currentTerm = activeAdminTerm;
  const currentTermObj =
    termsList.find((t) => t.name === currentTerm) || termsList[0] || null;
  const isCurrentTermLocked = Boolean(currentTermObj?.isLocked);

  // New Term Modal states (up to 3 terms max)
  const [showAddTermModal, setShowAddTermModal] = useState(false);
  const [newTermNameInput, setNewTermNameInput] = useState('');
  const [newTermAcademicYear, setNewTermAcademicYear] = useState(
    DEFAULT_ACADEMIC_YEAR
  );
  const [newTermIsLocked, setNewTermIsLocked] = useState(false);
  const [newTermImportTargets, setNewTermImportTargets] = useState(true);
  const [newTermImportSource, setNewTermImportSource] = useState(currentTerm);
  const [isImportingTargets, setIsImportingTargets] = useState(false);
  const [isRestoringArchiveId, setIsRestoringArchiveId] = useState<string | null>(
    null
  );

  // Quick edit term modal
  const [isEditingTermModal, setIsEditingTermModal] = useState(false);
  const [quickTermInput, setQuickTermInput] = useState(currentTerm);

  // Archive modal & creation states
  const [showArchiveConfirmModal, setShowArchiveConfirmModal] = useState(false);
  const [showArchiveDetailsModal, setShowArchiveDetailsModal] = useState(false);
  const [archiveFolderName, setArchiveFolderName] = useState('');
  const [archiveAcademicYear, setArchiveAcademicYear] = useState('2026-2027');
  const [archiveTerm, setArchiveTerm] = useState(currentTerm);
  const [archiveNotes, setArchiveNotes] = useState('');
  const [isArchiving, setIsArchiving] = useState(false);

  // Archives list and archive contents viewer state
  const [archivesList, setArchivesList] = useState<AcademicArchive[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const cached = localStorage.getItem('targettrack_academic_archives');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [viewingArchive, setViewingArchive] = useState<AcademicArchive | null>(
    null
  );
  const [archiveActiveView, setArchiveActiveView] = useState<
    'DATA_SUMMARY' | 'STUDENTS'
  >('DATA_SUMMARY');
  const [archiveSelectedStudentId, setArchiveSelectedStudentId] = useState<
    string | null
  >(null);

  // Staff Progress Audit filters & week selector
  const [auditWeekOffset, setAuditWeekOffset] = useState<number>(0);
  const [auditStatusFilter, setAuditStatusFilter] = useState<
    'ALL' | 'PENDING' | 'COMPLETE'
  >('ALL');
  const [auditSearchQuery, setAuditSearchQuery] = useState('');

  // Fetch archives from Firestore on mount
  useEffect(() => {
    let isSubscribed = true;
    const fetchArchives = async () => {
      try {
        const q = query(
          collection(db, 'archives'),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        if (!isSubscribed) return;
        const list: AcademicArchive[] = [];
        snap.forEach((d) => {
          list.push(d.data() as AcademicArchive);
        });
        if (list.length > 0) {
          setArchivesList(list);
          try {
            localStorage.setItem(
              'targettrack_academic_archives',
              JSON.stringify(list)
            );
          } catch {}
        }
      } catch {
        // Fallback to local storage cache
      }
    };
    fetchArchives();
    return () => {
      isSubscribed = false;
    };
  }, []);

  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(
    null
  );
  const [studentSearchOrNewName, setStudentSearchOrNewName] = useState('');
  const [newStudentYear, setNewStudentYear] = useState('Year 10 · Group A');
  const [newStudentMentor, setNewStudentMentor] = useState('Ms. Eleanor Vance');
  const [isCreatingStudent, setIsCreatingStudent] = useState(false);
  const [showAddStudentModal, setShowAddStudentModal] = useState(false);
  const [addStudentModalName, setAddStudentModalName] = useState('');
  const [addStudentModalYear, setAddStudentModalYear] = useState('Year 10 · Group A');
  const [addStudentModalMentor, setAddStudentModalMentor] = useState('Ms. Eleanor Vance');
  const [addStudentModalCode, setAddStudentModalCode] = useState('');
  const [pendingDeleteStudent, setPendingDeleteStudent] =
    useState<Student | null>(null);
  const [pendingDeleteStaff, setPendingDeleteStaff] =
    useState<StaffMember | null>(null);
  const [isDeletingRecord, setIsDeletingRecord] = useState(false);

  // Editable Student Profile state (Name, Year and Group, Mentor's Name)
  const [isEditingStudentProfile, setIsEditingStudentProfile] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [editProfileYearGroup, setEditProfileYearGroup] = useState('');
  const [editProfileMentorName, setEditProfileMentorName] = useState('');
  const [isSavingStudentProfile, setIsSavingStudentProfile] = useState(false);

  // Editable Week & Date Setup state (Admin only)
  const [isEditingWeekSetup, setIsEditingWeekSetup] = useState(false);
  const [editWeekNumber, setEditWeekNumber] = useState<number>(
    weekSetup.baseWeekNumber
  );
  const [editMondayIso, setEditMondayIso] = useState<string>(
    weekSetup.baseMondayIso
  );
  const [editFridayIso, setEditFridayIso] = useState<string>(
    weekSetup.baseFridayIso
  );
  const [editTerm, setEditTerm] = useState<string>(currentTerm);

  useEffect(() => {
    setEditWeekNumber(weekSetup.baseWeekNumber);
    setEditMondayIso(weekSetup.baseMondayIso);
    setEditFridayIso(weekSetup.baseFridayIso);
    const syncedTerm = (weekSetup.term || '').trim().toUpperCase();
    setEditTerm(syncedTerm);
    setQuickTermInput(syncedTerm);
  }, [
    weekSetup.baseWeekNumber,
    weekSetup.baseMondayIso,
    weekSetup.baseFridayIso,
    weekSetup.term,
  ]);

  // Student Profile: Add Target(s) Form state (starts with 1 target slot)
  const [showAddTargetForm, setShowAddTargetForm] = useState(false);
  const [targetInputs, setTargetInputs] = useState<TargetDraftInput[]>([
    createEmptyTargetDraft(),
  ]);
  const [isSavingTargets, setIsSavingTargets] = useState(false);

  // Student Profile: Add Sub-Target (+) inline form state
  const [addingSubTargetGroup, setAddingSubTargetGroup] = useState<{
    groupKey: string;
    existingGroupId: string;
    groupNumber: number;
    nextDisplayNumber: string;
    existingTitlesInGroup: string[];
  } | null>(null);
  const [subTargetSharedHeading, setSubTargetSharedHeading] = useState('');
  const [subTargetNote, setSubTargetNote] = useState('');
  const [subTargetDescription, setSubTargetDescription] = useState('');
  const [subTargetChallenge, setSubTargetChallenge] = useState('');
  const [subTargetStrategies, setSubTargetStrategies] = useState('');
  const [subTargetColor, setSubTargetColor] =
    useState<TargetFontColor>('black');
  const [isSavingSubTarget, setIsSavingSubTarget] = useState(false);

  // Inline Edit Target state
  const [editingTargetOldTitle, setEditingTargetOldTitle] = useState<
    string | null
  >(null);
  const [editingTargetNewHeading, setEditingTargetNewHeading] = useState('');
  const [editingTargetNewInternalNote, setEditingTargetNewInternalNote] =
    useState('');
  const [editingTargetNewTitle, setEditingTargetNewTitle] = useState('');
  const [editingTargetNewChallenge, setEditingTargetNewChallenge] = useState('');
  const [
    editingTargetNewSuggestedStrategies,
    setEditingTargetNewSuggestedStrategies,
  ] = useState('');
  const [editingTargetNewColor, setEditingTargetNewColor] =
    useState<TargetFontColor>('black');
  const [inlineNoteDrafts, setInlineNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [openInlineNoteTitles, setOpenInlineNoteTitles] = useState<
    Record<string, boolean>
  >({});
  const [savingInlineNoteTitle, setSavingInlineNoteTitle] = useState<
    string | null
  >(null);
  const [showAddTargetNoteMap, setShowAddTargetNoteMap] = useState<
    Record<number, boolean>
  >({});
  const [showSubTargetNote, setShowSubTargetNote] = useState(false);
  const [showEditTargetNote, setShowEditTargetNote] = useState(false);

  // Student Profile: Add Subject, Teacher & Assign LSA (either from Staff Management or Directly)
  const [showAddSubjectForm, setShowAddSubjectForm] = useState(false);
  const [subjectNameInput, setSubjectNameInput] = useState('');
  const [teacherNameInput, setTeacherNameInput] = useState('');
  const [editingSubjectTeacher, setEditingSubjectTeacher] = useState<{
    subject: string;
    teacherName: string;
  } | null>(null);
  const [isSavingTeacher, setIsSavingTeacher] = useState(false);
  const [staffAssignMode, setStaffAssignMode] = useState<
    'EXISTING' | 'DIRECT_NEW'
  >('EXISTING');
  const [selectedStaffEmail, setSelectedStaffEmail] = useState('');
  const [directStaffName, setDirectStaffName] = useState('');
  const [directStaffEmail, setDirectStaffEmail] = useState('');
  const [selectedApplicableTargets, setSelectedApplicableTargets] = useState<
    Record<string, boolean>
  >({});
  const [isSavingSubject, setIsSavingSubject] = useState(false);

  // Subjects & Assigned Staff collapsed by default (shows only Subject and Tracking Staff until expanded)
  const [expandedSubjects, setExpandedSubjects] = useState<
    Record<string, boolean>
  >({});

  const studentProfileRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setInlineNoteDrafts({});
    setOpenInlineNoteTitles({});
    setSavingInlineNoteTitle(null);
    setShowAddTargetNoteMap({});
    setShowSubTargetNote(false);
    setShowEditTargetNote(false);
  }, [selectedStudentId]);

  const handleCloseStudentProfile = () => {
    setSelectedStudentId(null);
    setIsEditingStudentProfile(false);
    setShowAddTargetForm(false);
    setShowAddSubjectForm(false);
    setAddingSubTargetGroup(null);
    setEditingTargetOldTitle(null);
    setInlineNoteDrafts({});
    setOpenInlineNoteTitles({});
    setShowAddTargetNoteMap({});
    setShowSubTargetNote(false);
    setShowEditTargetNote(false);
    setExpandedSubjects({});
  };

  // Click anywhere outside the Student Profile and student selection buttons to deselect student & close profile
  useEffect(() => {
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!selectedStudentId) return;
      const targetEl = event.target as HTMLElement | null;
      if (!targetEl) return;

      if (
        studentProfileRef.current &&
        studentProfileRef.current.contains(targetEl)
      ) {
        return;
      }
      if (targetEl.closest('[data-student-select="true"]')) {
        return;
      }
      if (targetEl.closest('[data-student-create="true"]')) {
        return;
      }
      if (targetEl.closest('[data-week-setup="true"]')) {
        return;
      }

      handleCloseStudentProfile();
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, [selectedStudentId]);

  // Staff Management Invite Form State
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteDept, setInviteDept] = useState('Mathematics');
  const [inviteRole, setInviteRole] = useState<UserRole>('STAFF');
  const [isInviting, setIsInviting] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [copiedLinkKey, setCopiedLinkKey] = useState<string | null>(null);
  const [expandedLoginDetailsId, setExpandedLoginDetailsId] = useState<string | null>(null);
  const [copiedLoginDetailsId, setCopiedLoginDetailsId] = useState<string | null>(null);

  const currentWeekInfo = useMemo(
    () => buildWeekScheduleFromOffset(0, 0, weekSetup),
    [weekSetup]
  );

  const notify = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((prev) => (prev === msg ? null : prev));
    }, 4500);
  };

  const buildStaffShareLink = (email?: string): string => {
    return buildShareLinkUtil(email, configuredPublicUrl);
  };

  const handleCopyShareLink = async (
    url: string,
    key: string,
    staffName: string,
    staffEmail: string
  ) => {
    recordCopiedStaffIntent(staffEmail);

    // Execute synchronous copy first while transient user activation is active inside the iframe
    let copied = copyToClipboardFallback(url);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Fallback already ran synchronously above
      }
    }

    setCopiedLinkKey(key);
    if (copied) {
      notify(`Copied share link for ${staffName} to clipboard.`);
    } else {
      notify(`Share link generated for ${staffName} below.`);
    }
    setTimeout(() => {
      setCopiedLinkKey((prev) => (prev === key ? null : prev));
    }, 2500);
  };

  // Staff members with role === 'STAFF'
  const assignableStaff = useMemo(
    () =>
      staffList.filter(
        (s) =>
          (s.role ||
            (isOwnerAdminEmail(s.email)
              ? 'ADMIN'
              : 'STAFF')) === 'STAFF'
      ),
    [staffList]
  );

  // Targets filtered by the active academic term
  const currentTermTargets = useMemo(() => {
    if (!currentTerm) return [];
    return targets.filter((t) => doesTargetMatchTerm(t.term, currentTerm));
  }, [targets, currentTerm]);

  // Students Overview Matrix
  const studentRows = useMemo(() => {
    return students.map((student) => {
      const stuTargets = currentTermTargets.filter((t) => t.studentId === student.id);
      const realTargets = stuTargets.filter(
        (t) => t.subject !== UNASSIGNED_SUBJECT_PLACEHOLDER
      );
      const requiredTargets = realTargets.filter((t) => t.trackingRequired);
      const trackedTargets = requiredTargets.filter((t) =>
        isTargetTrackedInWeek(t, currentWeekInfo.weekKey)
      );
      const isComplete =
        requiredTargets.length > 0 &&
        trackedTargets.length === requiredTargets.length;

      return {
        student,
        stuTargets,
        trackedCount: trackedTargets.length,
        requiredCount: requiredTargets.length,
        isComplete,
      };
    });
  }, [students, currentTermTargets, currentWeekInfo.weekKey]);

  const filteredStudentRows = useMemo(() => {
    if (!studentSearchOrNewName.trim()) return studentRows;
    const q = studentSearchOrNewName.trim().toLowerCase();
    return studentRows.filter(
      (r) =>
        r.student.name.toLowerCase().includes(q) ||
        r.student.studentCode.toLowerCase().includes(q) ||
        r.student.yearGroup.toLowerCase().includes(q)
    );
  }, [studentRows, studentSearchOrNewName]);

  const middleSchoolStudentRows = useMemo(() => {
    return filteredStudentRows.filter(
      (r) => getStudentSchoolTier(r.student) === 'MIDDLE'
    );
  }, [filteredStudentRows]);

  const upperSchoolStudentRows = useMemo(() => {
    return filteredStudentRows.filter(
      (r) => getStudentSchoolTier(r.student) === 'UPPER'
    );
  }, [filteredStudentRows]);

  const activeStudentRow = useMemo(() => {
    if (!selectedStudentId) return null;
    return studentRows.find((r) => r.student.id === selectedStudentId) || null;
  }, [studentRows, selectedStudentId]);

  // Unique Active Targets for the selected student (can be >3)
  const activeStudentUniqueTargetTitles = useMemo(() => {
    if (!activeStudentRow) return [];
    const titlesSet = new Set<string>();
    activeStudentRow.stuTargets.forEach((t) => {
      if (t.title.trim()) {
        titlesSet.add(t.title.trim());
      }
    });
    return Array.from(titlesSet);
  }, [activeStudentRow]);

  const activeStudentTargetMetaByTitle = useMemo(() => {
    const metaMap: Record<
      string,
      {
        heading: string;
        targetGroupId: string;
        internalNote: string;
        challenge: string;
        suggestedStrategies: string;
        fontColor: TargetFontColor;
      }
    > = {};
    if (!activeStudentRow) return metaMap;
    for (const t of activeStudentRow.stuTargets) {
      const key = t.title.trim();
      if (!key) continue;
      if (!metaMap[key]) {
        metaMap[key] = {
          heading: (t.heading || '').trim(),
          targetGroupId: (t.targetGroupId || '').trim(),
          internalNote: (t.internalNote || '').trim(),
          challenge: (t.challenge || '').trim(),
          suggestedStrategies: (t.suggestedStrategies || '').trim(),
          fontColor: normalizeTargetFontColor(t.fontColor),
        };
      } else {
        if (!metaMap[key].heading && t.heading?.trim()) {
          metaMap[key].heading = t.heading.trim();
        }
        if (!metaMap[key].targetGroupId && t.targetGroupId?.trim()) {
          metaMap[key].targetGroupId = t.targetGroupId.trim();
        }
        if (!metaMap[key].internalNote && t.internalNote?.trim()) {
          metaMap[key].internalNote = t.internalNote.trim();
        }
        if (!metaMap[key].challenge && t.challenge?.trim()) {
          metaMap[key].challenge = t.challenge.trim();
        }
        if (
          !metaMap[key].suggestedStrategies &&
          t.suggestedStrategies?.trim()
        ) {
          metaMap[key].suggestedStrategies = t.suggestedStrategies.trim();
        }
        if (metaMap[key].fontColor === 'black' && t.fontColor) {
          metaMap[key].fontColor = normalizeTargetFontColor(t.fontColor);
        }
      }
    }
    return metaMap;
  }, [activeStudentRow]);

  const activeStudentGroupedTargets = useMemo(() => {
    return groupTargetsHierarchically(
      activeStudentUniqueTargetTitles.map((title) => ({
        title,
        heading: activeStudentTargetMetaByTitle[title]?.heading || '',
        targetGroupId:
          activeStudentTargetMetaByTitle[title]?.targetGroupId || '',
      }))
    );
  }, [activeStudentUniqueTargetTitles, activeStudentTargetMetaByTitle]);

  // Active Subjects configured on the selected student (with their assigned LSA, Teacher, and target records)
  const activeStudentSubjects = useMemo(() => {
    if (!activeStudentRow) return [];
    const map: Record<
      string,
      {
        subject: string;
        teacherName: string;
        lsaEmail: string;
        lsaName: string;
        staffEmail: string;
        staffName: string;
        targetsByTitle: Record<string, Target>;
      }
    > = {};

    const defaultTeacherMap: Record<string, string> = {
      Mathematics: 'Mrs. Gable',
      'Further Mathematics': 'Mr. Vance',
      English: 'Mr. Foster',
      Science: 'Dr. Aris',
    };

    for (const tgt of activeStudentRow.stuTargets) {
      if (tgt.subject === UNASSIGNED_SUBJECT_PLACEHOLDER) continue;
      if (!map[tgt.subject]) {
        const effectiveLsaEmail = (
          tgt.lsaEmail ||
          tgt.assignedStaffEmail ||
          tgt.subjectStaffEmail ||
          ''
        )
          .trim()
          .toLowerCase();
        const matchedStaff = staffList.find(
          (s) =>
            s.email.trim().toLowerCase() === effectiveLsaEmail
        );
        const resolvedLsaName =
          tgt.lsaName ||
          matchedStaff?.name ||
          (tgt.assignedStaffName !== 'Not Applicable' &&
          tgt.assignedStaffName !== 'Not Assigned'
            ? tgt.assignedStaffName
            : effectiveLsaEmail);
        const resolvedTeacher =
          tgt.teacherName || defaultTeacherMap[tgt.subject] || 'Mr. Harrison';

        map[tgt.subject] = {
          subject: tgt.subject,
          teacherName: resolvedTeacher,
          lsaEmail: effectiveLsaEmail,
          lsaName: resolvedLsaName,
          staffEmail: tgt.subjectStaffEmail,
          staffName: resolvedLsaName,
          targetsByTitle: {},
        };
      }
      map[tgt.subject].targetsByTitle[tgt.title.trim()] = tgt;
    }
    return Object.values(map);
  }, [activeStudentRow, staffList]);

  // Consolidated Rating of the Selected Student per Target (across all applicable subjects)
  const consolidatedTargetRatings = useMemo(() => {
    if (!activeStudentRow) return [];

    return activeStudentGroupedTargets.flatEntries.map((entry, index) => {
      const title = entry.item.title;
      const subjectRatings: Array<{
        subject: string;
        staffName: string;
        rating: TrackingRating;
        score: number | null;
      }> = [];

      let countM = 0;
      let countA = 0;
      let countPA = 0;
      let countWT = 0;
      let countNA = 0;
      let countUntracked = 0;
      let scoredSum = 0;
      let scoredCount = 0;

      for (const subjGroup of activeStudentSubjects) {
        const tgtDoc = subjGroup.targetsByTitle[title];
        if (!tgtDoc || !tgtDoc.trackingRequired) continue;

        const rating = getTargetRatingForWeek(tgtDoc, currentWeekInfo.weekKey);
        let numericScore: number | null = null;

        if (rating === 'M') {
          countM += 1;
          numericScore = 100;
          scoredSum += 100;
          scoredCount += 1;
        } else if (rating === 'A') {
          countA += 1;
          numericScore = 100;
          scoredSum += 100;
          scoredCount += 1;
        } else if (rating === 'PA') {
          countPA += 1;
          numericScore = 70;
          scoredSum += 70;
          scoredCount += 1;
        } else if (rating === 'WT') {
          countWT += 1;
          numericScore = 35;
          scoredSum += 35;
          scoredCount += 1;
        } else if (rating === 'NA') {
          countNA += 1;
          numericScore = null;
        } else {
          countUntracked += 1;
          numericScore = 0;
        }

        subjectRatings.push({
          subject: subjGroup.subject,
          staffName: subjGroup.staffName,
          rating,
          score: numericScore,
        });
      }

      const applicableCount = subjectRatings.length;
      const trackedCount = countM + countA + countPA + countWT + countNA;
      const consolidatedScore =
        scoredCount > 0 ? Math.round(scoredSum / scoredCount) : 0;

      let consolidatedGrade: TrackingRating = 'UNTRACKED';
      if (scoredCount > 0) {
        if (countM > 0 && countPA === 0 && countWT === 0) {
          consolidatedGrade = 'M';
        } else if (consolidatedScore >= 85) {
          consolidatedGrade = 'A';
        } else if (consolidatedScore >= 55) {
          consolidatedGrade = 'PA';
        } else {
          consolidatedGrade = 'WT';
        }
      } else if (countNA > 0 && countUntracked === 0) {
        consolidatedGrade = 'NA';
      }

      const meta = activeStudentTargetMetaByTitle[title] || {
        heading: '',
        targetGroupId: '',
        internalNote: '',
        challenge: '',
        suggestedStrategies: '',
        fontColor: 'black' as TargetFontColor,
      };
      return {
        index: index + 1,
        displayNumber: entry.displayNumber,
        isSubTarget: entry.isSubTarget,
        targetGroupId: meta.targetGroupId,
        title,
        heading: meta.heading,
        challenge: meta.challenge,
        suggestedStrategies: meta.suggestedStrategies,
        fontColor: meta.fontColor,
        applicableCount,
        trackedCount,
        consolidatedScore,
        consolidatedGrade,
        countM,
        countA,
        countPA,
        countWT,
        countNA,
        countUntracked,
        subjectRatings,
      };
    });
  }, [
    activeStudentRow,
    activeStudentGroupedTargets,
    activeStudentSubjects,
    currentWeekInfo.weekKey,
    activeStudentTargetMetaByTitle,
  ]);

  const auditWeeks = useMemo(
    () => getTrackingWeeksList(0, weekSetup),
    [weekSetup]
  );

  const auditWeekInfo = useMemo(
    () => buildWeekScheduleFromOffset(auditWeekOffset, 0, weekSetup),
    [auditWeekOffset, weekSetup]
  );

  // Staff Accountability Matrix (matches StaffDashboard assignment logic + groups by Student & Subject)
  const staffRows = useMemo(() => {
    const studentById = new Map<string, Student>();
    students.forEach((s) => studentById.set(s.id, s));

    // Start with all STAFF members, plus any assigned staff emails present on active targets
    const staffMap = new Map<string, StaffMember>();
    assignableStaff.forEach((st) => {
      const em = st.email.trim().toLowerCase();
      if (em) staffMap.set(em, st);
    });

    for (const tgt of currentTermTargets) {
      if (
        !studentById.has(tgt.studentId) ||
        tgt.subject === UNASSIGNED_SUBJECT_PLACEHOLDER ||
        !tgt.trackingRequired
      ) {
        continue;
      }
      const candidates = [
        tgt.assignedStaffEmail,
        tgt.subjectStaffEmail,
        tgt.lsaEmail,
      ];
      for (const rawEmail of candidates) {
        const em = (rawEmail || '').trim().toLowerCase();
        if (!em || em === 'none' || em === 'none@pending.local') continue;
        if (!staffMap.has(em)) {
          const existingStaff = staffList.find(
            (s) => s.email.trim().toLowerCase() === em
          );
          if (existingStaff) {
            staffMap.set(em, existingStaff);
          } else {
            staffMap.set(em, {
              id: `audit_${em}`,
              adminUid,
              name:
                tgt.lsaName?.trim() ||
                (tgt.assignedStaffName &&
                tgt.assignedStaffName !== 'Not Applicable' &&
                tgt.assignedStaffName !== 'Unassigned'
                  ? tgt.assignedStaffName
                  : em),
              email: em,
              department: tgt.subject || 'General',
              role: 'STAFF',
              inviteStatus: 'ACTIVE',
            });
          }
        }
      }
    }

    const rows = Array.from(staffMap.values()).map((staff) => {
      const normEmail = staff.email.trim().toLowerCase();
      const assignedTargets = currentTermTargets.filter((t) => {
        if (!studentById.has(t.studentId)) return false;
        if (t.subject === UNASSIGNED_SUBJECT_PLACEHOLDER) return false;
        if (!t.trackingRequired) return false;
        const aEmail = (t.assignedStaffEmail || '').trim().toLowerCase();
        const sEmail = (t.subjectStaffEmail || '').trim().toLowerCase();
        const lEmail = (t.lsaEmail || '').trim().toLowerCase();
        return (
          aEmail === normEmail || sEmail === normEmail || lEmail === normEmail
        );
      });

      const byStudentSubject: Record<
        string,
        {
          key: string;
          studentId: string;
          studentName: string;
          yearGroup: string;
          subject: string;
          tracked: number;
          total: number;
        }
      > = {};

      for (const tgt of assignedTargets) {
        const studentObj = studentById.get(tgt.studentId);
        const pairKey = `${tgt.studentId}::${tgt.subject}`;
        if (!byStudentSubject[pairKey]) {
          byStudentSubject[pairKey] = {
            key: pairKey,
            studentId: tgt.studentId,
            studentName: studentObj?.name || tgt.studentName,
            yearGroup: studentObj?.yearGroup || '',
            subject: tgt.subject,
            tracked: 0,
            total: 0,
          };
        }
        byStudentSubject[pairKey].total += 1;
        if (isTargetTrackedInWeek(tgt, auditWeekInfo.weekKey)) {
          byStudentSubject[pairKey].tracked += 1;
        }
      }

      const list = Object.values(byStudentSubject).sort((a, b) => {
        const nameCmp = a.studentName.localeCompare(b.studentName);
        if (nameCmp !== 0) return nameCmp;
        return a.subject.localeCompare(b.subject);
      });

      const trackedStudents = list.filter(
        (s) => s.total > 0 && s.tracked === s.total
      );
      const untrackedStudents = list.filter((s) => s.tracked < s.total);

      const totalTargetsCount = list.reduce((sum, item) => sum + item.total, 0);
      const trackedTargetsCount = list.reduce(
        (sum, item) => sum + item.tracked,
        0
      );
      const untrackedTargetsCount = totalTargetsCount - trackedTargetsCount;
      const completionPct =
        totalTargetsCount > 0
          ? Math.round((trackedTargetsCount / totalTargetsCount) * 100)
          : 0;

      return {
        staff,
        trackedStudents,
        untrackedStudents,
        totalAssignments: list.length,
        totalTargetsCount,
        trackedTargetsCount,
        untrackedTargetsCount,
        completionPct,
        hasAssignments: list.length > 0,
        isAllTracked: list.length > 0 && untrackedStudents.length === 0,
      };
    });

    // Sort: staff with pending tracking first, then all-tracked, then no-assignments
    return rows.sort((a, b) => {
      const rank = (r: typeof a) =>
        r.untrackedStudents.length > 0 ? 0 : r.isAllTracked ? 1 : 2;
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.staff.name.localeCompare(b.staff.name);
    });
  }, [
    assignableStaff,
    staffList,
    students,
    currentTermTargets,
    auditWeekInfo.weekKey,
    adminUid,
  ]);

  const auditSummaryStats = useMemo(() => {
    let allTrackedStaff = 0;
    let pendingStaff = 0;
    let totalTargets = 0;
    let trackedTargets = 0;
    for (const r of staffRows) {
      if (r.isAllTracked) allTrackedStaff += 1;
      if (r.untrackedStudents.length > 0) pendingStaff += 1;
      totalTargets += r.totalTargetsCount;
      trackedTargets += r.trackedTargetsCount;
    }
    return {
      totalStaff: staffRows.length,
      allTrackedStaff,
      pendingStaff,
      totalTargets,
      trackedTargets,
      untrackedTargets: totalTargets - trackedTargets,
    };
  }, [staffRows]);

  const filteredStaffRows = useMemo(() => {
    const q = auditSearchQuery.trim().toLowerCase();
    return staffRows.filter((row) => {
      if (auditStatusFilter === 'PENDING' && row.untrackedStudents.length === 0) {
        return false;
      }
      if (auditStatusFilter === 'COMPLETE' && !row.isAllTracked) {
        return false;
      }
      if (!q) return true;
      const matchesStaff =
        row.staff.name.toLowerCase().includes(q) ||
        row.staff.email.toLowerCase().includes(q) ||
        row.staff.department.toLowerCase().includes(q);
      if (matchesStaff) return true;
      const matchesItems = [
        ...row.trackedStudents,
        ...row.untrackedStudents,
      ].some(
        (item) =>
          item.studentName.toLowerCase().includes(q) ||
          item.subject.toLowerCase().includes(q)
      );
      return matchesItems;
    });
  }, [staffRows, auditStatusFilter, auditSearchQuery]);

  // Helper to send a notification to a staff member about assignment or target changes
  const sendStaffNotification = async (params: {
    recipientEmail: string;
    recipientName: string;
    title: string;
    message: string;
    studentId: string;
    studentName: string;
    subject: string;
  }) => {
    const cleanEmail = params.recipientEmail.trim().toLowerCase();
    if (!cleanEmail || cleanEmail.startsWith('none')) return;

    const notifId = generateSafeId('notif');
    const deadline = getUpcomingFridayDeadline(0, weekSetup);
    await setDoc(doc(db, 'notifications', notifId), {
      adminUid,
      recipientEmail: sanitizeBoundedString(cleanEmail, 120),
      recipientName: sanitizeBoundedString(
        params.recipientName || cleanEmail,
        100
      ),
      type: 'PENDING_ASSIGNMENT',
      title: sanitizeBoundedString(params.title, 140),
      message: sanitizeBoundedString(params.message, 400),
      studentId: params.studentId,
      studentName: sanitizeBoundedString(params.studentName, 100),
      subject: sanitizeBoundedString(params.subject || 'General', 80),
      dueDate: deadline,
      isRead: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  };

  // Handler 1: Write Student Name to Create a New Student Profile
  const handleCreateStudentByName = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = sanitizeBoundedString(studentSearchOrNewName, 100);
    if (!cleanName) return;

    const existing = students.find(
      (s) => s.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (existing) {
      setSelectedStudentId(existing.id);
      setStudentSearchOrNewName('');
      return;
    }

    setIsCreatingStudent(true);
    const studentId = generateSafeId('stu');
    const code = `STU-${Math.floor(100 + Math.random() * 900)}`;

    try {
      await setDoc(doc(db, 'students', studentId), {
        adminUid,
        name: cleanName,
        yearGroup: sanitizeBoundedString(newStudentYear, 40, 'Year 10 · Group A'),
        studentCode: code,
        mentorName: sanitizeBoundedString(
          newStudentMentor,
          100,
          'Ms. Eleanor Vance'
        ),
        subjects: ['General'],
        assignedStaffEmails: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSelectedStudentId(studentId);
      setStudentSearchOrNewName('');
      setShowAddTargetForm(true);
      notify(
        `Created student profile for ${cleanName}. Now click "+ Add Target" to input their targets.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `students/${studentId}`);
    } finally {
      setIsCreatingStudent(false);
    }
  };

  const handleAddStudentFromModal = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = sanitizeBoundedString(addStudentModalName, 100);
    if (!cleanName) return;

    const existing = students.find(
      (s) => s.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (existing) {
      setSelectedStudentId(existing.id);
      setShowAddStudentModal(false);
      setAddStudentModalName('');
      notify(`Student "${existing.name}" already exists.`);
      return;
    }

    setIsCreatingStudent(true);
    const studentId = generateSafeId('stu');
    const cleanCode = sanitizeBoundedString(
      addStudentModalCode.trim() || `STU-${Math.floor(100 + Math.random() * 900)}`,
      30
    );

    try {
      await setDoc(doc(db, 'students', studentId), {
        adminUid,
        name: cleanName,
        yearGroup: sanitizeBoundedString(
          addStudentModalYear,
          40,
          'Year 10 · Group A'
        ),
        studentCode: cleanCode,
        mentorName: sanitizeBoundedString(
          addStudentModalMentor,
          100,
          'Ms. Eleanor Vance'
        ),
        subjects: ['General'],
        assignedStaffEmails: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSelectedStudentId(studentId);
      setShowAddStudentModal(false);
      setAddStudentModalName('');
      setAddStudentModalCode('');
      setShowAddTargetForm(Boolean(currentTermObj));
      notify(`Added student ${cleanName}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `students/${studentId}`);
    } finally {
      setIsCreatingStudent(false);
    }
  };

  // Handler 1B: Edit Student Profile (Name, Year and Group, Mentor's Name)
  const handleStartEditingStudentProfile = (student: Student) => {
    setEditProfileName(student.name);
    setEditProfileYearGroup(formatStudentYearAndGroup(student));
    setEditProfileMentorName(getStudentMentorName(student));
    setIsEditingStudentProfile(true);
  };

  const handleSaveStudentProfile = async (
    e: React.FormEvent,
    student: Student
  ) => {
    e.preventDefault();
    const cleanName = sanitizeBoundedString(editProfileName, 100);
    const cleanYearGroup = sanitizeBoundedString(
      editProfileYearGroup,
      40,
      'Year 10 · Group A'
    );
    const cleanMentor = sanitizeBoundedString(
      editProfileMentorName,
      100,
      'Ms. Eleanor Vance'
    );
    if (!cleanName) return;

    setIsSavingStudentProfile(true);
    try {
      await updateDoc(doc(db, 'students', student.id), {
        name: cleanName,
        yearGroup: cleanYearGroup,
        mentorName: cleanMentor,
        updatedAt: serverTimestamp(),
      });

      if (cleanName !== student.name) {
        const stuTargets = targets.filter((t) => t.studentId === student.id);
        for (const tgt of stuTargets) {
          await updateDoc(doc(db, 'targets', tgt.id), {
            studentName: cleanName,
            updatedAt: serverTimestamp(),
          });
        }
      }

      setIsEditingStudentProfile(false);
      notify(`Updated student profile for ${cleanName}.`);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `students/${student.id}`
      );
    } finally {
      setIsSavingStudentProfile(false);
    }
  };

  const persistTermsConfig = async (
    nextTerms: AcademicTerm[],
    nextActiveTerm: string,
    overrideWeekSetup?: Partial<WeekSetupConfig>
  ) => {
    const cleanTerms = sanitizeAcademicTerms(nextTerms, true);
    setTermsList(cleanTerms);
    saveAcademicTermsToLocal(cleanTerms);

    const matchedTerm = cleanTerms.find((t) => t.name === nextActiveTerm) || cleanTerms[0] || null;
    const resolvedActiveName = matchedTerm ? matchedTerm.name : '';
    const nextIsLocked = matchedTerm ? Boolean(matchedTerm.isLocked) : false;

    const mergedWeekSetup: WeekSetupConfig = {
      baseWeekNumber:
        overrideWeekSetup?.baseWeekNumber ?? weekSetup.baseWeekNumber,
      baseMondayIso:
        overrideWeekSetup?.baseMondayIso ?? weekSetup.baseMondayIso,
      baseFridayIso:
        overrideWeekSetup?.baseFridayIso ?? weekSetup.baseFridayIso,
      term: resolvedActiveName,
      termsList: cleanTerms,
      isTermLocked: nextIsLocked,
    };

    await onSaveWeekSetup(mergedWeekSetup);

    try {
      await setDoc(
        doc(db, 'settings', 'terms_config'),
        {
          terms: cleanTerms,
          activeTerm: resolvedActiveName,
          baseWeekNumber: mergedWeekSetup.baseWeekNumber,
          baseMondayIso: mergedWeekSetup.baseMondayIso,
          baseFridayIso: mergedWeekSetup.baseFridayIso,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      console.error('Failed to sync settings/terms_config:', error);
      notify('Could not sync term settings to server. Please try again.');
    }

    window.dispatchEvent(
      new CustomEvent('targettrack-terms-updated', {
        detail: { termsList: cleanTerms, activeTerm: resolvedActiveName },
      })
    );

    return cleanTerms;
  };

  const handleSaveQuickTerm = async (newTerm?: string) => {
    const rawTerm = typeof newTerm === 'string' ? newTerm : quickTermInput;
    const fallbackYear = extractAcademicYearFromTitle(
      currentTerm || DEFAULT_ACADEMIC_YEAR
    );
    const cleanTerm = formatTermTitleWithYear(rawTerm, fallbackYear);
    const oldTerm = currentTerm;

    const updatedTerms = termsList.map((t) => {
      if (t.name === oldTerm) {
        return {
          ...t,
          name: cleanTerm,
          academicYear: extractAcademicYearFromTitle(cleanTerm),
        };
      }
      return t;
    });

    setActiveAdminTerm(cleanTerm);

    if (oldTerm !== cleanTerm) {
      const oldTermTargets = targets.filter((t) =>
        doesTargetMatchTerm(t.term, oldTerm)
      );
      for (const tgt of oldTermTargets) {
        try {
          await updateDoc(doc(db, 'targets', tgt.id), {
            term: cleanTerm,
            updatedAt: serverTimestamp(),
          });
        } catch {
          // continue
        }
      }
    }

    await persistTermsConfig(updatedTerms, cleanTerm);
    setIsEditingTermModal(false);
    notify(`Term renamed to ${cleanTerm}.`);
  };

  const handleSelectAdminTerm = async (selectedTermName: string) => {
    setActiveAdminTerm(selectedTermName);
    await persistTermsConfig(termsList, selectedTermName);
  };

  const handleToggleTermLock = async (termNameToToggle: string) => {
    const updatedTerms = termsList.map((t) => {
      if (t.name === termNameToToggle) {
        return { ...t, isLocked: !t.isLocked };
      }
      return t;
    });

    const targetObj = updatedTerms.find((t) => t.name === termNameToToggle);
    const nowLocked = targetObj ? targetObj.isLocked : false;

    await persistTermsConfig(updatedTerms, activeAdminTerm);

    notify(
      nowLocked
        ? `${termNameToToggle} locked.`
        : `${termNameToToggle} unlocked.`
    );
  };

  const handleCreateNewTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (termsList.length >= MAX_ACADEMIC_TERMS) {
      notify('Maximum 3 terms allowed.');
      return;
    }
    const cleanBase = sanitizeBoundedString(
      newTermNameInput.toUpperCase(),
      30
    ).trim();
    if (!cleanBase) {
      notify('Enter a valid term name.');
      return;
    }
    const cleanName = formatTermTitleWithYear(cleanBase, newTermAcademicYear);
    if (termsList.some((t) => t.name.toUpperCase() === cleanName)) {
      notify(`"${cleanName}" already exists.`);
      return;
    }

    const newTerm: AcademicTerm = {
      id: `term-${Date.now()}`,
      name: cleanName,
      academicYear: extractAcademicYearFromTitle(cleanName),
      isLocked: newTermIsLocked,
      isArchived: false,
      createdAt: new Date().toISOString(),
    };

    const updatedTerms = [...termsList, newTerm];
    setActiveAdminTerm(cleanName);

    await persistTermsConfig(updatedTerms, cleanName);
    setShowAddTermModal(false);

    if (newTermImportTargets && newTermImportSource) {
      await executeImportTargets(newTermImportSource, cleanName);
    } else {
      notify(
        `Created ${cleanName} (${newTermIsLocked ? 'Locked' : 'Unlocked'}).`
      );
    }
  };

  const executeImportTargets = async (
    sourceTerm: string,
    targetTerm: string
  ) => {
    if (sourceTerm === targetTerm) {
      notify('Source and target terms must be different.');
      return;
    }
    setIsImportingTargets(true);
    try {
      const sourceTargets = targets.filter((t) =>
        doesTargetMatchTerm(t.term, sourceTerm)
      );
      if (sourceTargets.length === 0) {
        notify(`No targets in ${sourceTerm} to import.`);
        setIsImportingTargets(false);
        return;
      }

      const existingInTarget = targets.filter((t) =>
        doesTargetMatchTerm(t.term, targetTerm)
      );

      const weekKey = getCurrentWeekKey(0, weekSetup);
      const deadline = getUpcomingFridayDeadline(0, weekSetup);

      let importedCount = 0;
      for (const src of sourceTargets) {
        const alreadyExists = existingInTarget.some(
          (ex) =>
            ex.studentId === src.studentId &&
            ex.subject === src.subject &&
            ex.title.trim().toLowerCase() === src.title.trim().toLowerCase()
        );
        if (alreadyExists) continue;

        const newTargetId = generateSafeId('tgt');
        await setDoc(doc(db, 'targets', newTargetId), {
          adminUid,
          studentId: src.studentId,
          studentName: src.studentName,
          subject: src.subject,
          targetGroupId: src.targetGroupId || '',
          heading: src.heading || '',
          title: src.title,
          challenge: src.challenge || '',
          suggestedStrategies: src.suggestedStrategies || '',
          internalNote: src.internalNote || '',
          fontColor: normalizeTargetFontColor(src.fontColor),
          trackingRequired: src.trackingRequired,
          assignedStaffEmail: src.assignedStaffEmail || 'none',
          assignedStaffName: src.assignedStaffName || 'Unassigned',
          subjectStaffEmail:
            src.subjectStaffEmail || src.assignedStaffEmail || 'none@pending.local',
          teacherName: src.teacherName || 'Class Teacher',
          lsaName: src.lsaName || src.assignedStaffName || '',
          lsaEmail: src.lsaEmail || src.assignedStaffEmail || '',
          term: targetTerm,
          currentWeekStatus: 'UNTRACKED',
          currentWeekKey: weekKey,
          progressScore: 0,
          weeklyHistorySummary: '',
          lastTrackedByEmail: 'none',
          deadlineDate: deadline,
          notes: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        importedCount++;
      }

      notify(
        `Imported ${importedCount} targets from ${sourceTerm} to ${targetTerm}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'targets');
    } finally {
      setIsImportingTargets(false);
    }
  };

  const handleSaveWeekAndDateSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editMondayIso || !editFridayIso) return;
    const nextWeekNum = Math.max(
      1,
      Math.min(520, Math.round(Number(editWeekNumber) || 1))
    );
    const cleanTerm = editTerm.trim()
      ? formatTermTitleWithYear(
          editTerm,
          extractAcademicYearFromTitle(currentTerm || DEFAULT_ACADEMIC_YEAR)
        )
      : currentTerm;
    const updatedTerms = cleanTerm
      ? termsList.some((t) => t.name === cleanTerm)
        ? termsList
        : termsList.map((t) =>
            t.name === currentTerm
              ? {
                  ...t,
                  name: cleanTerm,
                  academicYear: extractAcademicYearFromTitle(cleanTerm),
                }
              : t
          )
      : termsList;
    setActiveAdminTerm(cleanTerm);
    await persistTermsConfig(updatedTerms, cleanTerm, {
      baseWeekNumber: nextWeekNum,
      baseMondayIso: editMondayIso,
      baseFridayIso: editFridayIso,
    });
    setIsEditingWeekSetup(false);
    notify(
      `Updated to Week ${nextWeekNum} (${editMondayIso} to ${editFridayIso})${cleanTerm ? ` · ${cleanTerm}` : ''}.`
    );
  };

  const handleCreateArchiveAndResetTracking = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const finalFolder = archiveFolderName.trim();
    if (!finalFolder) {
      notify('Enter a folder name.');
      return;
    }

    setIsArchiving(true);
    try {
      const now = new Date();
      const archiveId = `arch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const safeAcademicYear = archiveAcademicYear.trim() || DEFAULT_ACADEMIC_YEAR;
      const safeTerm = formatTermTitleWithYear(
        archiveTerm.trim() || currentTerm || 'TERM 1',
        safeAcademicYear
      );

      const termScopedTargets = targets.filter((t) =>
        doesTargetMatchTerm(t.term, safeTerm)
      );
      const targetsToArchive =
        termScopedTargets.length > 0 ? termScopedTargets : targets;

      let currentRemarks = '';
      try {
        currentRemarks =
          localStorage.getItem(
            'targettrack_data_summary_overall_cohort_remarks'
          ) || '';
      } catch {}

      const archiveRecord: AcademicArchive = {
        id: archiveId,
        adminUid,
        folderName: finalFolder,
        academicYear: safeAcademicYear,
        term: safeTerm,
        archivedAt: now.toISOString(),
        archivedAtLabel: now.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        dateRangeLabel: currentWeekInfo.rangeLabel,
        weekRangeText: `Week ${currentWeekInfo.weekNumber}`,
        totalStudents: students.length,
        totalTargets: targetsToArchive.length,
        notes: archiveNotes.trim(),
        studentsSnapshot: JSON.parse(JSON.stringify(students)),
        targetsSnapshot: JSON.parse(JSON.stringify(targetsToArchive)),
        overallRemarksSnapshot: currentRemarks,
        weekSetupSnapshot: JSON.parse(JSON.stringify(weekSetup)),
      };

      // 1. Save archive record in Firestore
      try {
        await setDoc(doc(db, 'archives', archiveId), {
          ...archiveRecord,
          createdAt: serverTimestamp(),
        });
      } catch {
        // Continue even if Firestore throws
      }

      // 2. Save in localStorage cache
      const nextList = [
        archiveRecord,
        ...archivesList.filter((a) => a.id !== archiveId),
      ];
      setArchivesList(nextList);
      try {
        localStorage.setItem(
          'targettrack_academic_archives',
          JSON.stringify(nextList)
        );
      } catch {}

      // 3. Totally remove the archived term from active terms
      const remainingTerms = termsList.filter(
        (t) =>
          t.name !== safeTerm &&
          t.name !== (archiveTerm.trim() || '').toUpperCase() &&
          t.name !== currentTerm
      );
      const nextActiveTerm = remainingTerms[0]?.name || '';
      setActiveAdminTerm(nextActiveTerm);
      await persistTermsConfig(remainingTerms, nextActiveTerm);

      // 4. Reset target tracking for the archived scope while keeping student profiles and targets intact
      const resetPromises = targetsToArchive.map((t) => {
        return updateDoc(doc(db, 'targets', t.id), {
          currentWeekStatus: 'UNTRACKED',
          progressScore: 0,
          weeklyHistorySummary: '',
          lastTrackedByEmail: 'none',
          notes: '',
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      });
      await Promise.all(resetPromises);

      // 5. Clear overall remarks for new term
      try {
        localStorage.removeItem(
          'targettrack_data_summary_overall_cohort_remarks'
        );
      } catch {}

      setShowArchiveDetailsModal(false);
      setShowArchiveConfirmModal(false);
      setViewingArchive(archiveRecord);
      setArchiveActiveView('DATA_SUMMARY');
      setActiveTab('ARCHIVES');
      notify(`Archived "${safeTerm}" to "${finalFolder}".`);
    } catch {
      notify('Failed to archive data. Check connection.');
    } finally {
      setIsArchiving(false);
    }
  };

  const handleRestoreArchivedTerm = async (archive: AcademicArchive) => {
    const restoredTermName = formatTermTitleWithYear(
      archive.term,
      archive.academicYear
    );
    const alreadyExists = termsList.some(
      (t) => t.name.toUpperCase() === restoredTermName
    );
    if (!alreadyExists && termsList.length >= MAX_ACADEMIC_TERMS) {
      notify('Maximum 3 active terms reached. Archive a term first.');
      return;
    }

    setIsRestoringArchiveId(archive.id);
    try {
      const nextTerms = alreadyExists
        ? termsList
        : [
            ...termsList,
            {
              id: `term-${Date.now()}`,
              name: restoredTermName,
              academicYear: extractAcademicYearFromTitle(restoredTermName),
              isLocked: false,
              isArchived: false,
              createdAt: new Date().toISOString(),
            },
          ];

      // Restore targets & ratings from the archive snapshot
      for (const snapTgt of archive.targetsSnapshot || []) {
        const existsInLive = targets.some((t) => t.id === snapTgt.id);
        const safeLastTracked =
          snapTgt.lastTrackedByEmail && snapTgt.lastTrackedByEmail.trim()
            ? snapTgt.lastTrackedByEmail.trim()
            : 'none';

        if (existsInLive) {
          await updateDoc(doc(db, 'targets', snapTgt.id), {
            term: restoredTermName,
            targetGroupId: snapTgt.targetGroupId || '',
            heading: snapTgt.heading || '',
            challenge: snapTgt.challenge || '',
            suggestedStrategies: snapTgt.suggestedStrategies || '',
            internalNote: snapTgt.internalNote || '',
            fontColor: normalizeTargetFontColor(snapTgt.fontColor),
            currentWeekStatus: snapTgt.currentWeekStatus || 'UNTRACKED',
            currentWeekKey:
              snapTgt.currentWeekKey || getCurrentWeekKey(0, weekSetup),
            progressScore: Number.isFinite(snapTgt.progressScore)
              ? Math.round(snapTgt.progressScore)
              : 0,
            weeklyHistorySummary: snapTgt.weeklyHistorySummary || '',
            lastTrackedByEmail: safeLastTracked,
            notes: snapTgt.notes || '',
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        } else {
          await setDoc(doc(db, 'targets', snapTgt.id), {
            adminUid,
            studentId: snapTgt.studentId,
            studentName: snapTgt.studentName,
            subject: snapTgt.subject,
            targetGroupId: snapTgt.targetGroupId || '',
            heading: snapTgt.heading || '',
            title: snapTgt.title,
            challenge: snapTgt.challenge || '',
            suggestedStrategies: snapTgt.suggestedStrategies || '',
            internalNote: snapTgt.internalNote || '',
            fontColor: normalizeTargetFontColor(snapTgt.fontColor),
            trackingRequired: Boolean(snapTgt.trackingRequired),
            assignedStaffEmail: snapTgt.assignedStaffEmail || 'none',
            assignedStaffName: snapTgt.assignedStaffName || 'Unassigned',
            subjectStaffEmail:
              snapTgt.subjectStaffEmail ||
              snapTgt.assignedStaffEmail ||
              'none@pending.local',
            teacherName: snapTgt.teacherName || 'Class Teacher',
            lsaName: snapTgt.lsaName || snapTgt.assignedStaffName || '',
            lsaEmail: snapTgt.lsaEmail || snapTgt.assignedStaffEmail || '',
            term: restoredTermName,
            currentWeekStatus: snapTgt.currentWeekStatus || 'UNTRACKED',
            currentWeekKey:
              snapTgt.currentWeekKey || getCurrentWeekKey(0, weekSetup),
            progressScore: Number.isFinite(snapTgt.progressScore)
              ? Math.round(snapTgt.progressScore)
              : 0,
            weeklyHistorySummary: snapTgt.weeklyHistorySummary || '',
            lastTrackedByEmail: safeLastTracked,
            deadlineDate:
              snapTgt.deadlineDate || getUpcomingFridayDeadline(0, weekSetup),
            notes: snapTgt.notes || '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        }
      }

      setActiveAdminTerm(restoredTermName);
      await persistTermsConfig(nextTerms, restoredTermName);
      setViewingArchive(null);
      setActiveTab('STUDENTS');
      notify(`Restored ${restoredTermName}.`);
    } finally {
      setIsRestoringArchiveId(null);
    }
  };

  const handleDeleteArchive = async (archiveId: string) => {
    if (
      !window.confirm(
        'Are you sure you want to delete this archived folder? This operation cannot be undone.'
      )
    ) {
      return;
    }
    try {
      await deleteDoc(doc(db, 'archives', archiveId)).catch(() => {});
      const next = archivesList.filter((a) => a.id !== archiveId);
      setArchivesList(next);
      try {
        localStorage.setItem(
          'targettrack_academic_archives',
          JSON.stringify(next)
        );
      } catch {}
      if (viewingArchive?.id === archiveId) {
        setViewingArchive(null);
      }
      notify('Archived folder deleted.');
    } catch {
      notify('Could not delete archived folder.');
    }
  };

  // Handler 2: Save 1 or more Targets (can be >3) on the Student Profile
  const handleSaveTargetsForStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStudentRow) return;
    if (!currentTermObj || !currentTerm) {
      notify('Add or restore a term first.');
      return;
    }
    const student = activeStudentRow.student;

    const validDrafts: Array<{
      heading: string;
      internalNote: string;
      title: string;
      challenge: string;
      suggestedStrategies: string;
      fontColor: TargetFontColor;
    }> = [];
    const seenTitles = new Set<string>();
    for (const draft of targetInputs) {
      const cleanDesc = (draft.description || '').trim();
      if (!cleanDesc) continue;
      const lower = cleanDesc.toLowerCase();
      if (seenTitles.has(lower)) continue;
      seenTitles.add(lower);
      validDrafts.push({
        heading: (draft.heading || '').trim(),
        internalNote: (draft.internalNote || '').trim(),
        title: cleanDesc,
        challenge: (draft.challenge || '').trim(),
        suggestedStrategies: (draft.suggestedStrategies || '').trim(),
        fontColor: normalizeTargetFontColor(draft.fontColor),
      });
    }
    if (validDrafts.length === 0) return;

    setIsSavingTargets(true);
    const weekKey = getCurrentWeekKey(0, weekSetup);
    const deadline = getUpcomingFridayDeadline(0, weekSetup);

    try {
      if (activeStudentSubjects.length === 0) {
        for (const item of validDrafts) {
          const alreadyExists = activeStudentUniqueTargetTitles.some(
            (existingTitle) =>
              existingTitle.toLowerCase() === item.title.toLowerCase()
          );
          if (alreadyExists) continue;

          const targetId = generateSafeId('tgt');
          await setDoc(doc(db, 'targets', targetId), {
            adminUid,
            studentId: student.id,
            studentName: student.name,
            subject: UNASSIGNED_SUBJECT_PLACEHOLDER,
            heading: item.heading,
            internalNote: item.internalNote,
            title: item.title,
            challenge: item.challenge,
            suggestedStrategies: item.suggestedStrategies,
            fontColor: item.fontColor,
            trackingRequired: false,
            assignedStaffEmail: 'none',
            assignedStaffName: 'Unassigned',
            subjectStaffEmail: 'none@pending.local',
            term: currentTerm,
            currentWeekStatus: 'UNTRACKED',
            currentWeekKey: weekKey,
            progressScore: 0,
            weeklyHistorySummary: '',
            lastTrackedByEmail: 'none',
            deadlineDate: deadline,
            notes: '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } else {
        for (const item of validDrafts) {
          for (const subjGroup of activeStudentSubjects) {
            if (subjGroup.targetsByTitle[item.title]) continue;
            const targetId = generateSafeId('tgt');
            await setDoc(doc(db, 'targets', targetId), {
              adminUid,
              studentId: student.id,
              studentName: student.name,
              subject: subjGroup.subject,
              heading: item.heading,
              internalNote: item.internalNote,
              title: item.title,
              challenge: item.challenge,
              suggestedStrategies: item.suggestedStrategies,
              fontColor: item.fontColor,
              trackingRequired: true,
              assignedStaffEmail: subjGroup.staffEmail,
              assignedStaffName: subjGroup.staffName,
              subjectStaffEmail: subjGroup.staffEmail,
              term: currentTerm,
              currentWeekStatus: 'UNTRACKED',
              currentWeekKey: weekKey,
              progressScore: 0,
              weeklyHistorySummary: '',
              lastTrackedByEmail: 'none',
              deadlineDate: deadline,
              notes: '',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        }

        // Notify assigned staff members about the new target changes
        for (const subjGroup of activeStudentSubjects) {
          await sendStaffNotification({
            recipientEmail: subjGroup.staffEmail,
            recipientName: subjGroup.staffName,
            title: `Target Changes for ${student.name} (${subjGroup.subject})`,
            message: `${validDrafts.length} new target(s) added to ${student.name}'s profile: "${validDrafts.map((d) => d.title).join('; ')}".`,
            studentId: student.id,
            studentName: student.name,
            subject: subjGroup.subject,
          });
        }
      }

      setTargetInputs([createEmptyTargetDraft()]);
      setShowAddTargetNoteMap({});
      setShowAddTargetForm(false);
      if (activeStudentSubjects.length === 0) {
        const defaultChecked: Record<string, boolean> = {};
        [
          ...activeStudentUniqueTargetTitles,
          ...validDrafts.map((d) => d.title),
        ].forEach((t) => {
          defaultChecked[t] = true;
        });
        setSelectedApplicableTargets(defaultChecked);
        setShowAddSubjectForm(true);
      }
      notify(
        `Saved ${validDrafts.length} target(s) for ${student.name}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'targets');
    } finally {
      setIsSavingTargets(false);
    }
  };

  // Handler 2A: Save a new Sub-Target (e.g. 1.2, 1.3) under a single Target Group & Shared Title
  const handleSaveSubTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStudentRow || !addingSubTargetGroup) return;
    if (!currentTermObj || !currentTerm) {
      notify('Add or restore a term first.');
      return;
    }

    const cleanDesc = (subTargetDescription || '').trim();
    if (!cleanDesc) return;

    const alreadyExists = activeStudentUniqueTargetTitles.some(
      (existingTitle) =>
        existingTitle.toLowerCase() === cleanDesc.toLowerCase()
    );
    if (alreadyExists) {
      notify('A target with this exact description already exists.');
      return;
    }

    const student = activeStudentRow.student;
    const cleanHeading = (subTargetSharedHeading || '').trim();
    const cleanNote = (subTargetNote || '').trim();
    const cleanChallenge = (subTargetChallenge || '').trim();
    const cleanStrategies = (subTargetStrategies || '').trim();
    const cleanColor = normalizeTargetFontColor(subTargetColor);
    const resolvedGroupId =
      addingSubTargetGroup.existingGroupId || generateSafeId('grp');

    setIsSavingSubTarget(true);
    const weekKey = getCurrentWeekKey(0, weekSetup);
    const deadline = getUpcomingFridayDeadline(0, weekSetup);

    try {
      // 1. Tag all existing target docs in this group with the shared targetGroupId & shared heading
      const existingDocsInGroup = targets.filter(
        (t) =>
          t.studentId === student.id &&
          (!currentTerm || doesTargetMatchTerm(t.term, currentTerm)) &&
          addingSubTargetGroup.existingTitlesInGroup.includes(t.title.trim())
      );

      for (const existingDoc of existingDocsInGroup) {
        await updateDoc(doc(db, 'targets', existingDoc.id), {
          targetGroupId: resolvedGroupId,
          heading: cleanHeading,
          updatedAt: serverTimestamp(),
        });
      }

      // 2. Create the new sub-target across all active subjects (or Unassigned placeholder if none)
      if (activeStudentSubjects.length === 0) {
        const targetId = generateSafeId('tgt');
        await setDoc(doc(db, 'targets', targetId), {
          adminUid,
          studentId: student.id,
          studentName: student.name,
          subject: UNASSIGNED_SUBJECT_PLACEHOLDER,
          targetGroupId: resolvedGroupId,
          heading: cleanHeading,
          internalNote: cleanNote,
          title: cleanDesc,
          challenge: cleanChallenge,
          suggestedStrategies: cleanStrategies,
          fontColor: cleanColor,
          trackingRequired: false,
          assignedStaffEmail: 'none',
          assignedStaffName: 'Unassigned',
          subjectStaffEmail: 'none@pending.local',
          term: currentTerm,
          currentWeekStatus: 'UNTRACKED',
          currentWeekKey: weekKey,
          progressScore: 0,
          weeklyHistorySummary: '',
          lastTrackedByEmail: 'none',
          deadlineDate: deadline,
          notes: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        for (const subjGroup of activeStudentSubjects) {
          const targetId = generateSafeId('tgt');
          await setDoc(doc(db, 'targets', targetId), {
            adminUid,
            studentId: student.id,
            studentName: student.name,
            subject: subjGroup.subject,
            targetGroupId: resolvedGroupId,
            heading: cleanHeading,
            internalNote: cleanNote,
            title: cleanDesc,
            challenge: cleanChallenge,
            suggestedStrategies: cleanStrategies,
            fontColor: cleanColor,
            trackingRequired: true,
            assignedStaffEmail: subjGroup.staffEmail,
            assignedStaffName: subjGroup.staffName,
            subjectStaffEmail: subjGroup.staffEmail,
            term: currentTerm,
            currentWeekStatus: 'UNTRACKED',
            currentWeekKey: weekKey,
            progressScore: 0,
            weeklyHistorySummary: '',
            lastTrackedByEmail: 'none',
            deadlineDate: deadline,
            notes: '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await sendStaffNotification({
            recipientEmail: subjGroup.staffEmail,
            recipientName: subjGroup.staffName,
            title: `Sub-Target ${addingSubTargetGroup.nextDisplayNumber} Added for ${student.name} (${subjGroup.subject})`,
            message: `Sub-target ${addingSubTargetGroup.nextDisplayNumber} added: "${cleanDesc}".`,
            studentId: student.id,
            studentName: student.name,
            subject: subjGroup.subject,
          });
        }
      }

      setAddingSubTargetGroup(null);
      setSubTargetSharedHeading('');
      setSubTargetNote('');
      setShowSubTargetNote(false);
      setSubTargetDescription('');
      setSubTargetChallenge('');
      setSubTargetStrategies('');
      setSubTargetColor('black');
      notify(
        `Added sub-target ${addingSubTargetGroup.nextDisplayNumber} for ${student.name}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'targets');
    } finally {
      setIsSavingSubTarget(false);
    }
  };

  // Handler 2B: Edit / Rename an Active Target (Heading, Note, Description, Challenge, Color)
  const handleSaveEditedTargetTitle = async (
    student: Student,
    oldTitle: string
  ) => {
    const cleanNew = (editingTargetNewTitle || '').trim();
    if (!cleanNew) {
      setEditingTargetOldTitle(null);
      return;
    }
    const cleanHeading = (editingTargetNewHeading || '').trim();
    const cleanInternalNote = (editingTargetNewInternalNote || '').trim();
    const cleanChallenge = (editingTargetNewChallenge || '').trim();
    const cleanSuggestedStrategies = (
      editingTargetNewSuggestedStrategies || ''
    ).trim();
    const cleanColor = normalizeTargetFontColor(editingTargetNewColor);

    const matchingDocs = targets.filter(
      (t) =>
        t.studentId === student.id &&
        t.title.trim() === oldTitle &&
        (!currentTerm || doesTargetMatchTerm(t.term, currentTerm))
    );
    const groupId = matchingDocs.find((d) => (d.targetGroupId || '').trim())
      ?.targetGroupId?.trim();

    try {
      for (const docItem of matchingDocs) {
        await updateDoc(doc(db, 'targets', docItem.id), {
          heading: cleanHeading,
          internalNote: cleanInternalNote,
          title: cleanNew,
          challenge: cleanChallenge,
          suggestedStrategies: cleanSuggestedStrategies,
          fontColor: cleanColor,
          updatedAt: serverTimestamp(),
        });
      }

      // Keep shared heading consistent across sibling sub-targets in the same group
      if (groupId) {
        const siblingDocs = targets.filter(
          (t) =>
            t.studentId === student.id &&
            t.title.trim() !== oldTitle &&
            (t.targetGroupId || '').trim() === groupId &&
            (!currentTerm || doesTargetMatchTerm(t.term, currentTerm))
        );
        for (const sibDoc of siblingDocs) {
          if ((sibDoc.heading || '').trim() !== cleanHeading) {
            await updateDoc(doc(db, 'targets', sibDoc.id), {
              heading: cleanHeading,
              updatedAt: serverTimestamp(),
            });
          }
        }
      }

      if (cleanNew !== oldTitle) {
        for (const subjGroup of activeStudentSubjects) {
          await sendStaffNotification({
            recipientEmail: subjGroup.staffEmail,
            recipientName: subjGroup.staffName,
            title: `Target Updated for ${student.name} (${subjGroup.subject})`,
            message: `Target changed from "${oldTitle}" to "${cleanNew}".`,
            studentId: student.id,
            studentName: student.name,
            subject: subjGroup.subject,
          });
        }
      }

      setEditingTargetOldTitle(null);
      setEditingTargetNewHeading('');
      setEditingTargetNewInternalNote('');
      setShowEditTargetNote(false);
      setEditingTargetNewTitle('');
      setEditingTargetNewChallenge('');
      setEditingTargetNewSuggestedStrategies('');
      setEditingTargetNewColor('black');
      notify(`Updated target for ${student.name}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    }
  };

  // Handler 2C: Quick change font color of a target across all subject rows for that student
  const handleUpdateTargetColor = async (
    student: Student,
    targetTitle: string,
    nextColor: TargetFontColor
  ) => {
    const matchingDocs = targets.filter(
      (t) =>
        t.studentId === student.id &&
        t.title.trim() === targetTitle &&
        (!currentTerm || doesTargetMatchTerm(t.term, currentTerm))
    );
    try {
      for (const docItem of matchingDocs) {
        await updateDoc(doc(db, 'targets', docItem.id), {
          fontColor: nextColor,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    }
  };

  // Handler 2D: Save internal red note for an individual target or sub-target
  const handleSaveTargetInlineNote = async (
    student: Student,
    targetTitle: string,
    rawNote: string
  ) => {
    const cleanNote = rawNote.trim();
    const existingSaved =
      activeStudentTargetMetaByTitle[targetTitle]?.internalNote || '';
    if (cleanNote === existingSaved) {
      setInlineNoteDrafts((prev) => {
        if (!(targetTitle in prev)) return prev;
        const copy = { ...prev };
        delete copy[targetTitle];
        return copy;
      });
      setOpenInlineNoteTitles((prev) => {
        if (!(targetTitle in prev)) return prev;
        const copy = { ...prev };
        delete copy[targetTitle];
        return copy;
      });
      return;
    }

    const matchingDocs = targets.filter(
      (t) =>
        t.studentId === student.id &&
        t.title.trim() === targetTitle &&
        (!currentTerm || doesTargetMatchTerm(t.term, currentTerm))
    );
    setSavingInlineNoteTitle(targetTitle);
    try {
      for (const docItem of matchingDocs) {
        await updateDoc(doc(db, 'targets', docItem.id), {
          internalNote: cleanNote,
          updatedAt: serverTimestamp(),
        });
      }
      setInlineNoteDrafts((prev) => {
        const copy = { ...prev };
        delete copy[targetTitle];
        return copy;
      });
      setOpenInlineNoteTitles((prev) => {
        const copy = { ...prev };
        delete copy[targetTitle];
        return copy;
      });
      notify(cleanNote ? 'Saved internal target note.' : 'Cleared target note.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    } finally {
      setSavingInlineNoteTitle((prev) => (prev === targetTitle ? null : prev));
    }
  };

  // Handler 3: Add a Subject to the Student Profile, Assign Staff (Existing or Direct New), and Select Which Targets Apply
  const handleSaveSubjectForStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStudentRow) return;
    if (!currentTermObj || !currentTerm) {
      notify('Add or restore a term first.');
      return;
    }
    const student = activeStudentRow.student;

    const cleanSubject = sanitizeBoundedString(subjectNameInput, 80);
    if (!cleanSubject) return;

    let finalStaffEmail = '';
    let finalStaffName = '';

    setIsSavingSubject(true);
    const weekKey = getCurrentWeekKey(0, weekSetup);
    const deadline = getUpcomingFridayDeadline(0, weekSetup);

    const cleanTeacher = sanitizeBoundedString(teacherNameInput, 100);

    try {
      if (staffAssignMode === 'DIRECT_NEW') {
        const cleanDirectName = sanitizeBoundedString(directStaffName, 100);
        const cleanDirectEmail = sanitizeBoundedString(
          directStaffEmail.toLowerCase(),
          120
        );
        if (!cleanDirectName || !cleanDirectEmail.includes('@')) {
          setIsSavingSubject(false);
          return;
        }
        finalStaffEmail = cleanDirectEmail;
        finalStaffName = cleanDirectName;

        const existingStaff = staffList.find(
          (s) => s.email.trim().toLowerCase() === cleanDirectEmail
        );
        if (!existingStaff) {
          const newStaffId = generateSafeId('staff');
          await setDoc(doc(db, 'staff', newStaffId), {
            adminUid,
            name: cleanDirectName,
            email: cleanDirectEmail,
            department: cleanSubject,
            role: 'STAFF',
            inviteStatus: 'INVITED',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } else {
        const chosenEmail = (
          selectedStaffEmail ||
          assignableStaff[0]?.email ||
          ''
        )
          .trim()
          .toLowerCase();
        const matched = staffList.find(
          (s) => s.email.trim().toLowerCase() === chosenEmail
        );
        if (!chosenEmail) {
          setIsSavingSubject(false);
          return;
        }
        finalStaffEmail = chosenEmail;
        finalStaffName = matched?.name || chosenEmail;
      }

      const realExistingSubjects = student.subjects.filter(
        (s) => s !== 'General' && s !== UNASSIGNED_SUBJECT_PLACEHOLDER
      );
      const updatedSubjects = Array.from(
        new Set([...realExistingSubjects, cleanSubject])
      ).slice(0, 10);
      const updatedStaffEmails = Array.from(
        new Set([...student.assignedStaffEmails, finalStaffEmail])
      ).slice(0, 20);

      await updateDoc(doc(db, 'students', student.id), {
        name: student.name,
        yearGroup: student.yearGroup,
        studentCode: student.studentCode,
        subjects: updatedSubjects.length > 0 ? updatedSubjects : [cleanSubject],
        assignedStaffEmails: updatedStaffEmails,
        updatedAt: serverTimestamp(),
      });

      const titlesToLink =
        activeStudentUniqueTargetTitles.length > 0
          ? activeStudentUniqueTargetTitles
          : ['General Subject Target'];

      let applicableCount = 0;
      for (const title of titlesToLink) {
        const isApplicable =
          selectedApplicableTargets[title] !== undefined
            ? selectedApplicableTargets[title]
            : true;
        if (isApplicable) applicableCount += 1;

        const meta = activeStudentTargetMetaByTitle[title];
        const targetId = generateSafeId('tgt');
        await setDoc(doc(db, 'targets', targetId), {
          adminUid,
          studentId: student.id,
          studentName: student.name,
          subject: cleanSubject,
          targetGroupId: meta?.targetGroupId || '',
          heading: meta?.heading || '',
          internalNote: meta?.internalNote || '',
          title,
          challenge: meta?.challenge || '',
          suggestedStrategies: meta?.suggestedStrategies || '',
          fontColor: meta?.fontColor || 'black',
          trackingRequired: isApplicable,
          assignedStaffEmail: isApplicable ? finalStaffEmail : 'none',
          assignedStaffName: isApplicable ? finalStaffName : 'Not Applicable',
          subjectStaffEmail: finalStaffEmail,
          teacherName: cleanTeacher || 'Class Teacher',
          lsaName: finalStaffName,
          lsaEmail: finalStaffEmail,
          term: currentTerm,
          currentWeekStatus: 'UNTRACKED',
          currentWeekKey: weekKey,
          progressScore: 0,
          weeklyHistorySummary: '',
          lastTrackedByEmail: 'none',
          deadlineDate: deadline,
          notes: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const placeholderDocs = activeStudentRow.stuTargets.filter(
        (t) => t.subject === UNASSIGNED_SUBJECT_PLACEHOLDER
      );
      for (const pDoc of placeholderDocs) {
        await deleteDoc(doc(db, 'targets', pDoc.id));
      }

      await sendStaffNotification({
        recipientEmail: finalStaffEmail,
        recipientName: finalStaffName,
        title: `Assigned as LSA for ${student.name} (${cleanSubject})`,
        message: `You were assigned as LSA to track ${student.name} in ${cleanSubject} (Teacher: ${cleanTeacher || 'N/A'}; ${applicableCount} of ${titlesToLink.length} target(s) applicable).`,
        studentId: student.id,
        studentName: student.name,
        subject: cleanSubject,
      });

      setSubjectNameInput('');
      setTeacherNameInput('');
      setDirectStaffName('');
      setDirectStaffEmail('');
      setShowAddSubjectForm(false);
      notify(
        `Added subject "${cleanSubject}" (Teacher: ${cleanTeacher || 'Class Teacher'}) tracked by LSA ${finalStaffName}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'targets');
    } finally {
      setIsSavingSubject(false);
    }
  };

  // Handler 3B: Update / Edit Teacher name for an existing subject on the student profile
  const handleSaveSubjectTeacher = async (
    student: Student,
    subjectName: string,
    newTeacherName: string
  ) => {
    const cleanTeacher = sanitizeBoundedString(newTeacherName, 100);
    setIsSavingTeacher(true);
    const subjectTargets = targets.filter(
      (t) => t.studentId === student.id && t.subject === subjectName
    );

    try {
      for (const tgt of subjectTargets) {
        await updateDoc(doc(db, 'targets', tgt.id), {
          teacherName: cleanTeacher,
          updatedAt: serverTimestamp(),
        });
      }
      setEditingSubjectTeacher(null);
      notify(
        `Updated teacher for ${student.name} (${subjectName}) to "${cleanTeacher || 'Not Set'}".`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    } finally {
      setIsSavingTeacher(false);
    }
  };

  // Handler 4: Toggle whether a specific Active Target is applicable to a specific Subject
  const handleToggleTargetApplicableInSubject = async (
    student: Student,
    subjectGroup: {
      subject: string;
      staffEmail: string;
      staffName: string;
      targetsByTitle: Record<string, Target>;
    },
    targetTitle: string
  ) => {
    const existingTarget = subjectGroup.targetsByTitle[targetTitle];
    if (existingTarget) {
      const nextApplicable = !existingTarget.trackingRequired;
      const path = `targets/${existingTarget.id}`;
      try {
        await updateDoc(doc(db, 'targets', existingTarget.id), {
          trackingRequired: nextApplicable,
          assignedStaffEmail: nextApplicable
            ? subjectGroup.staffEmail
            : 'none',
          assignedStaffName: nextApplicable
            ? subjectGroup.staffName
            : 'Not Applicable',
          updatedAt: serverTimestamp(),
        });

        await sendStaffNotification({
          recipientEmail: subjectGroup.staffEmail,
          recipientName: subjectGroup.staffName,
          title: `Target Applicability Changed: ${student.name} (${subjectGroup.subject})`,
          message: `Target "${targetTitle}" is now ${
            nextApplicable
              ? 'Applicable (Required to Track)'
              : 'Not Applicable (Disabled)'
          } in ${subjectGroup.subject}.`,
          studentId: student.id,
          studentName: student.name,
          subject: subjectGroup.subject,
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
    } else {
      if (!currentTermObj || !currentTerm) {
        notify('Add or restore a term first.');
        return;
      }
      const meta = activeStudentTargetMetaByTitle[targetTitle];
      const targetId = generateSafeId('tgt');
      try {
        await setDoc(doc(db, 'targets', targetId), {
          adminUid,
          studentId: student.id,
          studentName: student.name,
          subject: subjectGroup.subject,
          targetGroupId: meta?.targetGroupId || '',
          heading: meta?.heading || '',
          internalNote: meta?.internalNote || '',
          title: targetTitle,
          challenge: meta?.challenge || '',
          suggestedStrategies: meta?.suggestedStrategies || '',
          fontColor: meta?.fontColor || 'black',
          trackingRequired: true,
          assignedStaffEmail: subjectGroup.staffEmail,
          assignedStaffName: subjectGroup.staffName,
          subjectStaffEmail: subjectGroup.staffEmail,
          term: currentTerm,
          currentWeekStatus: 'UNTRACKED',
          currentWeekKey: getCurrentWeekKey(0, weekSetup),
          progressScore: 0,
          weeklyHistorySummary: '',
          lastTrackedByEmail: 'none',
          deadlineDate: getUpcomingFridayDeadline(0, weekSetup),
          notes: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await sendStaffNotification({
          recipientEmail: subjectGroup.staffEmail,
          recipientName: subjectGroup.staffName,
          title: `Target Added to ${subjectGroup.subject}: ${student.name}`,
          message: `Target "${targetTitle}" is now applicable in ${subjectGroup.subject}.`,
          studentId: student.id,
          studentName: student.name,
          subject: subjectGroup.subject,
        });
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.CREATE,
          `targets/${targetId}`
        );
      }
    }
  };

  // Handler 5: Change the Staff Member assigned to a Student's Subject
  const handleChangeSubjectStaff = async (
    student: Student,
    subjectName: string,
    newStaffEmail: string
  ) => {
    const cleanEmail = newStaffEmail.trim().toLowerCase();
    const matchedStaff = staffList.find(
      (s) => s.email.trim().toLowerCase() === cleanEmail
    );
    if (!matchedStaff) return;

    const subjectTargets = targets.filter(
      (t) => t.studentId === student.id && t.subject === subjectName
    );

    try {
      const subjectTargetIds = new Set(subjectTargets.map((t) => t.id));
      const activeEmailsOnStudent = new Set<string>([cleanEmail]);
      for (const t of targets) {
        if (t.studentId !== student.id) continue;
        if (t.subject === UNASSIGNED_SUBJECT_PLACEHOLDER) continue;
        if (subjectTargetIds.has(t.id)) continue;
        const em = (
          (t.lsaEmail &&
          t.lsaEmail !== 'none' &&
          t.lsaEmail !== 'none@pending.local'
            ? t.lsaEmail
            : '') ||
          (t.subjectStaffEmail &&
          t.subjectStaffEmail !== 'none' &&
          t.subjectStaffEmail !== 'none@pending.local'
            ? t.subjectStaffEmail
            : '') ||
          (t.assignedStaffEmail && t.assignedStaffEmail !== 'none'
            ? t.assignedStaffEmail
            : '')
        )
          .trim()
          .toLowerCase();
        if (em) activeEmailsOnStudent.add(em);
      }
      const updatedStaffEmails = Array.from(activeEmailsOnStudent).slice(0, 20);

      await updateDoc(doc(db, 'students', student.id), {
        assignedStaffEmails: updatedStaffEmails,
        updatedAt: serverTimestamp(),
      });

      for (const tgt of subjectTargets) {
        await updateDoc(doc(db, 'targets', tgt.id), {
          subjectStaffEmail: cleanEmail,
          lsaEmail: cleanEmail,
          lsaName: matchedStaff.name,
          assignedStaffEmail: tgt.trackingRequired ? cleanEmail : 'none',
          assignedStaffName: tgt.trackingRequired
            ? matchedStaff.name
            : 'Not Applicable',
          updatedAt: serverTimestamp(),
        });
      }

      await sendStaffNotification({
        recipientEmail: cleanEmail,
        recipientName: matchedStaff.name,
        title: `Assigned as LSA for ${student.name} (${subjectName})`,
        message: `You have been assigned as LSA to track ${student.name}'s weekly targets in ${subjectName}.`,
        studentId: student.id,
        studentName: student.name,
        subject: subjectName,
      });

      notify(
        `Assigned LSA ${matchedStaff.name} to track ${subjectName} for ${student.name} and sent notification.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    }
  };

  // Handler 6: Delete an Active Target across the Student Profile
  const handleDeleteActiveTargetTitle = async (
    student: Student,
    titleToRemove: string
  ) => {
    const matching = targets.filter(
      (t) =>
        t.studentId === student.id &&
        t.title.trim() === titleToRemove &&
        (!currentTerm || doesTargetMatchTerm(t.term, currentTerm))
    );
    try {
      for (const item of matching) {
        await deleteDoc(doc(db, 'targets', item.id));
      }

      for (const subjGroup of activeStudentSubjects) {
        await sendStaffNotification({
          recipientEmail: subjGroup.staffEmail,
          recipientName: subjGroup.staffName,
          title: `Target Removed for ${student.name} (${subjGroup.subject})`,
          message: `Target "${titleToRemove}" was removed from ${student.name}'s profile.`,
          studentId: student.id,
          studentName: student.name,
          subject: subjGroup.subject,
        });
      }

      notify('Removed target from student profile and notified assigned staff.');
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'targets');
    }
  };

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = sanitizeBoundedString(inviteName, 100);
    const cleanEmail = sanitizeBoundedString(inviteEmail.toLowerCase(), 120);
    const cleanDept = sanitizeBoundedString(inviteDept, 80, 'General');
    if (!cleanName || !cleanEmail.includes('@')) return;

    setIsInviting(true);
    const staffId = generateSafeId('staff');
    const notifId = generateSafeId('notif');
    const deadline = getUpcomingFridayDeadline(0, weekSetup);
    const shareUrl = buildStaffShareLink(cleanEmail);
    const assignedPin = generateRandomStaffPin();

    try {
      await setDoc(doc(db, 'staff', staffId), {
        adminUid,
        name: cleanName,
        email: cleanEmail,
        department: cleanDept,
        role: inviteRole,
        inviteStatus: 'INVITED',
        pin: assignedPin,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await setDoc(doc(db, 'notifications', notifId), {
        adminUid,
        recipientEmail: cleanEmail,
        recipientName: cleanName,
        type: 'INVITATION',
        title: `Invited as ${inviteRole}: ${cleanDept}`,
        message: `Use ${cleanEmail} and your 4-digit PIN to sign in to your ${
          inviteRole === 'ADMIN' ? 'Administrator' : 'Staff'
        } account.`,
        studentId: 'all',
        studentName: 'All Assigned Students',
        subject: cleanDept,
        dueDate: deadline,
        isRead: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      recordCopiedStaffIntent(cleanEmail);
      copyToClipboardFallback(shareUrl);
      setInviteName('');
      setInviteEmail('');
      notify(`Invited ${cleanName} (${cleanEmail}) with 4-digit PIN ${assignedPin}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `staff/${staffId}`);
    } finally {
      setIsInviting(false);
    }
  };

  const handleToggleViewLoginDetails = async (staff: StaffMember) => {
    const nextExpanded = expandedLoginDetailsId === staff.id ? null : staff.id;
    setExpandedLoginDetailsId(nextExpanded);
    if (nextExpanded && !isValidStaffPin(staff.pin)) {
      const assignedPin = generateRandomStaffPin();
      try {
        await updateDoc(doc(db, 'staff', staff.id), {
          pin: assignedPin,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `staff/${staff.id}`);
      }
    }
  };

  const handleUpdateUserRole = async (staff: StaffMember, newRole: UserRole) => {
    const path = `staff/${staff.id}`;
    try {
      await updateDoc(doc(db, 'staff', staff.id), {
        name: staff.name,
        email: staff.email,
        department: staff.department,
        role: newRole,
        inviteStatus: staff.inviteStatus || 'INVITED',
        updatedAt: serverTimestamp(),
      });
      notify(`Updated ${staff.name}'s role to ${newRole}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  };

  const handleConfirmDeleteStudent = async () => {
    if (!pendingDeleteStudent) return;
    const targetStudent = pendingDeleteStudent;
    setIsDeletingRecord(true);
    try {
      const studentTargets = targets.filter(
        (t) => t.studentId === targetStudent.id
      );
      for (const tgt of studentTargets) {
        await deleteDoc(doc(db, 'targets', tgt.id));
      }

      try {
        const notifSnap = await getDocs(
          query(
            collection(db, 'notifications'),
            where('studentId', '==', targetStudent.id)
          )
        );
        for (const nDoc of notifSnap.docs) {
          await deleteDoc(doc(db, 'notifications', nDoc.id));
        }
      } catch {
        // Non-blocking notification cleanup
      }

      await deleteDoc(doc(db, 'students', targetStudent.id));

      if (selectedStudentId === targetStudent.id) {
        setSelectedStudentId(null);
        setIsEditingStudentProfile(false);
        setShowAddTargetForm(false);
        setShowAddSubjectForm(false);
      }
      setPendingDeleteStudent(null);
      notify(`Deleted student ${targetStudent.name}.`);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `students/${targetStudent.id}`
      );
    } finally {
      setIsDeletingRecord(false);
    }
  };

  const handleConfirmDeleteStaff = async () => {
    if (!pendingDeleteStaff) return;
    const targetStaff = pendingDeleteStaff;
    const staffEmailLower = targetStaff.email.trim().toLowerCase();
    setIsDeletingRecord(true);
    try {
      const affectedTargets = targets.filter(
        (t) =>
          t.assignedStaffEmail.trim().toLowerCase() === staffEmailLower ||
          t.subjectStaffEmail.trim().toLowerCase() === staffEmailLower ||
          (t.lsaEmail || '').trim().toLowerCase() === staffEmailLower
      );
      for (const tgt of affectedTargets) {
        const updates: Record<string, unknown> = {
          updatedAt: serverTimestamp(),
        };
        if (tgt.assignedStaffEmail.trim().toLowerCase() === staffEmailLower) {
          updates.assignedStaffEmail = 'none';
          updates.assignedStaffName = 'Unassigned';
        }
        if (tgt.subjectStaffEmail.trim().toLowerCase() === staffEmailLower) {
          updates.subjectStaffEmail = 'none@pending.local';
        }
        if ((tgt.lsaEmail || '').trim().toLowerCase() === staffEmailLower) {
          updates.lsaEmail = 'none@pending.local';
          updates.lsaName = 'Not Assigned';
        }
        await updateDoc(doc(db, 'targets', tgt.id), updates);
      }

      const affectedStudents = students.filter((s) =>
        s.assignedStaffEmails.some(
          (em) => em.trim().toLowerCase() === staffEmailLower
        )
      );
      for (const stu of affectedStudents) {
        await updateDoc(doc(db, 'students', stu.id), {
          assignedStaffEmails: stu.assignedStaffEmails.filter(
            (em) => em.trim().toLowerCase() !== staffEmailLower
          ),
          updatedAt: serverTimestamp(),
        });
      }

      try {
        const notifSnap = await getDocs(
          query(
            collection(db, 'notifications'),
            where('recipientEmail', '==', staffEmailLower)
          )
        );
        for (const nDoc of notifSnap.docs) {
          await deleteDoc(doc(db, 'notifications', nDoc.id));
        }
      } catch {
        // Non-blocking notification cleanup
      }

      await deleteDoc(doc(db, 'staff', targetStaff.id));
      setPendingDeleteStaff(null);
      notify(`Deleted ${targetStaff.name}.`);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `staff/${targetStaff.id}`
      );
    } finally {
      setIsDeletingRecord(false);
    }
  };

  const handleSendReminder = async (
    staff: StaffMember,
    untrackedStudents: Array<{
      studentId: string;
      studentName: string;
      subject: string;
    }>
  ) => {
    if (untrackedStudents.length === 0) return;
    const notifId = generateSafeId('notif');
    const deadline = getUpcomingFridayDeadline(auditWeekOffset, weekSetup);
    const names = untrackedStudents
      .map((s) => `${s.studentName} (${s.subject})`)
      .join(', ');

    try {
      await setDoc(doc(db, 'notifications', notifId), {
        adminUid,
        recipientEmail: staff.email.toLowerCase(),
        recipientName: staff.name,
        type: 'ADMIN_REMINDER',
        title: 'Pending Weekly Student Target Tracking',
        message: `Please track targets for: ${names} before ${deadline}.`,
        studentId: untrackedStudents[0].studentId,
        studentName: untrackedStudents[0].studentName,
        subject: untrackedStudents[0].subject,
        dueDate: deadline,
        isRead: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      notify(`Reminder sent to ${staff.name} (${staff.email}).`);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.CREATE,
        `notifications/${notifId}`
      );
    }
  };

    const isDark = false;

    return (
      <div className="space-y-6 text-slate-900">
        {/* Minimalist Admin Sub-Navigation */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200 transition-colors">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-black tracking-tight text-slate-900">
                Administrator Portal
              </h1>
              <button
                type="button"
                data-week-setup="true"
                onClick={() => setIsEditingWeekSetup((prev) => !prev)}
                className="inline-flex items-center gap-1.5 text-xs font-mono font-bold px-3 py-1.5 rounded-lg transition-all bg-slate-900 hover:bg-slate-800 text-white shadow-xs"
                title="Click to edit Week Number & Dates (Admin only)"
              >
                <Calendar className="w-3.5 h-3.5 text-slate-300" />
                <span>
                  Week {currentWeekInfo.weekNumber} ({currentWeekInfo.rangeLabel})
                </span>
                <Pencil className="w-3 h-3 text-slate-300" />
              </button>
              {/* Academic Term Switcher Tabs (up to 3 active terms) */}
              <div className="inline-flex items-center gap-1 bg-amber-50 border border-amber-300 p-1 rounded-xl shadow-xs">
                {termsList.map((t) => {
                  const isSelected = t.name === currentTerm;
                  return (
                    <div
                      key={t.id || t.name}
                      className="inline-flex items-center rounded-lg overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectAdminTerm(t.name)}
                        className={`px-2.5 py-1.5 text-xs font-mono font-black uppercase transition-all inline-flex items-center gap-1.5 ${
                          isSelected
                            ? 'bg-amber-400 text-slate-950 shadow-xs ring-1 ring-amber-500'
                            : 'text-amber-950 hover:bg-amber-100 font-bold'
                        }`}
                        title={`${t.name} (${t.isLocked ? 'Locked' : 'Unlocked'})`}
                      >
                        {t.isLocked ? (
                          <Lock className="w-3.5 h-3.5 text-amber-900 shrink-0" />
                        ) : (
                          <Unlock className="w-3.5 h-3.5 text-emerald-800 shrink-0" />
                        )}
                        <span>{t.name}</span>
                      </button>
                      {isSelected && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuickTermInput(t.name);
                            setIsEditingTermModal(true);
                          }}
                          className="px-1.5 py-1.5 bg-amber-400 hover:bg-amber-500 text-slate-950 transition-colors"
                          title="Rename term"
                        >
                          <Pencil className="w-3 h-3 text-slate-800" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* Add Term Button (Max 3 terms) */}
                {termsList.length < MAX_ACADEMIC_TERMS ? (
                  <button
                    type="button"
                    onClick={() => {
                      const fallbackYear = currentTerm
                        ? extractAcademicYearFromTitle(currentTerm)
                        : DEFAULT_ACADEMIC_YEAR;
                      setNewTermNameInput(`TERM ${termsList.length + 1}`);
                      setNewTermAcademicYear(fallbackYear);
                      setNewTermIsLocked(false);
                      setNewTermImportTargets(termsList.length > 0);
                      setNewTermImportSource(currentTerm || termsList[0]?.name || '');
                      setShowAddTermModal(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-lg bg-amber-200/80 hover:bg-amber-300 text-amber-950 transition-colors border border-amber-300"
                    title="Add term (up to 3)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Term</span>
                  </button>
                ) : (
                  <span
                    className="text-[10px] font-bold text-amber-800 px-2 py-1 select-none"
                    title="Max 3 terms"
                  >
                    (3/3 Max)
                  </span>
                )}
              </div>

              {/* Lock / Unlock & Archive Controls (when an active term exists) */}
              {currentTermObj && (
                <>
                  <button
                    type="button"
                    onClick={() => handleToggleTermLock(currentTerm)}
                    className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg shadow-xs transition-all border ${
                      isCurrentTermLocked
                        ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600 ring-1 ring-amber-400'
                        : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 ring-1 ring-emerald-500'
                    }`}
                    title={
                      isCurrentTermLocked
                        ? `Unlock ${currentTerm}`
                        : `Lock ${currentTerm}`
                    }
                  >
                    {isCurrentTermLocked ? (
                      <>
                        <Lock className="w-3.5 h-3.5" />
                        <span>{currentTerm}: Locked</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-3.5 h-3.5" />
                        <span>{currentTerm}: Unlocked</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const yr = extractAcademicYearFromTitle(currentTerm);
                      setArchiveAcademicYear(yr);
                      setArchiveTerm(currentTerm);
                      setArchiveFolderName(`${currentTerm} Snapshot`);
                      setShowArchiveConfirmModal(true);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs"
                    title="Archive term and reset tracking"
                  >
                    <FolderArchive className="w-3.5 h-3.5 text-indigo-200" />
                    <span>Archive Data</span>
                  </button>
                </>
              )}
            </div>
          </div>

        {/* HIGH-VISIBILITY MAIN ADMIN TABS */}
        <div
          className={`flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl border shadow-sm transition-colors ${
            isDark
              ? 'bg-slate-900 border-slate-800'
              : 'bg-slate-200/90 border-slate-300'
          }`}
        >
          <button
            type="button"
            onClick={() => setActiveTab('STUDENTS')}
            className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'STUDENTS'
                ? isDark
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/60 ring-1 ring-indigo-400 font-extrabold'
                  : 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900 font-extrabold'
                : isDark
                ? 'text-slate-300 hover:text-white hover:bg-slate-800/90 font-semibold'
                : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Students &amp; Targets</span>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full ${
                activeTab === 'STUDENTS'
                  ? isDark
                    ? 'bg-indigo-700/80 text-white'
                    : 'bg-slate-800 text-white'
                  : isDark
                  ? 'bg-slate-800 text-slate-300'
                  : 'bg-slate-300/80 text-slate-800'
              }`}
            >
              {students.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('STAFF_OVERVIEW')}
            className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'STAFF_OVERVIEW'
                ? isDark
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/60 ring-1 ring-indigo-400 font-extrabold'
                  : 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900 font-extrabold'
                : isDark
                ? 'text-slate-300 hover:text-white hover:bg-slate-800/90 font-semibold'
                : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Staff Progress Audit</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('DATA_SUMMARY')}
            className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'DATA_SUMMARY'
                ? isDark
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/60 ring-1 ring-indigo-400 font-extrabold'
                  : 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900 font-extrabold'
                : isDark
                ? 'text-slate-300 hover:text-white hover:bg-slate-800/90 font-semibold'
                : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>Data Summary</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('STAFF_MANAGEMENT')}
            className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'STAFF_MANAGEMENT'
                ? isDark
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/60 ring-1 ring-indigo-400 font-extrabold'
                  : 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900 font-extrabold'
                : isDark
                ? 'text-slate-300 hover:text-white hover:bg-slate-800/90 font-semibold'
                : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            <span>Staff Management &amp; Links</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('ARCHIVES')}
            className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'ARCHIVES'
                ? isDark
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/60 ring-1 ring-indigo-400 font-extrabold'
                  : 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900 font-extrabold'
                : isDark
                ? 'text-slate-300 hover:text-white hover:bg-slate-800/90 font-semibold'
                : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
            }`}
          >
            <FolderArchive className="w-4 h-4" />
            <span>Archived Folders</span>
            {archivesList.length > 0 && (
              <span
                className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full ${
                  activeTab === 'ARCHIVES'
                    ? isDark
                      ? 'bg-indigo-700/80 text-white'
                      : 'bg-slate-800 text-white'
                    : isDark
                    ? 'bg-slate-800 text-slate-300'
                    : 'bg-slate-300/80 text-slate-800'
                }`}
              >
                {archivesList.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {isEditingWeekSetup && (
        <form
          data-week-setup="true"
          onSubmit={handleSaveWeekAndDateSetup}
          className={`${
            isDark
              ? 'bg-slate-900 border-slate-800 text-slate-100 shadow-md'
              : 'bg-slate-100 border-slate-300 text-slate-900'
          } border rounded-lg p-4 space-y-3 transition-colors`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span
                className={`text-xs font-bold ${
                  isDark ? 'text-white' : 'text-slate-900'
                }`}
              >
                Week Number &amp; Monday–Friday Dates
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  const prevWeek = buildWeekScheduleFromOffset(-1, -1, weekSetup);
                  setEditWeekNumber(prevWeek.weekNumber);
                  setEditMondayIso(prevWeek.mondayIso);
                  setEditFridayIso(prevWeek.fridayIso);
                  await persistTermsConfig(termsList, currentTerm, {
                    baseWeekNumber: prevWeek.weekNumber,
                    baseMondayIso: prevWeek.mondayIso,
                    baseFridayIso: prevWeek.fridayIso,
                  });
                  notify(
                    `Week ${prevWeek.weekNumber} (${prevWeek.rangeLabel}).`
                  );
                }}
                className={`text-[11px] font-semibold rounded px-2.5 py-1 border transition-colors ${
                  isDark
                    ? 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700'
                    : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                ← Prev Week
              </button>
              <button
                type="button"
                onClick={async () => {
                  const def = getDefaultWeekSetupConfig();
                  setEditWeekNumber(def.baseWeekNumber);
                  setEditMondayIso(def.baseMondayIso);
                  setEditFridayIso(def.baseFridayIso);
                  await persistTermsConfig(termsList, currentTerm, {
                    baseWeekNumber: def.baseWeekNumber,
                    baseMondayIso: def.baseMondayIso,
                    baseFridayIso: def.baseFridayIso,
                  });
                  setIsEditingWeekSetup(false);
                  notify(`Reset to Week ${def.baseWeekNumber}.`);
                }}
                className={`text-[11px] font-semibold rounded px-2.5 py-1 border transition-colors ${
                  isDark
                    ? 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700'
                    : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                Reset Today
              </button>
              <button
                type="button"
                onClick={async () => {
                  const nextWeek = buildWeekScheduleFromOffset(1, 1, weekSetup);
                  setEditWeekNumber(nextWeek.weekNumber);
                  setEditMondayIso(nextWeek.mondayIso);
                  setEditFridayIso(nextWeek.fridayIso);
                  await persistTermsConfig(termsList, currentTerm, {
                    baseWeekNumber: nextWeek.weekNumber,
                    baseMondayIso: nextWeek.mondayIso,
                    baseFridayIso: nextWeek.fridayIso,
                  });
                  notify(
                    `Week ${nextWeek.weekNumber} (${nextWeek.rangeLabel}).`
                  );
                }}
                className={`text-[11px] font-semibold rounded px-2.5 py-1 border transition-colors ${
                  isDark
                    ? 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700'
                    : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
                }`}
              >
                Next Week →
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label
                className={`block text-[11px] font-semibold mb-1 ${
                  isDark ? 'text-slate-300' : 'text-slate-700'
                }`}
              >
                Academic Term (ALL CAPS)
              </label>
              <input
                type="text"
                required
                value={editTerm}
                onChange={(e) => setEditTerm(e.target.value.toUpperCase())}
                placeholder="e.g. TERM 1"
                className={`w-full text-xs border rounded px-2.5 py-1.5 font-mono font-bold uppercase ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white'
                    : 'bg-white border-slate-300 text-slate-900'
                }`}
              />
            </div>
            <div>
              <label
                className={`block text-[11px] font-semibold mb-1 ${
                  isDark ? 'text-slate-300' : 'text-slate-700'
                }`}
              >
                Week Number
              </label>
              <input
                type="number"
                min={1}
                max={520}
                required
                value={editWeekNumber}
                onChange={(e) =>
                  setEditWeekNumber(parseInt(e.target.value, 10) || 1)
                }
                className={`w-full text-xs border rounded px-2.5 py-1.5 font-mono ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white'
                    : 'bg-white border-slate-300 text-slate-900'
                }`}
              />
            </div>
            <div>
              <label
                className={`block text-[11px] font-semibold mb-1 ${
                  isDark ? 'text-slate-300' : 'text-slate-700'
                }`}
              >
                Monday Start Date
              </label>
              <input
                type="date"
                required
                value={editMondayIso}
                onChange={(e) => {
                  const nextMon = e.target.value;
                  setEditMondayIso(nextMon);
                  if (nextMon) {
                    const parsed = new Date(`${nextMon}T12:00:00`);
                    if (!Number.isNaN(parsed.getTime())) {
                      const fri = new Date(parsed);
                      fri.setDate(parsed.getDate() + 4);
                      const yyyy = fri.getFullYear();
                      const mm = String(fri.getMonth() + 1).padStart(2, '0');
                      const dd = String(fri.getDate()).padStart(2, '0');
                      setEditFridayIso(`${yyyy}-${mm}-${dd}`);
                    }
                  }
                }}
                className={`w-full text-xs border rounded px-2.5 py-1.5 font-mono ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white'
                    : 'bg-white border-slate-300 text-slate-900'
                }`}
              />
            </div>
            <div>
              <label
                className={`block text-[11px] font-semibold mb-1 ${
                  isDark ? 'text-slate-300' : 'text-slate-700'
                }`}
              >
                Friday End Date
              </label>
              <input
                type="date"
                required
                value={editFridayIso}
                onChange={(e) => setEditFridayIso(e.target.value)}
                className={`w-full text-xs border rounded px-2.5 py-1.5 font-mono ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white'
                    : 'bg-white border-slate-300 text-slate-900'
                }`}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsEditingWeekSetup(false)}
              className={`px-3 py-1 text-xs ${
                isDark ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`px-3 py-1.5 text-xs font-semibold rounded ${
                isDark
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              Save Week &amp; Dates
            </button>
          </div>
        </form>
      )}

      {statusMessage && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-4 py-2.5 text-xs font-medium">
          {statusMessage}
        </div>
      )}

      {/* TAB 1: STUDENT LIST + STUDENT PROFILE (ACTIVE TARGETS -> BAR GRAPH -> SUBJECTS & STAFF) */}
      {activeTab === 'STUDENTS' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Write Student Name or Click from Student List */}
          <div
            className={`${
              activeStudentRow ? 'lg:col-span-4' : 'lg:col-span-12'
            } ${
              isDark
                ? 'bg-slate-900 border-slate-800 text-slate-100'
                : 'bg-white border-slate-200 text-slate-900'
            } border rounded-lg p-4 space-y-4 transition-all`}
          >
            <div className="flex items-center justify-between gap-2">
              <h2
                className={`text-sm font-bold ${
                  isDark ? 'text-white' : 'text-slate-900'
                }`}
              >
                Students ({students.length})
              </h2>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-student-create="true"
                  onClick={() => {
                    setAddStudentModalName(studentSearchOrNewName.trim());
                    setAddStudentModalYear('Year 10 · Group A');
                    setAddStudentModalMentor('Ms. Eleanor Vance');
                    setAddStudentModalCode('');
                    setShowAddStudentModal(true);
                  }}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-md bg-slate-900 hover:bg-slate-800 text-white inline-flex items-center gap-1 whitespace-nowrap transition-colors shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Student</span>
                </button>
                {activeStudentRow && (
                  <button
                    type="button"
                    onClick={handleCloseStudentProfile}
                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap transition-colors ${
                      isDark
                        ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200'
                    }`}
                  >
                    Deselect
                  </button>
                )}
              </div>
            </div>

            <form
              data-student-create="true"
              onSubmit={handleCreateStudentByName}
              className="space-y-2"
            >
              <input
                type="text"
                value={studentSearchOrNewName}
                onChange={(e) => setStudentSearchOrNewName(e.target.value)}
                placeholder="Write student name to search or add..."
                className={`w-full text-xs border rounded-md px-3 py-2 focus:outline-none ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-400 focus:border-indigo-400'
                    : 'border-slate-300 text-slate-900 focus:border-slate-900 bg-white'
                }`}
              />
              {studentSearchOrNewName.trim().length > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={newStudentYear}
                      onChange={(e) => setNewStudentYear(e.target.value)}
                      placeholder="Year & Group (e.g. Year 10 · Group A)"
                      className={`text-xs border rounded-md px-2.5 py-1.5 ${
                        isDark
                          ? 'border-slate-700 bg-slate-800 text-white placeholder-slate-400'
                          : 'border-slate-300 bg-white text-slate-900'
                      }`}
                    />
                    <input
                      type="text"
                      value={newStudentMentor}
                      onChange={(e) => setNewStudentMentor(e.target.value)}
                      placeholder="Mentor's Name"
                      className={`text-xs border rounded-md px-2.5 py-1.5 ${
                        isDark
                          ? 'border-slate-700 bg-slate-800 text-white placeholder-slate-400'
                          : 'border-slate-300 bg-white text-slate-900'
                      }`}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isCreatingStudent}
                    className={`w-full py-1.5 px-3 text-xs font-semibold rounded-md inline-flex items-center justify-center gap-1 transition-colors ${
                      isDark
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                        : 'bg-slate-900 hover:bg-slate-800 text-white'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {isCreatingStudent
                      ? 'Adding...'
                      : `Add "${studentSearchOrNewName.trim()}"`}
                  </button>
                </div>
              )}
            </form>

            {/* Student List - All students shown: Middle School at Top, Upper School Below */}
            {activeStudentRow ? (
              /* Compact Sidebar Layout when a student profile is active */
              <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
                {/* Middle School Section (at Top) */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-0.5">
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                        isDark
                          ? 'text-emerald-300 bg-emerald-950/80 border-emerald-800'
                          : 'text-emerald-900 bg-emerald-100/90 border-emerald-300'
                      }`}
                    >
                      Middle School (Yr 7–8)
                    </span>
                    <span
                      className={`text-[10px] font-semibold ${
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      ({middleSchoolStudentRows.length})
                    </span>
                  </div>
                  {middleSchoolStudentRows.length === 0 ? (
                    <div
                      className={`p-2.5 text-[11px] italic rounded-md border ${
                        isDark
                          ? 'bg-slate-850 text-slate-400 border-slate-800'
                          : 'bg-slate-50 text-slate-400 border-slate-200'
                      }`}
                    >
                      No Middle School students found
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {middleSchoolStudentRows.map((row) => {
                        const isSelected = activeStudentRow?.student.id === row.student.id;
                        return (
                          <button
                            key={row.student.id}
                            type="button"
                            data-student-select="true"
                            onClick={() => {
                              if (isSelected) {
                                handleCloseStudentProfile();
                              } else {
                                setSelectedStudentId(row.student.id);
                                setIsEditingStudentProfile(false);
                                setShowAddTargetForm(false);
                                setShowAddSubjectForm(false);
                                setExpandedSubjects({});
                              }
                            }}
                            className={`w-full text-left p-2.5 rounded-lg border transition-colors flex items-center justify-between gap-2 ${
                              row.isComplete
                                ? isSelected
                                  ? isDark
                                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-md ring-1 ring-emerald-400'
                                    : 'bg-emerald-600 text-white border-emerald-700'
                                  : isDark
                                  ? 'bg-emerald-950/40 text-emerald-200 border-emerald-800 hover:bg-emerald-950/60'
                                  : 'bg-emerald-50/80 text-emerald-950 border-emerald-400 hover:bg-emerald-100/70'
                                : isSelected
                                ? isDark
                                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-md ring-1 ring-indigo-400'
                                  : 'bg-slate-900 text-white border-slate-900'
                                : isDark
                                ? 'bg-slate-800/80 text-slate-100 border-slate-700 hover:bg-slate-800'
                                : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-bold truncate">
                                {row.student.name}
                              </div>
                              <div
                                className={`text-[10px] font-mono tabular-nums ${
                                  row.isComplete
                                    ? isSelected
                                      ? 'text-emerald-100'
                                      : isDark
                                      ? 'text-emerald-300'
                                      : 'text-emerald-700'
                                    : isSelected
                                    ? 'text-slate-300'
                                    : isDark
                                    ? 'text-slate-400'
                                    : 'text-slate-500'
                                }`}
                              >
                                {row.student.yearGroup} · {row.trackedCount}/{row.requiredCount} tracked
                              </div>
                            </div>
                            {row.isComplete ? (
                              <CheckCircle2
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-white' : 'text-emerald-500'
                                }`}
                              />
                            ) : (
                              <Clock
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-slate-300' : 'text-amber-500'
                                }`}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Upper School Section (Below) */}
                <div
                  className={`space-y-2 pt-3 border-t ${
                    isDark ? 'border-slate-800' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2 px-0.5">
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                        isDark
                          ? 'text-sky-300 bg-sky-950/80 border-sky-800'
                          : 'text-sky-900 bg-sky-100/90 border-sky-300'
                      }`}
                    >
                      Upper School (Yr 9–13)
                    </span>
                    <span
                      className={`text-[10px] font-semibold ${
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      ({upperSchoolStudentRows.length})
                    </span>
                  </div>
                  {upperSchoolStudentRows.length === 0 ? (
                    <div
                      className={`p-2.5 text-[11px] italic rounded-md border ${
                        isDark
                          ? 'bg-slate-850 text-slate-400 border-slate-800'
                          : 'bg-slate-50 text-slate-400 border-slate-200'
                      }`}
                    >
                      No Upper School students found
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {upperSchoolStudentRows.map((row) => {
                        const isSelected = activeStudentRow?.student.id === row.student.id;
                        return (
                          <button
                            key={row.student.id}
                            type="button"
                            data-student-select="true"
                            onClick={() => {
                              if (isSelected) {
                                handleCloseStudentProfile();
                              } else {
                                setSelectedStudentId(row.student.id);
                                setIsEditingStudentProfile(false);
                                setShowAddTargetForm(false);
                                setShowAddSubjectForm(false);
                                setExpandedSubjects({});
                              }
                            }}
                            className={`w-full text-left p-2.5 rounded-lg border transition-colors flex items-center justify-between gap-2 ${
                              row.isComplete
                                ? isSelected
                                  ? isDark
                                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-md ring-1 ring-emerald-400'
                                    : 'bg-emerald-600 text-white border-emerald-700'
                                  : isDark
                                  ? 'bg-emerald-950/40 text-emerald-200 border-emerald-800 hover:bg-emerald-950/60'
                                  : 'bg-emerald-50/80 text-emerald-950 border-emerald-400 hover:bg-emerald-100/70'
                                : isSelected
                                ? isDark
                                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-md ring-1 ring-indigo-400'
                                  : 'bg-slate-900 text-white border-slate-900'
                                : isDark
                                ? 'bg-slate-800/80 text-slate-100 border-slate-700 hover:bg-slate-800'
                                : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-bold truncate">
                                {row.student.name}
                              </div>
                              <div
                                className={`text-[10px] font-mono tabular-nums ${
                                  row.isComplete
                                    ? isSelected
                                      ? 'text-emerald-100'
                                      : isDark
                                      ? 'text-emerald-300'
                                      : 'text-emerald-700'
                                    : isSelected
                                    ? 'text-slate-300'
                                    : isDark
                                    ? 'text-slate-400'
                                    : 'text-slate-500'
                                }`}
                              >
                                {row.student.yearGroup} · {row.trackedCount}/{row.requiredCount} tracked
                              </div>
                            </div>
                            {row.isComplete ? (
                              <CheckCircle2
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-white' : 'text-emerald-500'
                                }`}
                              />
                            ) : (
                              <Clock
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-slate-300' : 'text-amber-500'
                                }`}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Full Dashboard Layout with Small Titles on the Side */
              <div className="space-y-5 pt-1">
                {/* Middle School Section (at Top) */}
                <div
                  className={`flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-xl border transition-colors ${
                    isDark
                      ? 'bg-slate-900/60 border-slate-800'
                      : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  {/* Small Title on the Side */}
                  <div className="md:w-44 shrink-0 space-y-1">
                    <div
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider border ${
                        isDark
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                          : 'bg-emerald-100 text-emerald-900 border-emerald-300'
                      }`}
                    >
                      Middle School
                    </div>
                    <div
                      className={`text-[11px] font-semibold pl-0.5 ${
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      Year 7 – Year 8 ({middleSchoolStudentRows.length} students)
                    </div>
                  </div>

                  {/* Middle School Students Grid */}
                  <div className="flex-1">
                    {middleSchoolStudentRows.length === 0 ? (
                      <div
                        className={`p-4 text-xs italic rounded-lg border border-dashed ${
                          isDark
                            ? 'bg-slate-800/50 text-slate-400 border-slate-700'
                            : 'bg-white text-slate-400 border-slate-200'
                        }`}
                      >
                        No Middle School students found.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                        {middleSchoolStudentRows.map((row) => (
                          <div
                            key={row.student.id}
                            className={`w-full rounded-lg border transition-all flex items-center justify-between gap-1.5 pr-2 ${
                              row.isComplete
                                ? isDark
                                  ? 'bg-emerald-950/40 text-emerald-200 border-emerald-800 hover:bg-emerald-950/60'
                                  : 'bg-emerald-50/80 text-emerald-950 border-emerald-400 hover:bg-emerald-100/70'
                                : isDark
                                ? 'bg-slate-800/90 text-slate-100 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
                                : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <button
                              type="button"
                              data-student-select="true"
                              onClick={() => {
                                setSelectedStudentId(row.student.id);
                                setIsEditingStudentProfile(false);
                                setShowAddTargetForm(false);
                                setShowAddSubjectForm(false);
                                setExpandedSubjects({});
                              }}
                              className="flex-1 min-w-0 text-left p-3 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-bold truncate">
                                  {row.student.name}
                                </div>
                                <div
                                  className={`text-[11px] font-mono tabular-nums ${
                                    row.isComplete
                                      ? isDark
                                        ? 'text-emerald-300'
                                        : 'text-emerald-700'
                                      : isDark
                                      ? 'text-slate-400'
                                      : 'text-slate-500'
                                  }`}
                                >
                                  {row.student.yearGroup} · {row.trackedCount}/
                                  {row.requiredCount} tracked
                                </div>
                              </div>
                              {row.isComplete ? (
                                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
                              ) : (
                                <Clock className="w-4 h-4 shrink-0 text-amber-500" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDeleteStudent(row.student)}
                              title={`Delete ${row.student.name}`}
                              className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Upper School Section (Below) */}
                <div
                  className={`flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-xl border transition-colors ${
                    isDark
                      ? 'bg-slate-900/60 border-slate-800'
                      : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  {/* Small Title on the Side */}
                  <div className="md:w-44 shrink-0 space-y-1">
                    <div
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider border ${
                        isDark
                          ? 'bg-sky-950/80 text-sky-300 border-sky-800'
                          : 'bg-sky-100 text-sky-900 border-sky-300'
                      }`}
                    >
                      Upper School
                    </div>
                    <div
                      className={`text-[11px] font-semibold pl-0.5 ${
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      Year 9 – Year 13 ({upperSchoolStudentRows.length} students)
                    </div>
                  </div>

                  {/* Upper School Students Grid */}
                  <div className="flex-1">
                    {upperSchoolStudentRows.length === 0 ? (
                      <div
                        className={`p-4 text-xs italic rounded-lg border border-dashed ${
                          isDark
                            ? 'bg-slate-800/50 text-slate-400 border-slate-700'
                            : 'bg-white text-slate-400 border-slate-200'
                        }`}
                      >
                        No Upper School students found.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                        {upperSchoolStudentRows.map((row) => (
                          <div
                            key={row.student.id}
                            className={`w-full rounded-lg border transition-all flex items-center justify-between gap-1.5 pr-2 ${
                              row.isComplete
                                ? isDark
                                  ? 'bg-emerald-950/40 text-emerald-200 border-emerald-800 hover:bg-emerald-950/60'
                                  : 'bg-emerald-50/80 text-emerald-950 border-emerald-400 hover:bg-emerald-100/70'
                                : isDark
                                ? 'bg-slate-800/90 text-slate-100 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
                                : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <button
                              type="button"
                              data-student-select="true"
                              onClick={() => {
                                setSelectedStudentId(row.student.id);
                                setIsEditingStudentProfile(false);
                                setShowAddTargetForm(false);
                                setShowAddSubjectForm(false);
                                setExpandedSubjects({});
                              }}
                              className="flex-1 min-w-0 text-left p-3 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-bold truncate">
                                  {row.student.name}
                                </div>
                                <div
                                  className={`text-[11px] font-mono tabular-nums ${
                                    row.isComplete
                                      ? isDark
                                        ? 'text-emerald-300'
                                        : 'text-emerald-700'
                                      : isDark
                                      ? 'text-slate-400'
                                      : 'text-slate-500'
                                  }`}
                                >
                                  {row.student.yearGroup} · {row.trackedCount}/
                                  {row.requiredCount} tracked
                                </div>
                              </div>
                              {row.isComplete ? (
                                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
                              ) : (
                                <Clock className="w-4 h-4 shrink-0 text-amber-500" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDeleteStudent(row.student)}
                              title={`Delete ${row.student.name}`}
                              className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Selected Student Profile (Closed when deselected) */}
          {activeStudentRow && (
            <div
              ref={studentProfileRef}
              className="lg:col-span-8 space-y-6"
            >
              <div
                className={`${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-100'
                    : 'bg-slate-200/70 border-slate-300 text-slate-900'
                } border rounded-xl p-5 space-y-5 shadow-xs transition-colors`}
              >
                {/* Filled & Editable Student Profile Header */}
                <div
                  className={`rounded-lg p-5 border shadow-xs space-y-4 transition-colors ${
                    activeStudentRow.isComplete
                      ? isDark
                        ? 'bg-emerald-950/80 text-white border-emerald-800'
                        : 'bg-emerald-900 text-white border-emerald-800'
                      : isDark
                      ? 'bg-slate-850 text-white border-slate-750'
                      : 'bg-slate-900 text-white border-slate-800'
                  }`}
                >
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                          Student Profile
                        </span>
                        {activeStudentRow.isComplete && (
                          <span className="text-xs font-semibold text-emerald-100 bg-emerald-500/25 border border-emerald-400/40 px-2.5 py-0.5 rounded inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
                            Completed
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 min-w-0 w-full">
                      <button
                        type="button"
                        onClick={() => {
                          const exportSubjects = activeStudentSubjects.map(
                            (s) => s.subject
                          );
                          const exportTeachers = Array.from(
                            new Set(
                              activeStudentSubjects
                                .map((s) => s.teacherName)
                                .filter(Boolean)
                            )
                          );
                          exportStudentTargetsPdf({
                            studentName: activeStudentRow.student.name,
                            yearGroup: formatStudentYearAndGroup(
                              activeStudentRow.student
                            ),
                            term: currentTerm || 'TERM 1',
                            teacherName:
                              exportTeachers.join(', ') ||
                              getStudentMentorName(activeStudentRow.student),
                            subject: exportSubjects.join(', ') || 'General',
                            targets: activeStudentGroupedTargets.flatEntries.map(
                              (entry) => {
                                const title = entry.item.title;
                                const m = activeStudentTargetMetaByTitle[title];
                                return {
                                  targetGroupId: m?.targetGroupId || '',
                                  heading: m?.heading || '',
                                  title,
                                  challenge: m?.challenge || '',
                                  suggestedStrategies:
                                    m?.suggestedStrategies || '',
                                  fontColor: m?.fontColor || 'black',
                                };
                              }
                            ),
                          });
                        }}
                        className="px-3.5 py-1.5 text-xs font-bold bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors shadow-xs"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Target Export
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleStartEditingStudentProfile(
                            activeStudentRow.student
                          )
                        }
                        className="px-3 py-1.5 text-xs font-semibold bg-white/15 hover:bg-white/25 text-white rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit Profile
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setTargetInputs([createEmptyTargetDraft()]);
                          setShowAddTargetNoteMap({});
                          setShowAddTargetForm((prev) => !prev);
                          setShowAddSubjectForm(false);
                        }}
                        className={`px-3.5 py-1.5 text-xs font-semibold rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                          isDark
                            ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                            : 'bg-white text-slate-900 hover:bg-slate-100'
                        }`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Target
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const defaultChecked: Record<string, boolean> = {};
                          activeStudentUniqueTargetTitles.forEach((t) => {
                            defaultChecked[t] = true;
                          });
                          setSelectedApplicableTargets(defaultChecked);
                          setShowAddSubjectForm((prev) => !prev);
                          setShowAddTargetForm(false);
                        }}
                        className="px-3.5 py-1.5 text-xs font-semibold bg-white/15 hover:bg-white/25 text-white rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        + Add Subject &amp; Staff
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setPendingDeleteStudent(activeStudentRow.student)
                        }
                        title={`Delete ${activeStudentRow.student.name}`}
                        className="px-3 py-1.5 text-xs font-semibold bg-rose-500/20 hover:bg-rose-500/35 text-rose-100 border border-rose-400/30 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>

                      <button
                        type="button"
                        onClick={handleCloseStudentProfile}
                        title="Deselect student and close profile"
                        className="px-2.5 py-1.5 text-xs font-semibold bg-white/10 hover:bg-white/20 text-slate-200 hover:text-white rounded-md inline-flex items-center gap-1 whitespace-nowrap transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        Close
                      </button>
                    </div>
                  </div>

                  {isEditingStudentProfile ? (
                    <form
                      onSubmit={(e) =>
                        handleSaveStudentProfile(e, activeStudentRow.student)
                      }
                      className="pt-3 border-t border-white/15 space-y-3"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Student Name *
                          </label>
                          <input
                            type="text"
                            required
                            value={editProfileName}
                            onChange={(e) => setEditProfileName(e.target.value)}
                            className="w-full text-xs border border-slate-600 rounded-md px-3 py-2 bg-slate-800 text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Year and Group *
                          </label>
                          <input
                            type="text"
                            required
                            value={editProfileYearGroup}
                            onChange={(e) =>
                              setEditProfileYearGroup(e.target.value)
                            }
                            className="w-full text-xs border border-slate-600 rounded-md px-3 py-2 bg-slate-800 text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Mentor&apos;s Name *
                          </label>
                          <input
                            type="text"
                            required
                            value={editProfileMentorName}
                            onChange={(e) =>
                              setEditProfileMentorName(e.target.value)
                            }
                            className="w-full text-xs border border-slate-600 rounded-md px-3 py-2 bg-slate-800 text-white"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setIsEditingStudentProfile(false)}
                          className="px-3 py-1.5 text-xs text-slate-300 hover:text-white"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isSavingStudentProfile}
                          className="px-4 py-1.5 text-xs font-semibold bg-white text-slate-900 rounded-md hover:bg-slate-100"
                        >
                          {isSavingStudentProfile
                            ? 'Saving...'
                            : 'Save Student Profile'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="pt-3 border-t border-white/15 grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <button
                        type="button"
                        onClick={() =>
                          handleStartEditingStudentProfile(
                            activeStudentRow.student
                          )
                        }
                        title="Click to edit Student Name"
                        className="text-left p-3.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 flex items-center justify-between gap-3 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-white/15 border border-white/20 flex items-center justify-center text-white shrink-0">
                            <User className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                              Student Name
                            </div>
                            <div className="text-base font-bold text-white truncate">
                              {activeStudentRow.student.name}
                            </div>
                          </div>
                        </div>
                        <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleStartEditingStudentProfile(
                            activeStudentRow.student
                          )
                        }
                        title="Click to edit Year and Group"
                        className="text-left p-3.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 flex items-center justify-between gap-3 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                            Year and Group
                          </div>
                          <div className="text-sm font-bold text-white mt-0.5 truncate">
                            {formatStudentYearAndGroup(
                              activeStudentRow.student
                            )}
                          </div>
                        </div>
                        <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleStartEditingStudentProfile(
                            activeStudentRow.student
                          )
                        }
                        title="Click to edit Mentor's Name"
                        className="text-left p-3.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 flex items-center justify-between gap-3 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                            Mentor&apos;s Name
                          </div>
                          <div className="text-sm font-bold text-white mt-0.5 truncate">
                            {getStudentMentorName(activeStudentRow.student)}
                          </div>
                        </div>
                        <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                      </button>
                    </div>
                  )}
                </div>

                {/* FORM A: Add Targets to Student Profile (Supports >3 targets) */}
                {showAddTargetForm && (
                  <form
                    onSubmit={handleSaveTargetsForStudent}
                    className="bg-white border border-slate-300 rounded-lg p-5 space-y-4 shadow-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">
                          Add Targets for {activeStudentRow.student.name}
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setTargetInputs((prev) => [
                            ...prev,
                            createEmptyTargetDraft(),
                          ])
                        }
                        className="text-xs font-semibold text-slate-800 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Another Target Row
                      </button>
                    </div>

                    <div className="space-y-3">
                      {targetInputs.map((draft, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-slate-500">
                                #{idx + 1}
                              </span>
                              <div className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md px-1.5 py-0.5">
                                <span className="text-[10px] font-semibold text-slate-500 mr-1">
                                  Color:
                                </span>
                                {(
                                  [
                                    {
                                      value: 'black',
                                      label: 'Black',
                                      dotClass: 'bg-slate-900',
                                    },
                                    {
                                      value: 'red',
                                      label: 'Red',
                                      dotClass: 'bg-red-600',
                                    },
                                    {
                                      value: 'blue',
                                      label: 'Blue',
                                      dotClass: 'bg-blue-600',
                                    },
                                  ] as const
                                ).map((opt) => (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() =>
                                      setTargetInputs((prev) =>
                                        prev.map((item, i) =>
                                          i === idx
                                            ? { ...item, fontColor: opt.value }
                                            : item
                                        )
                                      )
                                    }
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all ${
                                      draft.fontColor === opt.value
                                        ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-400'
                                        : 'text-slate-600 hover:bg-slate-100'
                                    }`}
                                    title={`Set font color to ${opt.label}`}
                                  >
                                    <span
                                      className={`w-2.5 h-2.5 rounded-full ${opt.dotClass}`}
                                    />
                                    <span>{opt.label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                            {targetInputs.length > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setTargetInputs((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                className="p-1 text-slate-400 hover:text-red-600"
                                title="Remove target row"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          <textarea
                            rows={1}
                            value={draft.heading}
                            onChange={(e) => {
                              const val = e.target.value;
                              setTargetInputs((prev) =>
                                prev.map((item, i) =>
                                  i === idx ? { ...item, heading: val } : item
                                )
                              );
                            }}
                            placeholder="Heading (bold, optional — press Enter for new line)..."
                            className={`w-full text-xs font-bold border border-slate-300 rounded-md px-3 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                              draft.fontColor
                            )}`}
                          />

                          {showAddTargetNoteMap[idx] ||
                          draft.internalNote.trim().length > 0 ? (
                            <textarea
                              rows={2}
                              value={draft.internalNote}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTargetInputs((prev) =>
                                  prev.map((item, i) =>
                                    i === idx
                                      ? { ...item, internalNote: val }
                                      : item
                                  )
                                );
                              }}
                              placeholder="Note (displays in red above description in Admin & Staff views only)..."
                              className="w-full text-xs font-medium text-red-600 placeholder:text-red-400 border border-red-200 rounded-md px-3 py-1.5 bg-red-50/50 resize-y leading-relaxed"
                            />
                          ) : (
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  setShowAddTargetNoteMap((prev) => ({
                                    ...prev,
                                    [idx]: true,
                                  }))
                                }
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded transition-colors"
                              >
                                <Plus className="w-3 h-3" />
                                <span>add note</span>
                              </button>
                            </div>
                          )}

                          <textarea
                            rows={3}
                            value={draft.description}
                            onChange={(e) => {
                              const val = e.target.value;
                              setTargetInputs((prev) =>
                                prev.map((item, i) =>
                                  i === idx
                                    ? { ...item, description: val }
                                    : item
                                )
                              );
                            }}
                            placeholder={`Target ${idx + 1} description (normal text — press Enter for line spacing)...`}
                            className={`w-full text-xs font-normal border border-slate-300 rounded-md px-3 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                              draft.fontColor
                            )}`}
                          />

                          <textarea
                            rows={2}
                            value={draft.challenge}
                            onChange={(e) => {
                              const val = e.target.value;
                              setTargetInputs((prev) =>
                                prev.map((item, i) =>
                                  i === idx ? { ...item, challenge: val } : item
                                )
                              );
                            }}
                            placeholder="Challenge (optional — displayed in bold as Challenge: ... — press Enter for new line)"
                            className={`w-full text-xs font-bold border border-slate-300 rounded-md px-3 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                              draft.fontColor
                            )}`}
                          />

                          <textarea
                            rows={2}
                            value={draft.suggestedStrategies}
                            onChange={(e) => {
                              const val = e.target.value;
                              setTargetInputs((prev) =>
                                prev.map((item, i) =>
                                  i === idx
                                    ? { ...item, suggestedStrategies: val }
                                    : item
                                )
                              );
                            }}
                            placeholder="Suggested Strategies (optional — press Enter for line spacing)..."
                            className="w-full text-xs font-normal border border-slate-300 rounded-md px-3 py-1.5 bg-white text-slate-900 resize-y leading-relaxed"
                          />
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setShowAddTargetForm(false)}
                        className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingTargets}
                        className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800"
                      >
                        {isSavingTargets ? 'Saving Targets...' : 'Save Targets'}
                      </button>
                    </div>
                  </form>
                )}

                {/* FORM B: Add Subject & Assign Staff (Existing Staff OR Direct New Staff) */}
                {showAddSubjectForm && (
                  <form
                    onSubmit={handleSaveSubjectForStudent}
                    className="bg-white border border-slate-300 rounded-lg p-5 space-y-4 shadow-xs"
                  >
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Add Subject, Teacher &amp; Assign LSA for{' '}
                        {activeStudentRow.student.name}
                      </h3>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Subject Name *
                        </label>
                        <input
                          type="text"
                          required
                          value={subjectNameInput}
                          onChange={(e) => setSubjectNameInput(e.target.value)}
                          placeholder="e.g. Mathematics, English, Science"
                          className="w-full text-xs border border-slate-300 rounded-md px-3 py-2 text-slate-900"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Subject Teacher (Record Only)
                        </label>
                        <input
                          type="text"
                          value={teacherNameInput}
                          onChange={(e) => setTeacherNameInput(e.target.value)}
                          placeholder="e.g. Mr. Henderson"
                          className="w-full text-xs border border-slate-300 rounded-md px-3 py-2 text-slate-900"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-semibold text-slate-700">
                            Assigned LSA (Staff Portal) *
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setStaffAssignMode((prev) =>
                                prev === 'EXISTING' ? 'DIRECT_NEW' : 'EXISTING'
                              )
                            }
                            className="text-[11px] font-semibold text-slate-700 underline"
                          >
                            {staffAssignMode === 'EXISTING'
                              ? '+ Add LSA'
                              : 'Select LSA'}
                          </button>
                        </div>

                        {staffAssignMode === 'EXISTING' ? (
                          <select
                            value={
                              selectedStaffEmail ||
                              assignableStaff[0]?.email ||
                              ''
                            }
                            onChange={(e) =>
                              setSelectedStaffEmail(e.target.value)
                            }
                            className="w-full text-xs border border-slate-300 rounded-md px-3 py-2 bg-white text-slate-900"
                          >
                            {assignableStaff.map((st) => (
                              <option key={st.id} value={st.email}>
                                {st.name} ({st.email})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <input
                              type="text"
                              required
                              value={directStaffName}
                              onChange={(e) =>
                                setDirectStaffName(e.target.value)
                              }
                              placeholder="LSA Name"
                              className="text-xs border border-slate-300 rounded-md px-2.5 py-2 text-slate-900"
                            />
                            <input
                              type="email"
                              required
                              value={directStaffEmail}
                              onChange={(e) =>
                                setDirectStaffEmail(e.target.value)
                              }
                              placeholder="lsa@email.com"
                              className="text-xs border border-slate-300 rounded-md px-2.5 py-2 text-slate-900 font-mono"
                            />
                          </div>
                        )}
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          LSA will use the Staff Portal.
                        </p>
                      </div>
                    </div>

                    {/* Checklist of Student's Active Targets that apply to this Subject */}
                    {activeStudentGroupedTargets.flatEntries.length > 0 && (
                      <div className="space-y-2 pt-2 border-t border-slate-100">
                        <div className="text-xs font-semibold text-slate-700">
                          Select Which Active Targets Apply to This Subject:
                        </div>
                        <div className="space-y-1.5">
                          {activeStudentGroupedTargets.flatEntries.map(
                            (entry) => {
                              const title = entry.item.title;
                              const isChecked =
                                selectedApplicableTargets[title] !== undefined
                                  ? selectedApplicableTargets[title]
                                  : true;
                              const meta =
                                activeStudentTargetMetaByTitle[title];
                              return (
                                <label
                                  key={title}
                                  className="flex items-start gap-2.5 p-2 rounded border border-slate-200 bg-slate-50/70 text-xs cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    className="mt-0.5"
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setSelectedApplicableTargets((prev) => ({
                                        ...prev,
                                        [title]: checked,
                                      }));
                                    }}
                                  />
                                  <span className="font-mono font-bold text-slate-500 mt-0.5 shrink-0">
                                    {entry.displayNumber}.
                                  </span>
                                  <div
                                    className={`space-y-0.5 ${getTargetFontColorClass(
                                      meta?.fontColor
                                    )}`}
                                  >
                                    {meta?.heading && (
                                      <div className="font-bold whitespace-pre-wrap break-words">
                                        {meta.heading}
                                      </div>
                                    )}
                                    {meta?.internalNote && (
                                      <div className="my-1 px-2 py-1 rounded border border-red-200 bg-red-50/60 text-red-600 font-medium whitespace-pre-wrap break-words">
                                        <span className="font-bold">Note: </span>
                                        {meta.internalNote}
                                      </div>
                                    )}
                                    <div className="font-normal whitespace-pre-wrap break-words">
                                      {title}
                                    </div>
                                    {meta?.challenge && (
                                      <div className="font-bold whitespace-pre-wrap break-words">
                                        Challenge: {meta.challenge}
                                      </div>
                                    )}
                                    {meta?.suggestedStrategies && (
                                      <div className="font-normal text-slate-600 whitespace-pre-wrap break-words">
                                        <span className="font-semibold">
                                          Suggested Strategies:{' '}
                                        </span>
                                        {meta.suggestedStrategies}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            }
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setShowAddSubjectForm(false)}
                        className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingSubject}
                        className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800"
                      >
                        {isSavingSubject
                          ? 'Saving Subject...'
                          : 'Save Subject & Assign LSA'}
                      </button>
                    </div>
                  </form>
                )}

                {/* SECTION 1: STUDENT'S ACTIVE TARGETS LIST */}
                <div
                  className={`${
                    isDark
                      ? 'bg-slate-850 border-slate-750 text-slate-100'
                      : 'bg-white border-slate-200 text-slate-900'
                  } border rounded-lg p-5 space-y-3 transition-colors`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TargetIcon
                        className={`w-4 h-4 ${
                          isDark ? 'text-indigo-400' : 'text-slate-700'
                        }`}
                      />
                      <h3
                        className={`text-sm font-bold ${
                          isDark ? 'text-white' : 'text-slate-900'
                        }`}
                      >
                        Active Targets ({activeStudentUniqueTargetTitles.length})
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setTargetInputs([createEmptyTargetDraft()]);
                        setShowAddTargetNoteMap({});
                        setShowAddTargetForm(true);
                      }}
                      className={`text-xs font-semibold hover:underline inline-flex items-center gap-1 ${
                        isDark ? 'text-indigo-400' : 'text-slate-800'
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Target
                    </button>
                  </div>

                  {activeStudentUniqueTargetTitles.length === 0 ? (
                    <div
                      className={`p-6 text-center text-xs border border-dashed rounded-lg ${
                        isDark
                          ? 'border-slate-750 text-slate-400 bg-slate-900/40'
                          : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      No targets added for {activeStudentRow.student.name} yet.
                      Click <strong>Add Target</strong> above to input their targets.
                    </div>
                  ) : (
                    <div
                      className={`divide-y ${
                        isDark ? 'divide-slate-750' : 'divide-slate-100'
                      }`}
                    >
                      {activeStudentGroupedTargets.groups.map((grp) => {
                        const isMultiSubGroup = grp.entries.length > 1;
                        const firstEntry = grp.entries[0];
                        const nextSubNum = `${grp.groupNumber}.${grp.entries.length + 1}`;
                        const existingGroupId =
                          activeStudentTargetMetaByTitle[
                            firstEntry.item.title
                          ]?.targetGroupId || '';
                        const existingTitlesInGroup = grp.entries.map(
                          (en) => en.item.title
                        );
                        const isAddingHere =
                          addingSubTargetGroup?.groupKey === grp.groupKey;

                        const openAddSubTarget = () => {
                          setAddingSubTargetGroup({
                            groupKey: grp.groupKey,
                            existingGroupId,
                            groupNumber: grp.groupNumber,
                            nextDisplayNumber: nextSubNum,
                            existingTitlesInGroup,
                          });
                          setSubTargetSharedHeading(grp.sharedHeading);
                          setSubTargetNote('');
                          setShowSubTargetNote(false);
                          setSubTargetDescription('');
                          setSubTargetChallenge('');
                          setSubTargetStrategies('');
                          setSubTargetColor(
                            activeStudentTargetMetaByTitle[
                              firstEntry.item.title
                            ]?.fontColor || 'black'
                          );
                          setEditingTargetOldTitle(null);
                        };

                        const renderInlineSubTargetForm = () =>
                          isAddingHere ? (
                            <form
                              onSubmit={handleSaveSubTarget}
                              className="mt-2 ml-4 p-3 rounded-lg border border-indigo-200 bg-indigo-50/50 space-y-2 text-xs"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-bold text-indigo-900">
                                  Add Sub-Target {nextSubNum} (under Target{' '}
                                  {grp.groupNumber})
                                </span>
                                <div className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md px-1.5 py-0.5">
                                  <span className="text-[10px] font-semibold text-slate-500 mr-1">
                                    Color:
                                  </span>
                                  {(
                                    [
                                      {
                                        value: 'black',
                                        label: 'Black',
                                        dotClass: 'bg-slate-900',
                                      },
                                      {
                                        value: 'red',
                                        label: 'Red',
                                        dotClass: 'bg-red-600',
                                      },
                                      {
                                        value: 'blue',
                                        label: 'Blue',
                                        dotClass: 'bg-blue-600',
                                      },
                                    ] as const
                                  ).map((opt) => (
                                    <button
                                      key={opt.value}
                                      type="button"
                                      onClick={() =>
                                        setSubTargetColor(opt.value)
                                      }
                                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                        subTargetColor === opt.value
                                          ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-400'
                                          : 'text-slate-600 hover:bg-slate-100'
                                      }`}
                                    >
                                      <span
                                        className={`w-2.5 h-2.5 rounded-full ${opt.dotClass}`}
                                      />
                                      <span>{opt.label}</span>
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <textarea
                                rows={1}
                                value={subTargetSharedHeading}
                                onChange={(e) =>
                                  setSubTargetSharedHeading(e.target.value)
                                }
                                placeholder={`Shared Title / Heading for Target ${grp.groupNumber} (${grp.groupNumber}.1, ${nextSubNum}...)`}
                                className="w-full text-xs font-bold border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900 resize-y leading-relaxed"
                              />
                              {showSubTargetNote ||
                              subTargetNote.trim().length > 0 ? (
                                <textarea
                                  rows={2}
                                  value={subTargetNote}
                                  onChange={(e) =>
                                    setSubTargetNote(e.target.value)
                                  }
                                  placeholder={`Note for sub-target ${nextSubNum} (displays in red above description in Admin & Staff views only)...`}
                                  className="w-full text-xs font-medium text-red-600 placeholder:text-red-400 border border-red-200 rounded px-2.5 py-1.5 bg-red-50/50 resize-y leading-relaxed"
                                />
                              ) : (
                                <div>
                                  <button
                                    type="button"
                                    onClick={() => setShowSubTargetNote(true)}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded transition-colors"
                                  >
                                    <Plus className="w-3 h-3" />
                                    <span>add note</span>
                                  </button>
                                </div>
                              )}
                              <textarea
                                rows={3}
                                required
                                value={subTargetDescription}
                                onChange={(e) =>
                                  setSubTargetDescription(e.target.value)
                                }
                                placeholder={`Sub-target ${nextSubNum} description (normal text — press Enter for line spacing)...`}
                                className={`w-full text-xs font-normal border border-slate-300 rounded px-2.5 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                                  subTargetColor
                                )}`}
                              />
                              <textarea
                                rows={2}
                                value={subTargetChallenge}
                                onChange={(e) =>
                                  setSubTargetChallenge(e.target.value)
                                }
                                placeholder="Challenge (optional — displayed in bold)..."
                                className={`w-full text-xs font-bold border border-slate-300 rounded px-2.5 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                                  subTargetColor
                                )}`}
                              />
                              <textarea
                                rows={2}
                                value={subTargetStrategies}
                                onChange={(e) =>
                                  setSubTargetStrategies(e.target.value)
                                }
                                placeholder="Suggested Strategies (optional — press Enter for line spacing)..."
                                className="w-full text-xs font-normal border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900 resize-y leading-relaxed"
                              />
                              <div className="flex items-center justify-end gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => setAddingSubTargetGroup(null)}
                                  className="px-2.5 py-1 text-xs text-slate-600 hover:text-slate-900"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="submit"
                                  disabled={isSavingSubTarget}
                                  className="px-3 py-1 text-xs font-semibold rounded bg-slate-900 hover:bg-slate-800 text-white"
                                >
                                  {isSavingSubTarget
                                    ? 'Saving...'
                                    : `Save Sub-Target ${nextSubNum}`}
                                </button>
                              </div>
                            </form>
                          ) : null;

                        const renderTargetEntryRow = (
                          entry: (typeof grp.entries)[number],
                          hideHeadingInRow: boolean
                        ) => {
                          const title = entry.item.title;
                          const isEditing = editingTargetOldTitle === title;
                          const meta = activeStudentTargetMetaByTitle[
                            title
                          ] || {
                            heading: '',
                            targetGroupId: '',
                            internalNote: '',
                            challenge: '',
                            suggestedStrategies: '',
                            fontColor: 'black' as TargetFontColor,
                          };
                          const currentInlineNoteValue =
                            inlineNoteDrafts[title] !== undefined
                              ? inlineNoteDrafts[title]
                              : meta.internalNote;
                          const hasSavedNote =
                            meta.internalNote.trim().length > 0;
                          const isInlineNoteOpen = Boolean(
                            openInlineNoteTitles[title]
                          );
                          const isInlineNoteDirty =
                            inlineNoteDrafts[title] !== undefined &&
                            inlineNoteDrafts[title].trim() !==
                              meta.internalNote;

                          return (
                            <div
                              key={title}
                              className={`${
                                isMultiSubGroup ? 'py-2' : 'py-3'
                              } flex items-start justify-between gap-3 text-xs`}
                            >
                              {isEditing ? (
                                <div className="flex-1 space-y-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-[11px] font-bold text-slate-600">
                                      Edit Target {entry.displayNumber}
                                    </span>
                                    <div className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md px-1.5 py-0.5">
                                      {(
                                        [
                                          {
                                            value: 'black',
                                            label: 'Black',
                                            dotClass: 'bg-slate-900',
                                          },
                                          {
                                            value: 'red',
                                            label: 'Red',
                                            dotClass: 'bg-red-600',
                                          },
                                          {
                                            value: 'blue',
                                            label: 'Blue',
                                            dotClass: 'bg-blue-600',
                                          },
                                        ] as const
                                      ).map((opt) => (
                                        <button
                                          key={opt.value}
                                          type="button"
                                          onClick={() =>
                                            setEditingTargetNewColor(opt.value)
                                          }
                                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                            editingTargetNewColor === opt.value
                                              ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-400'
                                              : 'text-slate-600 hover:bg-slate-100'
                                          }`}
                                        >
                                          <span
                                            className={`w-2.5 h-2.5 rounded-full ${opt.dotClass}`}
                                          />
                                          <span>{opt.label}</span>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <textarea
                                    rows={1}
                                    value={editingTargetNewHeading}
                                    onChange={(e) =>
                                      setEditingTargetNewHeading(e.target.value)
                                    }
                                    placeholder={
                                      isMultiSubGroup
                                        ? `Shared Title for Target ${grp.groupNumber} (bold)...`
                                        : 'Heading (bold, optional)...'
                                    }
                                    className={`w-full text-xs font-bold border border-slate-300 rounded px-2.5 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                                      editingTargetNewColor
                                    )}`}
                                  />
                                  {showEditTargetNote ||
                                  editingTargetNewInternalNote.trim().length >
                                    0 ? (
                                    <textarea
                                      rows={2}
                                      value={editingTargetNewInternalNote}
                                      onChange={(e) =>
                                        setEditingTargetNewInternalNote(
                                          e.target.value
                                        )
                                      }
                                      placeholder="Note (displays in red above description in Admin & Staff views only)..."
                                      className="w-full text-xs font-medium text-red-600 placeholder:text-red-400 border border-red-200 rounded px-2.5 py-1.5 bg-red-50/50 resize-y leading-relaxed"
                                    />
                                  ) : (
                                    <div>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setShowEditTargetNote(true)
                                        }
                                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded transition-colors"
                                      >
                                        <Plus className="w-3 h-3" />
                                        <span>add note</span>
                                      </button>
                                    </div>
                                  )}
                                  <textarea
                                    rows={3}
                                    value={editingTargetNewTitle}
                                    onChange={(e) =>
                                      setEditingTargetNewTitle(e.target.value)
                                    }
                                    placeholder="Target description (normal — press Enter for line spacing)..."
                                    className={`w-full text-xs font-normal border border-slate-300 rounded px-2.5 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                                      editingTargetNewColor
                                    )}`}
                                  />
                                  <textarea
                                    rows={2}
                                    value={editingTargetNewChallenge}
                                    onChange={(e) =>
                                      setEditingTargetNewChallenge(
                                        e.target.value
                                      )
                                    }
                                    placeholder="Challenge (optional — always bold)..."
                                    className={`w-full text-xs font-bold border border-slate-300 rounded px-2.5 py-1.5 bg-white resize-y leading-relaxed ${getTargetFontColorClass(
                                      editingTargetNewColor
                                    )}`}
                                  />
                                  <textarea
                                    rows={2}
                                    value={editingTargetNewSuggestedStrategies}
                                    onChange={(e) =>
                                      setEditingTargetNewSuggestedStrategies(
                                        e.target.value
                                      )
                                    }
                                    placeholder="Suggested Strategies (optional — press Enter for line spacing)..."
                                    className="w-full text-xs font-normal border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900 resize-y leading-relaxed"
                                  />
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditingTargetOldTitle(null)
                                      }
                                      className="px-2.5 py-1 text-xs text-slate-500 hover:text-slate-800"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleSaveEditedTargetTitle(
                                          activeStudentRow.student,
                                          title
                                        )
                                      }
                                      className="px-3 py-1 text-xs font-semibold rounded bg-slate-900 hover:bg-slate-800 text-white"
                                    >
                                      Save
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                                    <span className="font-mono font-semibold text-slate-400 mt-0.5 shrink-0">
                                      {entry.displayNumber}
                                    </span>
                                    <div
                                      className={`space-y-1 min-w-0 flex-1 ${getTargetFontColorClass(
                                        meta.fontColor
                                      )}`}
                                    >
                                      {!hideHeadingInRow && meta.heading && (
                                        <div className="font-bold whitespace-pre-wrap break-words">
                                          {meta.heading}
                                        </div>
                                      )}
                                      {isInlineNoteOpen ? (
                                        <div className="rounded border border-red-200 bg-red-50/60 p-2 space-y-1.5">
                                          <textarea
                                            autoFocus
                                            rows={
                                              currentInlineNoteValue.includes(
                                                '\n'
                                              )
                                                ? Math.min(
                                                    4,
                                                    currentInlineNoteValue.split(
                                                      '\n'
                                                    ).length
                                                  )
                                                : 2
                                            }
                                            value={currentInlineNoteValue}
                                            onChange={(e) => {
                                              const val = e.target.value;
                                              setInlineNoteDrafts((prev) => ({
                                                ...prev,
                                                [title]: val,
                                              }));
                                            }}
                                            placeholder={`Enter note for Target ${entry.displayNumber}...`}
                                            className="w-full text-xs font-medium text-red-600 placeholder:text-red-300 bg-transparent border-0 p-0 focus:outline-none focus:ring-0 resize-y leading-relaxed"
                                          />
                                          <div className="flex items-center justify-end gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setInlineNoteDrafts((prev) => {
                                                  const copy = { ...prev };
                                                  delete copy[title];
                                                  return copy;
                                                });
                                                setOpenInlineNoteTitles(
                                                  (prev) => {
                                                    const copy = { ...prev };
                                                    delete copy[title];
                                                    return copy;
                                                  }
                                                );
                                              }}
                                              className="px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:text-slate-900"
                                            >
                                              Cancel
                                            </button>
                                            <button
                                              type="button"
                                              disabled={
                                                savingInlineNoteTitle === title
                                              }
                                              onClick={() =>
                                                handleSaveTargetInlineNote(
                                                  activeStudentRow.student,
                                                  title,
                                                  isInlineNoteDirty
                                                    ? currentInlineNoteValue
                                                    : meta.internalNote
                                                )
                                              }
                                              className="px-2 py-0.5 text-[10px] font-bold bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                                            >
                                              {savingInlineNoteTitle === title
                                                ? 'Saving...'
                                                : 'Save'}
                                            </button>
                                          </div>
                                        </div>
                                      ) : hasSavedNote ? (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setInlineNoteDrafts((prev) => ({
                                              ...prev,
                                              [title]: meta.internalNote,
                                            }));
                                            setOpenInlineNoteTitles((prev) => ({
                                              ...prev,
                                              [title]: true,
                                            }));
                                          }}
                                          title="Click to edit note"
                                          className="w-full text-left px-2.5 py-1.5 rounded border border-red-200 bg-red-50/70 hover:bg-red-50 text-xs font-medium text-red-600 whitespace-pre-wrap break-words transition-colors"
                                        >
                                          <span className="font-bold">
                                            Note:{' '}
                                          </span>
                                          {meta.internalNote}
                                        </button>
                                      ) : (
                                        <div>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setInlineNoteDrafts((prev) => ({
                                                ...prev,
                                                [title]: '',
                                              }));
                                              setOpenInlineNoteTitles(
                                                (prev) => ({
                                                  ...prev,
                                                  [title]: true,
                                                })
                                              );
                                            }}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded transition-colors"
                                          >
                                            <Plus className="w-3 h-3" />
                                            <span>add note</span>
                                          </button>
                                        </div>
                                      )}
                                      <div className="font-normal whitespace-pre-wrap break-words">
                                        {title}
                                      </div>
                                      {meta.challenge && (
                                        <div className="font-bold whitespace-pre-wrap break-words">
                                          Challenge: {meta.challenge}
                                        </div>
                                      )}
                                      {meta.suggestedStrategies && (
                                        <div className="pt-0.5 font-normal text-slate-600 whitespace-pre-wrap break-words">
                                          <span className="font-semibold">
                                            Suggested Strategies:{' '}
                                          </span>
                                          {meta.suggestedStrategies}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {!isMultiSubGroup && (
                                      <button
                                        type="button"
                                        onClick={openAddSubTarget}
                                        title={`Add sub-target (${grp.groupNumber}.1, ${grp.groupNumber}.2...)`}
                                        className="px-1.5 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 text-slate-600 hover:text-indigo-700 inline-flex items-center gap-0.5 text-[11px] font-semibold transition-colors"
                                      >
                                        <Plus className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                    <div
                                      className="inline-flex items-center gap-1 px-1.5 py-1 rounded border border-slate-200 bg-slate-50"
                                      title="Change font color"
                                    >
                                      {(
                                        [
                                          {
                                            value: 'black',
                                            label: 'Black',
                                            dotClass: 'bg-slate-900',
                                          },
                                          {
                                            value: 'red',
                                            label: 'Red',
                                            dotClass: 'bg-red-600',
                                          },
                                          {
                                            value: 'blue',
                                            label: 'Blue',
                                            dotClass: 'bg-blue-600',
                                          },
                                        ] as const
                                      ).map((opt) => (
                                        <button
                                          key={opt.value}
                                          type="button"
                                          onClick={() =>
                                            handleUpdateTargetColor(
                                              activeStudentRow.student,
                                              title,
                                              opt.value
                                            )
                                          }
                                          title={`Font color: ${opt.label}`}
                                          className={`w-3.5 h-3.5 rounded-full ${opt.dotClass} transition-transform ${
                                            meta.fontColor === opt.value
                                              ? 'ring-2 ring-offset-1 ring-slate-500 scale-110'
                                              : 'opacity-45 hover:opacity-90'
                                          }`}
                                        />
                                      ))}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingTargetOldTitle(title);
                                        setEditingTargetNewHeading(
                                          meta.heading
                                        );
                                        setEditingTargetNewInternalNote(
                                          meta.internalNote
                                        );
                                        setShowEditTargetNote(
                                          Boolean(meta.internalNote.trim())
                                        );
                                        setEditingTargetNewTitle(title);
                                        setEditingTargetNewChallenge(
                                          meta.challenge
                                        );
                                        setEditingTargetNewSuggestedStrategies(
                                          meta.suggestedStrategies
                                        );
                                        setEditingTargetNewColor(
                                          meta.fontColor
                                        );
                                      }}
                                      className="p-1 text-slate-400 hover:text-slate-700"
                                      title="Edit target"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleDeleteActiveTargetTitle(
                                          activeStudentRow.student,
                                          title
                                        )
                                      }
                                      className="p-1 text-slate-400 hover:text-red-500"
                                      title="Delete target"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        };

                        if (!isMultiSubGroup) {
                          return (
                            <div key={grp.groupKey} className="pb-1">
                              {renderTargetEntryRow(firstEntry, false)}
                              {renderInlineSubTargetForm()}
                            </div>
                          );
                        }

                        return (
                          <div key={grp.groupKey} className="py-3 space-y-2">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono font-bold text-slate-500 shrink-0">
                                  {grp.groupNumber}.
                                </span>
                                <span
                                  className={`font-bold whitespace-pre-wrap break-words ${
                                    isDark ? 'text-white' : 'text-slate-900'
                                  }`}
                                >
                                  {grp.sharedHeading ||
                                    `Target ${grp.groupNumber}`}
                                </span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 shrink-0">
                                  {grp.entries.length} sub-targets
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={openAddSubTarget}
                                title={`Add sub-target ${nextSubNum}`}
                                className="px-1.5 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 text-slate-600 hover:text-indigo-700 inline-flex items-center gap-1 text-[11px] font-semibold transition-colors shrink-0"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                <span>{nextSubNum}</span>
                              </button>
                            </div>
                            <div
                              className={`pl-4 ml-2 border-l-2 space-y-1 divide-y ${
                                isDark
                                  ? 'border-indigo-500/40 divide-slate-800'
                                  : 'border-indigo-200 divide-slate-100'
                              }`}
                            >
                              {grp.entries.map((entry) =>
                                renderTargetEntryRow(entry, true)
                              )}
                            </div>
                            {renderInlineSubTargetForm()}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* SECTION 1B: CONSOLIDATED RATING OF THE STUDENT PER TARGET (BAR GRAPH) */}
                <div
                  className={`${
                    isDark
                      ? 'bg-slate-850 border-slate-750 text-slate-100'
                      : 'bg-white border-slate-200 text-slate-900'
                  } border rounded-lg p-5 space-y-4 transition-colors`}
                >
                  <div
                    className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b ${
                      isDark ? 'border-slate-750' : 'border-slate-100'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <BarChart3
                          className={`w-4 h-4 ${
                            isDark ? 'text-indigo-400' : 'text-slate-800'
                          }`}
                        />
                        <h3
                          className={`text-sm font-bold ${
                            isDark ? 'text-white' : 'text-slate-900'
                          }`}
                        >
                          Consolidated Rating per Target — Bar Graph
                        </h3>
                      </div>
                      <p
                        className={`text-xs ${
                          isDark ? 'text-slate-400' : 'text-slate-500'
                        }`}
                      >
                        Consolidated rating of {activeStudentRow.student.name} per target across assigned subjects for Week {currentWeekInfo.weekNumber} ({currentWeekInfo.rangeLabel}).
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsEditingWeekSetup((prev) => !prev)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-semibold rounded border transition-colors ${
                          isDark
                            ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300'
                        }`}
                        title="Edit Week Number & Dates"
                      >
                        <Calendar
                          className={`w-3.5 h-3.5 ${
                            isDark ? 'text-slate-400' : 'text-slate-600'
                          }`}
                        />
                        <span>
                          Week {currentWeekInfo.weekNumber} ({currentWeekInfo.rangeLabel})
                        </span>
                        <Pencil
                          className={`w-3 h-3 ${
                            isDark ? 'text-slate-400' : 'text-slate-500'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Rating Scale Legend */}
                  <div
                    className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 border rounded-md text-[11px] ${
                      isDark
                        ? 'bg-slate-900/80 border-slate-750 text-slate-300'
                        : 'bg-slate-50 border-slate-200/80 text-slate-600'
                    }`}
                  >
                    <span
                      className={`font-semibold ${
                        isDark ? 'text-slate-200' : 'text-slate-700'
                      }`}
                    >
                      Consolidated Rating Scale:
                    </span>
                    <div className="flex flex-wrap items-center gap-3 font-mono">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-purple-600 inline-block" />
                        <strong>M</strong> = Mastery (100%)
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 inline-block" />
                        <strong>A</strong> = Achieved (100%)
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-sky-600 inline-block" />
                        <strong>PA</strong> = Partially Achieved (70%)
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" />
                        <strong>WT</strong> = Working Towards (35%)
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-slate-400 inline-block" />
                        <strong>NA</strong> = Not Applicable
                      </span>
                    </div>
                  </div>

                  {consolidatedTargetRatings.length === 0 ? (
                    <div
                      className={`p-6 text-center text-xs border border-dashed rounded-lg ${
                        isDark
                          ? 'border-slate-750 text-slate-400 bg-slate-900/40'
                          : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      Add targets above to view {activeStudentRow.student.name}&apos;s consolidated rating bar graph per target.
                    </div>
                  ) : (
                    <div
                      className={`p-4 rounded-lg border space-y-3 ${
                        isDark
                          ? 'bg-slate-900/60 border-slate-750'
                          : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div
                        className={`flex items-center justify-between text-[11px] font-mono ${
                          isDark ? 'text-slate-400' : 'text-slate-500'
                        }`}
                      >
                        <span>BAR GRAPH BY TARGET (0% – 100%)</span>
                        <span>
                          WEEK {currentWeekInfo.weekNumber} · {currentWeekInfo.rangeLabel}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 pt-1">
                        {consolidatedTargetRatings.map((item) => {
                          const barFillClass =
                            item.consolidatedGrade === 'M'
                              ? 'fill-purple-600'
                              : item.consolidatedGrade === 'A'
                              ? 'fill-emerald-600'
                              : item.consolidatedGrade === 'PA'
                              ? 'fill-sky-600'
                              : item.consolidatedGrade === 'WT'
                              ? 'fill-amber-500'
                              : item.consolidatedGrade === 'NA'
                              ? 'fill-slate-400'
                              : 'fill-slate-300';

                          const badgeClass =
                            item.consolidatedGrade === 'M'
                              ? 'bg-purple-600 text-white border-purple-700'
                              : item.consolidatedGrade === 'A'
                              ? 'bg-emerald-600 text-white border-emerald-700'
                              : item.consolidatedGrade === 'PA'
                              ? 'bg-sky-600 text-white border-sky-700'
                              : item.consolidatedGrade === 'WT'
                              ? 'bg-amber-500 text-white border-amber-600'
                              : item.consolidatedGrade === 'NA'
                              ? 'bg-slate-600 text-white border-slate-700'
                              : isDark
                              ? 'bg-slate-800 text-slate-300 border-slate-700'
                              : 'bg-slate-200 text-slate-700 border-slate-300';

                          const barHeight =
                            item.consolidatedGrade === 'NA'
                              ? 12
                              : Math.max(
                                  item.consolidatedScore > 0
                                    ? item.consolidatedScore
                                    : 4,
                                  4
                                );
                          const barY = 100 - barHeight;

                          return (
                            <div
                              key={item.title}
                              className={`border rounded-md p-3 flex flex-col justify-between space-y-2.5 ${
                                isDark
                                  ? 'bg-slate-800 border-slate-700 text-slate-100'
                                  : 'bg-white border-slate-200 text-slate-900'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={`text-xs font-mono font-bold ${
                                    isDark ? 'text-slate-200' : 'text-slate-800'
                                  }`}
                                >
                                  Target {item.displayNumber}
                                </span>
                                <span
                                  className={`px-2 py-0.5 text-[11px] font-mono font-bold rounded border ${badgeClass}`}
                                >
                                  {item.consolidatedGrade === 'UNTRACKED'
                                    ? 'Untracked (0%)'
                                    : item.consolidatedGrade === 'NA'
                                    ? 'NA'
                                    : `${item.consolidatedGrade} (${item.consolidatedScore}%)`}
                                </span>
                              </div>

                              {/* Vertical SVG Column Bar with reference lines */}
                              <div
                                className={`relative h-32 w-full border rounded overflow-hidden flex items-end ${
                                  isDark
                                    ? 'bg-slate-900 border-slate-700'
                                    : 'bg-slate-100/90 border-slate-200'
                                }`}
                              >
                                <svg
                                  viewBox="0 0 100 100"
                                  preserveAspectRatio="none"
                                  className="w-full h-full"
                                >
                                  {/* Reference lines at 35% (WT), 70% (PA), 85% (A) */}
                                  <line
                                    x1="0"
                                    y1="15"
                                    x2="100"
                                    y2="15"
                                    stroke={isDark ? '#475569' : '#cbd5e1'}
                                    strokeDasharray="2,2"
                                    strokeWidth="0.8"
                                  />
                                  <line
                                    x1="0"
                                    y1="30"
                                    x2="100"
                                    y2="30"
                                    stroke={isDark ? '#475569' : '#cbd5e1'}
                                    strokeDasharray="2,2"
                                    strokeWidth="0.8"
                                  />
                                  <line
                                    x1="0"
                                    y1="65"
                                    x2="100"
                                    y2="65"
                                    stroke={isDark ? '#475569' : '#cbd5e1'}
                                    strokeDasharray="2,2"
                                    strokeWidth="0.8"
                                  />
                                  <rect
                                    x="22"
                                    y={barY}
                                    width="56"
                                    height={barHeight}
                                    rx="2"
                                    className={barFillClass}
                                  />
                                </svg>
                              </div>

                              <div className="space-y-1.5">
                                <div
                                  className={`text-xs space-y-0.5 ${getTargetFontColorClass(
                                    item.fontColor
                                  )}`}
                                  title={item.title}
                                >
                                  {item.heading && (
                                    <div className="font-bold whitespace-pre-wrap break-words">
                                      {item.heading}
                                    </div>
                                  )}
                                  <p className="font-normal whitespace-pre-wrap break-words">
                                    {item.title}
                                  </p>
                                  {item.challenge && (
                                    <p className="font-bold whitespace-pre-wrap break-words">
                                      Challenge: {item.challenge}
                                    </p>
                                  )}
                                </div>
                                <div
                                  className={`text-[11px] font-mono ${
                                    isDark ? 'text-slate-400' : 'text-slate-500'
                                  }`}
                                >
                                  {item.trackedCount}/{item.applicableCount} subject(s) tracked
                                </div>
                                {item.subjectRatings.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                    {item.subjectRatings.map((sr) => {
                                      const pillTone =
                                        sr.rating === 'M'
                                          ? 'bg-purple-600 text-white border-purple-700'
                                          : sr.rating === 'A'
                                          ? 'bg-emerald-600 text-white border-emerald-700'
                                          : sr.rating === 'PA'
                                          ? 'bg-sky-600 text-white border-sky-700'
                                          : sr.rating === 'WT'
                                          ? 'bg-amber-500 text-white border-amber-600'
                                          : sr.rating === 'NA'
                                          ? 'bg-slate-600 text-white border-slate-700'
                                          : isDark
                                          ? 'bg-slate-700 text-slate-300 border-slate-600'
                                          : 'bg-slate-100 text-slate-500 border-slate-200';
                                      return (
                                        <span
                                          key={sr.subject}
                                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${pillTone}`}
                                        >
                                          <span>{sr.subject}:</span>
                                          <strong>
                                            {RATING_METADATA[sr.rating].code}
                                          </strong>
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* SECTION 2: SUBJECTS, TEACHERS & ASSIGNED LSAs */}
                <div className="bg-white border border-slate-200 text-slate-900 rounded-lg p-5 space-y-4 shadow-xs">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Subjects, Teachers &amp; Assigned LSAs ({activeStudentSubjects.length})
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const defaultChecked: Record<string, boolean> = {};
                        activeStudentUniqueTargetTitles.forEach((t) => {
                          defaultChecked[t] = true;
                        });
                        setSelectedApplicableTargets(defaultChecked);
                        setShowAddSubjectForm(true);
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-md inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors bg-slate-900 hover:bg-slate-800 text-white"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Subject &amp; LSA
                    </button>
                  </div>

                  {activeStudentSubjects.length === 0 ? (
                    <div className="p-6 text-center text-xs border border-dashed rounded-lg border-slate-200 text-slate-500">
                      No subjects added yet. Click <strong>Add Subject &amp; LSA</strong>.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {activeStudentSubjects.map((subjGroup) => {
                        const isSubjectExpanded = Boolean(
                          expandedSubjects[subjGroup.subject]
                        );
                        return (
                          <div
                            key={subjGroup.subject}
                            className="rounded-lg border overflow-hidden border-slate-200 bg-slate-50/50 shadow-2xs"
                          >
                            {/* Subject Header Row: Subject Name, Teacher (Data), and LSA (Staff Portal) */}
                            <div
                              onClick={() =>
                                setExpandedSubjects((prev) => ({
                                  ...prev,
                                  [subjGroup.subject]: !prev[subjGroup.subject],
                                }))
                              }
                              className="p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer hover:bg-slate-100/70 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                {isSubjectExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                                )}
                                <BookOpen className="w-4 h-4 shrink-0 text-slate-700" />
                                <span className="text-sm font-bold text-slate-900">
                                  {subjGroup.subject}
                                </span>
                              </div>

                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="flex flex-wrap items-center gap-2 text-xs min-w-0 max-w-full"
                              >
                                {/* Subject Teacher (Data / Record) */}
                                <div className="flex items-center gap-1.5 bg-white border border-slate-300 px-2.5 py-1 rounded shadow-2xs max-w-full">
                                  <span className="text-slate-500 font-semibold">Teacher:</span>
                                  {editingSubjectTeacher?.subject === subjGroup.subject ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="text"
                                        value={editingSubjectTeacher.teacherName}
                                        onChange={(e) =>
                                          setEditingSubjectTeacher({
                                            subject: subjGroup.subject,
                                            teacherName: e.target.value,
                                          })
                                        }
                                        className="text-xs border border-slate-300 rounded px-1.5 py-0.5 w-32 bg-white text-slate-900"
                                        placeholder="Teacher Name"
                                        autoFocus
                                      />
                                      <button
                                        type="button"
                                        disabled={isSavingTeacher}
                                        onClick={() =>
                                          handleSaveSubjectTeacher(
                                            activeStudentRow.student,
                                            subjGroup.subject,
                                            editingSubjectTeacher.teacherName
                                          )
                                        }
                                        className="p-1 text-emerald-600 hover:text-emerald-700 font-bold"
                                        title="Save Teacher Name"
                                      >
                                        <Check className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingSubjectTeacher(null)}
                                        className="p-1 text-slate-400 hover:text-slate-600"
                                        title="Cancel"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1">
                                      <span className="font-bold text-slate-900">
                                        {subjGroup.teacherName || 'Not Set'}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setEditingSubjectTeacher({
                                            subject: subjGroup.subject,
                                            teacherName: subjGroup.teacherName || '',
                                          })
                                        }
                                        className="p-0.5 text-slate-400 hover:text-slate-700 transition-colors"
                                        title="Click to edit Teacher Name"
                                      >
                                        <Pencil className="w-3 h-3" />
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Assigned LSA (Staff Portal) */}
                                <div className="flex items-center gap-1.5 bg-white border border-slate-300 px-2.5 py-1 rounded shadow-2xs min-w-0 max-w-full">
                                  <span className="text-slate-500 font-semibold shrink-0">
                                    LSA:
                                  </span>
                                  <select
                                    value={subjGroup.lsaEmail || subjGroup.staffEmail}
                                    onChange={(e) =>
                                      handleChangeSubjectStaff(
                                        activeStudentRow.student,
                                        subjGroup.subject,
                                        e.target.value
                                      )
                                    }
                                    className="text-xs font-bold text-slate-900 bg-transparent focus:outline-none cursor-pointer min-w-0 max-w-[200px] sm:max-w-[240px] truncate"
                                  >
                                    {assignableStaff.map((st) => (
                                      <option key={st.id} value={st.email}>
                                        {st.name} ({st.email})
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    const orderedTitles =
                                      activeStudentGroupedTargets.flatEntries.map(
                                        (e) => e.item.title
                                      );
                                    const subjectTargets = orderedTitles
                                      .map((t) => subjGroup.targetsByTitle[t])
                                      .filter(
                                        (tgt): tgt is Target =>
                                          Boolean(tgt && tgt.trackingRequired)
                                      );
                                    const exportList =
                                      subjectTargets.length > 0
                                        ? subjectTargets
                                        : orderedTitles.map((title) => {
                                            const m =
                                              activeStudentTargetMetaByTitle[
                                                title
                                              ];
                                            return {
                                              targetGroupId:
                                                m?.targetGroupId || '',
                                              heading: m?.heading || '',
                                              title,
                                              challenge: m?.challenge || '',
                                              suggestedStrategies:
                                                m?.suggestedStrategies || '',
                                              fontColor:
                                                m?.fontColor || 'black',
                                            };
                                          });
                                    exportStudentTargetsPdf({
                                      studentName: activeStudentRow.student.name,
                                      yearGroup: formatStudentYearAndGroup(
                                        activeStudentRow.student
                                      ),
                                      term: currentTerm || 'TERM 1',
                                      teacherName:
                                        subjGroup.teacherName ||
                                        'Class Teacher',
                                      subject: subjGroup.subject,
                                      targets: exportList,
                                    });
                                  }}
                                  className="px-2.5 py-1 text-[11px] font-bold rounded inline-flex items-center gap-1 whitespace-nowrap shadow-xs transition-colors bg-amber-400 hover:bg-amber-300 text-slate-950"
                                  title={`Export ${subjGroup.subject} W3 IEP Targets PDF`}
                                >
                                  <Download className="w-3 h-3" />
                                  Target Export
                                </button>

                                {onOpenStaffSharePreview && (subjGroup.lsaEmail || subjGroup.staffEmail) && (subjGroup.lsaEmail !== 'none') && (
                                  <button
                                    type="button"
                                    onClick={() => onOpenStaffSharePreview(subjGroup.lsaEmail || subjGroup.staffEmail)}
                                    className="px-2.5 py-1 text-[11px] font-semibold rounded inline-flex items-center gap-1 whitespace-nowrap shadow-xs transition-colors bg-slate-900 hover:bg-slate-800 text-white"
                                    title={`Open ${subjGroup.lsaName || subjGroup.staffName}'s LSA dashboard directly in app`}
                                  >
                                    <User className="w-3 h-3" />
                                    Open LSA View
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Expanded Checklist of Active Targets for this Subject */}
                            {isSubjectExpanded && (
                              <div
                                className={`px-3.5 pb-3.5 pt-2.5 border-t space-y-1.5 ${
                                  isDark
                                    ? 'bg-slate-850 border-slate-750'
                                    : 'bg-white border-slate-200/80'
                                }`}
                              >
                                {activeStudentGroupedTargets.flatEntries.map(
                                  (entry) => {
                                    const title = entry.item.title;
                                    const tgtDoc =
                                      subjGroup.targetsByTitle[title];
                                    const isApplicable = Boolean(
                                      tgtDoc?.trackingRequired
                                    );
                                    const weekRating = tgtDoc
                                      ? getTargetRatingForWeek(
                                          tgtDoc,
                                          currentWeekInfo.weekKey
                                        )
                                      : 'UNTRACKED';
                                    const statusCode =
                                      RATING_METADATA[weekRating].code;

                                    return (
                                      <div
                                        key={title}
                                        className={`flex items-center justify-between gap-3 p-2.5 rounded border text-xs transition-colors ${
                                          isApplicable
                                            ? isDark
                                              ? 'bg-slate-800 border-slate-700 text-slate-100'
                                              : 'bg-white border-slate-200 text-slate-900'
                                            : isDark
                                            ? 'bg-slate-900/40 border-slate-800 text-slate-500'
                                            : 'bg-slate-100/70 border-slate-200 text-slate-400'
                                        }`}
                                      >
                                        <label className="flex items-start gap-2.5 cursor-pointer flex-1 min-w-0">
                                          <input
                                            type="checkbox"
                                            className="mt-0.5"
                                            checked={isApplicable}
                                            onChange={() =>
                                              handleToggleTargetApplicableInSubject(
                                                activeStudentRow.student,
                                                subjGroup,
                                                title
                                              )
                                            }
                                          />
                                          <span className="font-mono font-bold text-slate-400 mt-0.5 shrink-0">
                                            {entry.displayNumber}
                                          </span>
                                          <div
                                            className={`space-y-0.5 min-w-0 flex-1 ${getTargetFontColorClass(
                                              activeStudentTargetMetaByTitle[title]?.fontColor,
                                              isApplicable
                                            )}`}
                                          >
                                            {activeStudentTargetMetaByTitle[title]?.heading && (
                                              <div className="font-bold whitespace-pre-wrap break-words">
                                                {activeStudentTargetMetaByTitle[title].heading}
                                              </div>
                                            )}
                                            {activeStudentTargetMetaByTitle[title]?.internalNote && (
                                              <div
                                                className={`my-1 px-2 py-1 rounded border text-xs font-medium whitespace-pre-wrap break-words ${
                                                  isApplicable
                                                    ? 'bg-red-50/70 border-red-200 text-red-600'
                                                    : 'bg-red-50/30 border-red-100 text-red-400'
                                                }`}
                                              >
                                                <span className="font-bold">Note: </span>
                                                {activeStudentTargetMetaByTitle[title].internalNote}
                                              </div>
                                            )}
                                            <div className="font-normal whitespace-pre-wrap break-words">
                                              {title}
                                            </div>
                                            {activeStudentTargetMetaByTitle[title]?.challenge && (
                                              <div className="font-bold whitespace-pre-wrap break-words">
                                                Challenge: {activeStudentTargetMetaByTitle[title].challenge}
                                              </div>
                                            )}
                                            {activeStudentTargetMetaByTitle[title]?.suggestedStrategies && (
                                              <div
                                                className={`font-normal whitespace-pre-wrap break-words ${
                                                  isApplicable
                                                    ? 'text-slate-600'
                                                    : 'text-slate-400'
                                                }`}
                                              >
                                                <span className="font-semibold">
                                                  Suggested Strategies:{' '}
                                                </span>
                                                {activeStudentTargetMetaByTitle[title].suggestedStrategies}
                                              </div>
                                            )}
                                          </div>
                                        </label>

                                        <div className="shrink-0 font-mono text-[11px]">
                                          {!isApplicable ? (
                                            <span className="text-slate-500">
                                              Not Applicable (Light Grey / Disabled)
                                            </span>
                                          ) : (
                                            <span
                                              className={`font-semibold ${
                                                isDark
                                                  ? 'text-slate-300'
                                                  : 'text-slate-700'
                                              }`}
                                            >
                                              Week {currentWeekInfo.weekNumber}:{' '}
                                              {statusCode}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  }
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: STAFF PROGRESS AUDIT */}
      {activeTab === 'STAFF_OVERVIEW' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Staff Progress Audit · {currentTerm || 'NO ACTIVE TERM'} — Week{' '}
                  {auditWeekInfo.weekNumber} ({auditWeekInfo.rangeLabel})
                </h2>
                <span className="text-xs text-slate-500">
                  Tracked vs not tracked yet per staff member
                </span>
              </div>

              {/* Week Selector */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {auditWeeks.map((wk, idx) => {
                  const offsetVal = -idx;
                  const isActive = auditWeekOffset === offsetVal;
                  return (
                    <button
                      key={wk.weekKey}
                      type="button"
                      onClick={() => setAuditWeekOffset(offsetVal)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors ${
                        isActive
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Week {wk.weekNumber}
                      {idx === 0 ? ' (Active)' : ''}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Summary Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="border border-slate-200 rounded-md px-3 py-2 bg-slate-50/70">
                <div className="text-[11px] text-slate-500 font-medium">
                  Staff Listed
                </div>
                <div className="text-base font-bold text-slate-900 font-mono">
                  {auditSummaryStats.totalStaff}
                </div>
              </div>
              <div className="border border-emerald-200 rounded-md px-3 py-2 bg-emerald-50/60">
                <div className="text-[11px] text-emerald-700 font-medium">
                  All Tracked
                </div>
                <div className="text-base font-bold text-emerald-800 font-mono">
                  {auditSummaryStats.allTrackedStaff}
                </div>
              </div>
              <div className="border border-amber-200 rounded-md px-3 py-2 bg-amber-50/60">
                <div className="text-[11px] text-amber-800 font-medium">
                  Not Tracked Yet
                </div>
                <div className="text-base font-bold text-amber-900 font-mono">
                  {auditSummaryStats.pendingStaff}
                </div>
              </div>
              <div className="border border-slate-200 rounded-md px-3 py-2 bg-slate-50/70">
                <div className="text-[11px] text-slate-500 font-medium">
                  Targets Tracked
                </div>
                <div className="text-base font-bold text-slate-900 font-mono">
                  {auditSummaryStats.trackedTargets} / {auditSummaryStats.totalTargets}
                </div>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-1.5 flex-wrap">
                {(
                  [
                    {
                      id: 'ALL',
                      label: `All (${auditSummaryStats.totalStaff})`,
                    },
                    {
                      id: 'PENDING',
                      label: `Not Tracked Yet (${auditSummaryStats.pendingStaff})`,
                    },
                    {
                      id: 'COMPLETE',
                      label: `All Tracked (${auditSummaryStats.allTrackedStaff})`,
                    },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setAuditStatusFilter(f.id)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors ${
                      auditStatusFilter === f.id
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={auditSearchQuery}
                  onChange={(e) => setAuditSearchQuery(e.target.value)}
                  placeholder="Search staff, student, subject..."
                  className="w-full text-xs border border-slate-300 rounded-md pl-8 pr-3 py-1.5 bg-white text-slate-900 focus:outline-none focus:border-slate-500"
                />
              </div>
            </div>
          </div>

          {!currentTerm ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-lg p-8 text-center text-xs text-slate-500">
              No active term selected. Add or restore a term to view staff progress audit.
            </div>
          ) : filteredStaffRows.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-lg p-8 text-center text-xs text-slate-500">
              No staff records match your filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredStaffRows.map((row) => (
                <div
                  key={row.staff.id}
                  className={`p-4 rounded-lg border transition-colors flex flex-col gap-3 ${
                    row.isAllTracked
                      ? 'bg-emerald-50/60 border-emerald-400'
                      : row.untrackedStudents.length > 0
                      ? 'bg-white border-amber-300'
                      : 'bg-slate-50/70 border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-slate-900 truncate">
                          {row.staff.name}
                        </span>
                        <span className="text-xs text-slate-500">
                          ({row.staff.department})
                        </span>
                        {row.isAllTracked ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-600 text-white">
                            All Tracked
                          </span>
                        ) : row.untrackedStudents.length > 0 ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500 text-white">
                            {row.untrackedTargetsCount} Not Tracked Yet
                          </span>
                        ) : (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-600">
                            No Students Assigned
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-slate-500 truncate mt-0.5">
                        {row.staff.email}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {onOpenStaffSharePreview && (
                        <button
                          type="button"
                          onClick={() => onOpenStaffSharePreview(row.staff.email)}
                          className="px-2 py-1 text-[11px] font-semibold rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                          title={`Open ${row.staff.name}'s Staff View`}
                        >
                          <User className="w-3 h-3" />
                          View
                        </button>
                      )}
                      {!row.isAllTracked && row.untrackedStudents.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            handleSendReminder(
                              row.staff,
                              row.untrackedStudents
                            )
                          }
                          className="px-2.5 py-1 text-xs font-medium rounded-md inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors bg-slate-900 hover:bg-slate-800 text-white"
                        >
                          <Send className="w-3 h-3" />
                          Remind
                        </button>
                      )}
                      {!row.staff.id.startsWith('audit_') &&
                        row.staff.email.trim().toLowerCase() !==
                          (auth.currentUser?.email || '').trim().toLowerCase() && (
                          <button
                            type="button"
                            onClick={() => setPendingDeleteStaff(row.staff)}
                            title={`Delete ${row.staff.name}`}
                            className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                    </div>
                  </div>

                  {/* Progress Summary Bar */}
                  {row.hasAssignments && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-600">
                        <span>
                          {row.trackedTargetsCount}/{row.totalTargetsCount} targets
                          tracked
                        </span>
                        <span className="font-bold">{row.completionPct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-200/80 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-200 ${
                            row.isAllTracked ? 'bg-emerald-600' : 'bg-amber-500'
                          }`}
                          style={{ width: `${row.completionPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Tracked vs Not Tracked Yet Lists */}
                  <div className="pt-2.5 border-t border-slate-200/70 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1.5">
                      <div className="font-semibold text-emerald-800 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Tracked ({row.trackedStudents.length})</span>
                      </div>
                      {row.trackedStudents.length === 0 ? (
                        <div className="text-slate-400">None</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {row.trackedStudents.map((item) => (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => {
                                setSelectedStudentId(item.studentId);
                                setActiveTab('STUDENTS');
                              }}
                              className="text-left px-2 py-1 rounded border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-medium text-[11px] transition-colors"
                              title={`Open ${item.studentName}'s profile`}
                            >
                              <span className="font-semibold">
                                {item.studentName}
                              </span>{' '}
                              <span className="text-emerald-700">
                                · {item.subject} ({item.tracked}/{item.total})
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <div className="font-semibold text-amber-900 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-amber-600" />
                        <span>
                          Not Tracked Yet ({row.untrackedStudents.length})
                        </span>
                      </div>
                      {row.untrackedStudents.length === 0 ? (
                        <div className="text-emerald-700 font-medium">None</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {row.untrackedStudents.map((item) => (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => {
                                setSelectedStudentId(item.studentId);
                                setActiveTab('STUDENTS');
                              }}
                              className="text-left px-2 py-1 rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-950 font-medium text-[11px] transition-colors"
                              title={`Open ${item.studentName}'s profile`}
                            >
                              <span className="font-semibold">
                                {item.studentName}
                              </span>{' '}
                              <span className="text-amber-800">
                                · {item.subject} ({item.tracked}/{item.total})
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: DATA SUMMARY */}
      {activeTab === 'DATA_SUMMARY' && (
        <DataSummaryTab
          students={students}
          targets={currentTermTargets}
          weekSetup={{ ...weekSetup, term: currentTerm }}
        />
      )}

      {/* TAB 4: STAFF MANAGEMENT & SHARE LINKS */}
      {activeTab === 'STAFF_MANAGEMENT' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4">
            <form
              onSubmit={handleInviteUser}
              className={`${
                isDark
                  ? 'bg-slate-850 border-slate-750 text-slate-100'
                  : 'bg-white border-slate-200 text-slate-900'
              } border rounded-lg p-5 space-y-3.5 transition-colors`}
            >
              <div className="flex items-center gap-2">
                <UserPlus
                  className={`w-4 h-4 ${
                    isDark ? 'text-indigo-400' : 'text-slate-700'
                  }`}
                />
                <h2
                  className={`text-sm font-bold ${
                    isDark ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  Add User to Staff Management
                </h2>
              </div>

              <div>
                <label
                  className={`block text-xs font-medium mb-1 ${
                    isDark ? 'text-slate-300' : 'text-slate-700'
                  }`}
                >
                  Full Name *
                </label>
                <input
                  type="text"
                  required
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Sarah Jenkins"
                  className={`w-full text-sm border rounded-md px-3 py-1.5 ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-400'
                      : 'border-slate-300'
                  }`}
                />
              </div>

              <div>
                <label
                  className={`block text-xs font-medium mb-1 ${
                    isDark ? 'text-slate-300' : 'text-slate-700'
                  }`}
                >
                  Google Login Email *
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="sarah.jenkins@gmail.com"
                  className={`w-full text-sm border rounded-md px-3 py-1.5 font-mono ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-400'
                      : 'border-slate-300'
                  }`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className={`block text-xs font-medium mb-1 ${
                      isDark ? 'text-slate-300' : 'text-slate-700'
                    }`}
                  >
                    Subject / Dept *
                  </label>
                  <input
                    type="text"
                    required
                    value={inviteDept}
                    onChange={(e) => setInviteDept(e.target.value)}
                    placeholder="Mathematics"
                    className={`w-full text-sm border rounded-md px-3 py-1.5 ${
                      isDark
                        ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-400'
                        : 'border-slate-300'
                    }`}
                  />
                </div>

                <div>
                  <label
                    className={`block text-xs font-medium mb-1 ${
                      isDark ? 'text-slate-300' : 'text-slate-700'
                    }`}
                  >
                    Access Role *
                  </label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as UserRole)}
                    className={`w-full text-sm border rounded-md px-3 py-1.5 font-semibold ${
                      isDark
                        ? 'bg-slate-800 border-slate-700 text-slate-200'
                        : 'bg-white border-slate-300'
                    }`}
                  >
                    <option value="STAFF">Staff (Tracker Only)</option>
                    <option value="ADMIN">Administrator</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={isInviting}
                className={`w-full py-2 px-4 text-xs font-semibold rounded-md transition-colors ${
                  isDark
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                }`}
              >
                {isInviting ? 'Adding...' : `Add & Invite as ${inviteRole}`}
              </button>
            </form>
          </div>

          <div
            className={`lg:col-span-7 border rounded-lg p-5 space-y-3 transition-colors ${
              isDark
                ? 'bg-slate-850 border-slate-750 text-slate-100'
                : 'bg-white border-slate-200 text-slate-900'
            }`}
          >
            <div className="space-y-1">
              <h3
                className={`text-sm font-bold ${
                  isDark ? 'text-white' : 'text-slate-900'
                }`}
              >
                Staff Directory ({staffList.length})
              </h3>
            </div>

            <div
              className={`divide-y ${
                isDark ? 'divide-slate-750' : 'divide-slate-100'
              }`}
            >
              {staffList.map((user) => {
                const userShareUrl = buildStaffShareLink(user.email);
                const isCopied = copiedLinkKey === `dir_${user.id}`;
                const isDetailsOpen = expandedLoginDetailsId === user.id;
                const isDetailsCopied = copiedLoginDetailsId === user.id;
                return (
                  <div key={user.id} className="py-3 space-y-2 text-xs">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div
                          className={`font-semibold ${
                            isDark ? 'text-white' : 'text-slate-900'
                          }`}
                        >
                          {user.name}
                        </div>
                        <div
                          className={`truncate ${
                            isDark ? 'text-slate-400' : 'text-slate-500'
                          }`}
                        >
                          {user.department} ·{' '}
                          <span className="font-mono">{user.email}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleToggleViewLoginDetails(user)}
                          className={`px-2.5 py-1 text-xs font-semibold border rounded inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
                            isDetailsOpen
                              ? 'bg-indigo-600 border-indigo-600 text-white'
                              : isDark
                              ? 'bg-slate-800 border-slate-700 text-indigo-300 hover:bg-slate-700'
                              : 'border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100'
                          }`}
                          title="View username, 4-digit PIN, and direct link"
                        >
                          <KeyRound className="w-3 h-3" />
                          <span>View Login Details</span>
                        </button>

                        {user.role !== 'ADMIN' && (
                          <a
                            href={userShareUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`px-2.5 py-1 text-xs font-medium border rounded inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
                              isDark
                                ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                            title="Open this staff member's direct dashboard in a new tab"
                          >
                            <ExternalLink
                              className={`w-3 h-3 ${
                                isDark ? 'text-slate-400' : 'text-slate-500'
                              }`}
                            />
                            <span className="hidden sm:inline">New Tab</span>
                          </a>
                        )}

                        <button
                          type="button"
                          onClick={() =>
                            handleCopyShareLink(
                              userShareUrl,
                              `dir_${user.id}`,
                              user.name,
                              user.email
                            )
                          }
                          className={`px-2.5 py-1 text-xs font-medium border rounded inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
                            isDark
                              ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {isCopied ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Link2 className="w-3 h-3" />
                          )}
                          {isCopied ? 'Copied' : 'Copy Link'}
                        </button>

                        <select
                          value={user.role || 'STAFF'}
                          onChange={(e) =>
                            handleUpdateUserRole(
                              user,
                              e.target.value as UserRole
                            )
                          }
                          className={`text-xs border rounded px-2 py-1 font-medium ${
                            isDark
                              ? 'bg-slate-800 border-slate-700 text-slate-200'
                              : 'border-slate-300 bg-white text-slate-900'
                          }`}
                        >
                          <option value="STAFF">Role: Staff</option>
                          <option value="ADMIN">Role: Admin</option>
                        </select>

                        <button
                          type="button"
                          disabled={
                            user.email.trim().toLowerCase() ===
                            (auth.currentUser?.email || '').trim().toLowerCase()
                          }
                          onClick={() => setPendingDeleteStaff(user)}
                          title={
                            user.email.trim().toLowerCase() ===
                            (auth.currentUser?.email || '').trim().toLowerCase()
                              ? 'Cannot delete active signed-in account'
                              : `Delete ${user.name}`
                          }
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {isDetailsOpen && (
                      <div
                        className={`rounded-md border p-3 space-y-2 ${
                          isDark
                            ? 'bg-slate-900 border-indigo-700/60 text-slate-200'
                            : 'bg-indigo-50/70 border-indigo-200 text-slate-900'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-indigo-700">
                            Login Details — {user.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const detailsText = `TargetTrack Login Details (${user.name})\nUsername: ${user.email}\n4-Digit PIN: ${user.pin || 'Not assigned yet'}\nDirect Link: ${userShareUrl}`;
                              copyToClipboardFallback(detailsText);
                              navigator.clipboard?.writeText(detailsText).catch(() => {});
                              setCopiedLoginDetailsId(user.id);
                              notify(`Copied login details for ${user.name}.`);
                              setTimeout(() => {
                                setCopiedLoginDetailsId((prev) =>
                                  prev === user.id ? null : prev
                                );
                              }, 2500);
                            }}
                            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center gap-1"
                          >
                            {isDetailsCopied ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <KeyRound className="w-3 h-3" />
                            )}
                            <span>
                              {isDetailsCopied
                                ? 'Copied Details'
                                : 'Copy Login Details'}
                            </span>
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div
                            className={`rounded border px-2.5 py-1.5 ${
                              isDark
                                ? 'bg-slate-800 border-slate-700'
                                : 'bg-white border-indigo-200'
                            }`}
                          >
                            <div className="text-[10px] font-semibold uppercase text-slate-500">
                              Username (Registered Email)
                            </div>
                            <div className="font-mono font-bold text-xs break-all select-all">
                              {user.email}
                            </div>
                          </div>

                          <div
                            className={`rounded border px-2.5 py-1.5 ${
                              isDark
                                ? 'bg-slate-800 border-slate-700'
                                : 'bg-white border-indigo-200'
                            }`}
                          >
                            <div className="text-[10px] font-semibold uppercase text-slate-500">
                              Fixed 4-Digit PIN Password
                            </div>
                            <div className="font-mono font-black text-base tracking-widest text-indigo-700 select-all">
                              {user.pin || 'Generating...'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <input
                      type="text"
                      readOnly
                      value={userShareUrl}
                      onFocus={(e) => {
                        recordCopiedStaffIntent(user.email);
                        e.currentTarget.select();
                      }}
                      onCopy={() => recordCopiedStaffIntent(user.email)}
                      className={`w-full text-[11px] font-mono border rounded px-2.5 py-1 select-all ${
                        isDark
                          ? 'bg-slate-900 border-slate-800 text-slate-300'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ARCHIVED FOLDERS TAB CONTENT */}
      {activeTab === 'ARCHIVES' && (
        <div className="space-y-6">
          {viewingArchive ? (
            /* ARCHIVE VIEWER */
            <div className="space-y-6">
              {/* Back & Archive Folder Header */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setViewingArchive(null)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span>Back to Archived Folders</span>
                    </button>
                    <div className="flex items-center gap-2">
                      <FolderArchive className="w-5 h-5 text-indigo-600" />
                      <h2 className="text-lg font-black text-slate-900">
                        {viewingArchive.folderName}
                      </h2>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-mono font-bold uppercase rounded-md bg-amber-400 text-slate-950 border border-amber-500/40">
                      <Bookmark className="w-3 h-3" />
                      {formatTermTitleWithYear(
                        viewingArchive.term,
                        viewingArchive.academicYear
                      )}
                    </span>
                    <span className="inline-flex items-center px-2.5 py-1 text-xs text-slate-500 bg-slate-50 rounded-md border border-slate-200">
                      Archived: {viewingArchive.archivedAtLabel}
                    </span>
                    <button
                      type="button"
                      disabled={isRestoringArchiveId === viewingArchive.id}
                      onClick={() => handleRestoreArchivedTerm(viewingArchive)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>
                        {isRestoringArchiveId === viewingArchive.id
                          ? 'Restoring...'
                          : 'Restore Term'}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      <strong>Schedule:</strong> {viewingArchive.weekRangeText} ({viewingArchive.dateRangeLabel})
                    </span>
                    <span>
                      <strong>Captured:</strong> {viewingArchive.totalStudents} Students · {viewingArchive.totalTargets} Targets
                    </span>
                    {viewingArchive.notes && (
                      <span className="italic text-slate-500">
                        "{viewingArchive.notes}"
                      </span>
                    )}
                  </div>

                  {/* Archive Sub-Tabs */}
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setArchiveActiveView('DATA_SUMMARY')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-md transition-colors ${
                        archiveActiveView === 'DATA_SUMMARY'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <BarChart3 className="w-3.5 h-3.5" />
                      <span>Data Summary</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setArchiveActiveView('STUDENTS')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-md transition-colors ${
                        archiveActiveView === 'STUDENTS'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>Student Profiles ({viewingArchive.totalStudents})</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Sub-view: Archived Data Summary */}
              {archiveActiveView === 'DATA_SUMMARY' && (
                <div className="space-y-4">
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-center justify-between">
                    <span className="font-semibold">
                      Archive: {viewingArchive.folderName} ({viewingArchive.term} · {viewingArchive.academicYear})
                    </span>
                  </div>
                  <DataSummaryTab
                    students={viewingArchive.studentsSnapshot}
                    targets={viewingArchive.targetsSnapshot}
                    weekSetup={viewingArchive.weekSetupSnapshot}
                  />
                </div>
              )}

              {/* Sub-view: Archived Students Individual Profiles */}
              {archiveActiveView === 'STUDENTS' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Student List Sidebar */}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                        Archived Students ({viewingArchive.studentsSnapshot.length})
                      </h3>
                      <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
                        {viewingArchive.studentsSnapshot.map((student) => {
                          const isSelected =
                            (archiveSelectedStudentId || viewingArchive.studentsSnapshot[0]?.id) ===
                            student.id;
                          const studentTgts = viewingArchive.targetsSnapshot.filter(
                            (t) => t.studentId === student.id
                          );
                          return (
                            <button
                              key={student.id}
                              type="button"
                              onClick={() => setArchiveSelectedStudentId(student.id)}
                              className={`w-full text-left p-3 rounded-lg border transition-all ${
                                isSelected
                                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                                  : 'bg-white hover:bg-slate-50 text-slate-900 border-slate-200'
                              }`}
                            >
                              <div className="font-bold text-sm">{student.name}</div>
                              <div className={`text-xs ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                                {student.yearGroup} · {studentTgts.length} Targets
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Student Profile Details */}
                    <div className="md:col-span-2 space-y-4">
                      {(() => {
                        const targetStudent =
                          viewingArchive.studentsSnapshot.find(
                            (s) =>
                              s.id ===
                              (archiveSelectedStudentId ||
                                viewingArchive.studentsSnapshot[0]?.id)
                          ) || viewingArchive.studentsSnapshot[0];

                        if (!targetStudent) {
                          return (
                            <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-500 text-sm">
                              No student selected.
                            </div>
                          );
                        }

                        const studentTargets = viewingArchive.targetsSnapshot.filter(
                          (t) => t.studentId === targetStudent.id
                        );

                        return (
                          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-5">
                            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                              <div>
                                <h3 className="text-lg font-bold text-slate-900">
                                  {targetStudent.name}
                                </h3>
                                <p className="text-xs text-slate-500">
                                  {targetStudent.yearGroup} · Mentor: {targetStudent.mentorName || 'None'}
                                </p>
                              </div>
                              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
                                Archived Profile Snapshot
                              </span>
                            </div>

                            <div className="space-y-3">
                              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                                Archived Targets &amp; Ratings ({studentTargets.length})
                              </h4>
                              {studentTargets.length === 0 ? (
                                <p className="text-xs text-slate-500 italic">
                                  No targets were associated with this student in this archive.
                                </p>
                              ) : (
                                <div className="space-y-3">
                                  {studentTargets.map((target) => {
                                    const ratingMeta =
                                      target.currentWeekStatus && target.currentWeekStatus !== 'UNTRACKED'
                                        ? RATING_METADATA[target.currentWeekStatus as TrackingRating]
                                        : null;

                                    return (
                                      <div
                                        key={target.id}
                                        className="border border-slate-200 rounded-lg p-3.5 space-y-2 bg-slate-50/50"
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <div className="space-y-0.5">
                                            <div>
                                              <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded bg-slate-200 text-slate-800 uppercase tracking-wider mr-2">
                                                {target.subject}
                                              </span>
                                            </div>
                                            <div
                                              className={`text-sm space-y-0.5 ${getTargetFontColorClass(
                                                target.fontColor
                                              )}`}
                                            >
                                              {target.heading && (
                                                <div className="font-bold whitespace-pre-wrap break-words">
                                                  {target.heading}
                                                </div>
                                              )}
                                              {target.internalNote?.trim() && (
                                                <div className="my-1 px-2 py-1 rounded border border-red-200 bg-red-50/70 text-xs font-medium text-red-600 whitespace-pre-wrap break-words">
                                                  <span className="font-bold">Note: </span>
                                                  {target.internalNote.trim()}
                                                </div>
                                              )}
                                              <div className="font-normal whitespace-pre-wrap break-words">
                                                {target.title}
                                              </div>
                                              {target.challenge && (
                                                <div className="font-bold whitespace-pre-wrap break-words">
                                                  Challenge: {target.challenge}
                                                </div>
                                              )}
                                              {target.suggestedStrategies && (
                                                <div className="font-normal text-slate-600 whitespace-pre-wrap break-words">
                                                  <span className="font-semibold">
                                                    Suggested Strategies:{' '}
                                                  </span>
                                                  {target.suggestedStrategies}
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                          {ratingMeta ? (
                                            <span
                                              className={`text-xs font-bold px-2.5 py-1 rounded-md border ${
                                                target.currentWeekStatus === 'M'
                                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                                  : target.currentWeekStatus === 'A'
                                                  ? 'bg-blue-50 text-blue-800 border-blue-300'
                                                  : target.currentWeekStatus === 'PA'
                                                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                                                  : target.currentWeekStatus === 'WT'
                                                  ? 'bg-orange-50 text-orange-800 border-orange-300'
                                                  : 'bg-slate-100 text-slate-700 border-slate-300'
                                              }`}
                                            >
                                              {ratingMeta.code} · {ratingMeta.label} ({target.progressScore} pts)
                                            </span>
                                          ) : (
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-600">
                                              Untracked
                                            </span>
                                          )}
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-600 pt-1 border-t border-slate-200/60">
                                          <div>
                                            <span className="font-semibold text-slate-700">Teacher:</span>{' '}
                                            {target.teacherName || 'Not specified'}
                                          </div>
                                          <div>
                                            <span className="font-semibold text-slate-700">LSA / Assigned Staff:</span>{' '}
                                            {target.assignedStaffName || target.assignedStaffEmail || 'Not assigned'}
                                          </div>
                                        </div>

                                        {target.weeklyHistorySummary && (
                                          <div className="text-xs text-slate-700 bg-white p-2.5 rounded border border-slate-200">
                                            <span className="font-bold text-slate-900">Notes / History:</span>{' '}
                                            {target.weeklyHistorySummary}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* ARCHIVES LIST VIEW */
            <div className="space-y-6">
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
                <div>
                  <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
                    <FolderArchive className="w-5 h-5 text-indigo-600" />
                    <span>Archived Academic Folders</span>
                  </h2>
                </div>

                {currentTermObj && (
                  <button
                    type="button"
                    onClick={() => {
                      const yr = extractAcademicYearFromTitle(currentTerm);
                      setArchiveAcademicYear(yr);
                      setArchiveTerm(currentTerm);
                      setArchiveFolderName(`${currentTerm} Snapshot`);
                      setShowArchiveConfirmModal(true);
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs transition-colors self-start sm:self-auto shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Archive Current Cycle Data</span>
                  </button>
                )}
              </div>

              {/* Archive Folders Cards or Empty State */}
              {archivesList.length === 0 ? (
                <div className="text-center py-16 px-4 bg-white border border-slate-200 rounded-2xl shadow-xs space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                    <FolderArchive className="w-6 h-6" />
                  </div>
                  <h3 className="text-base font-bold text-slate-900">
                    No Archived Folders Yet
                  </h3>
                  {currentTermObj && (
                    <button
                      type="button"
                      onClick={() => {
                        const yr = extractAcademicYearFromTitle(currentTerm);
                        setArchiveAcademicYear(yr);
                        setArchiveTerm(currentTerm);
                        setArchiveFolderName(`${currentTerm} Snapshot`);
                        setShowArchiveConfirmModal(true);
                      }}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors mt-2"
                    >
                      <FolderArchive className="w-4 h-4" />
                      <span>Create First Archive Snapshot</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {archivesList.map((archive) => (
                    <div
                      key={archive.id}
                      className="bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 shadow-xs transition-all flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg shrink-0">
                              <FolderOpen className="w-5 h-5" />
                            </div>
                            <h3 className="font-bold text-slate-900 text-sm truncate">
                              {archive.folderName}
                            </h3>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleDeleteArchive(archive.id)}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                            title="Delete this archive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-mono font-black uppercase px-2 py-0.5 rounded bg-amber-400 text-slate-950 border border-amber-500/40">
                            {formatTermTitleWithYear(
                              archive.term,
                              archive.academicYear
                            )}
                          </span>
                        </div>

                        <p className="text-xs text-slate-500">
                          Archived on {archive.archivedAtLabel}
                        </p>

                        <div className="text-xs text-slate-600 pt-2 border-t border-slate-100 flex items-center justify-between">
                          <span>{archive.totalStudents} Students</span>
                          <span>{archive.totalTargets} Targets</span>
                        </div>

                        {archive.notes && (
                          <p className="text-[11px] text-slate-500 italic bg-slate-50 p-2 rounded border border-slate-100 line-clamp-2">
                            "{archive.notes}"
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setViewingArchive(archive);
                            setArchiveActiveView('DATA_SUMMARY');
                            setArchiveSelectedStudentId(
                              archive.studentsSnapshot[0]?.id || null
                            );
                          }}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View Contents</span>
                        </button>
                        <button
                          type="button"
                          disabled={isRestoringArchiveId === archive.id}
                          onClick={() => handleRestoreArchivedTerm(archive)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors disabled:opacity-50"
                          title="Restore this term to active dashboard"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>
                            {isRestoringArchiveId === archive.id
                              ? 'Restoring...'
                              : 'Restore Term'}
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* QUICK EDIT TERM MODAL */}
      {isEditingTermModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Bookmark className="w-5 h-5 text-amber-500" />
                <h3 className="font-bold text-slate-900 text-base">
                  Edit Academic Term
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditingTermModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Academic Term &amp; Year (ALL CAPS)
              </label>
              <input
                type="text"
                required
                value={quickTermInput}
                onChange={(e) => setQuickTermInput(e.target.value.toUpperCase())}
                placeholder={`e.g. TERM 1 ${DEFAULT_ACADEMIC_YEAR}`}
                className="w-full text-sm font-mono font-bold uppercase border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-slate-500">Quick suggestions:</span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  `TERM 1 ${DEFAULT_ACADEMIC_YEAR}`,
                  `TERM 2 ${DEFAULT_ACADEMIC_YEAR}`,
                  `TERM 3 ${DEFAULT_ACADEMIC_YEAR}`,
                  `AUTUMN TERM ${DEFAULT_ACADEMIC_YEAR}`,
                  `SPRING TERM ${DEFAULT_ACADEMIC_YEAR}`,
                  `SUMMER TERM ${DEFAULT_ACADEMIC_YEAR}`,
                ].map((sugg) => (
                  <button
                    key={sugg}
                    type="button"
                    onClick={() => setQuickTermInput(sugg)}
                    className="text-[11px] font-mono font-bold uppercase px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                  >
                    {sugg}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsEditingTermModal(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSaveQuickTerm()}
                className="px-4 py-1.5 text-xs font-bold text-slate-950 bg-amber-400 hover:bg-amber-300 border border-amber-500/40 rounded-lg transition-colors"
              >
                Save Term
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD NEW ACADEMIC TERM MODAL (UP TO 3 TERMS) */}
      {showAddTermModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Bookmark className="w-5 h-5 text-amber-500" />
                <h3 className="font-bold text-slate-900 text-base">
                  Add New Academic Term ({termsList.length + 1} of {MAX_ACADEMIC_TERMS})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddTermModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateNewTerm} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Term Name (ALL CAPS) *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTermNameInput}
                    onChange={(e) => setNewTermNameInput(e.target.value.toUpperCase())}
                    placeholder={`e.g. TERM ${termsList.length + 1}`}
                    className="w-full text-sm font-mono font-bold uppercase border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Academic Year *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTermAcademicYear}
                    onChange={(e) => setNewTermAcademicYear(e.target.value)}
                    placeholder="e.g. 2026-2027"
                    className="w-full text-sm font-mono font-bold border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>

              <div className="text-[11px] text-slate-600">
                Title:{' '}
                <span className="font-mono font-bold text-slate-900">
                  {formatTermTitleWithYear(newTermNameInput, newTermAcademicYear)}
                </span>
              </div>

              {/* Suggestions */}
              <div className="space-y-1">
                <span className="text-[11px] font-semibold text-slate-500">Suggestions:</span>
                <div className="flex flex-wrap gap-1.5">
                  {['TERM 1', 'TERM 2', 'TERM 3']
                    .filter(
                      (s) =>
                        !termsList.some(
                          (t) =>
                            t.name ===
                            formatTermTitleWithYear(s, newTermAcademicYear)
                        )
                    )
                    .map((sugg) => (
                      <button
                        key={sugg}
                        type="button"
                        onClick={() => setNewTermNameInput(sugg)}
                        className="text-[11px] font-mono font-bold uppercase px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                      >
                        {sugg} {newTermAcademicYear || DEFAULT_ACADEMIC_YEAR}
                      </button>
                    ))}
                </div>
              </div>

              {/* Lock / Unlock Initial State */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newTermIsLocked}
                    onChange={(e) => setNewTermIsLocked(e.target.checked)}
                    className="w-4 h-4 text-amber-500 rounded border-slate-300 focus:ring-amber-400"
                  />
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-amber-600" />
                    Lock this term
                  </span>
                </label>
                <p className="text-[11px] text-slate-500 pl-6">
                  Staff see a locked notice and cannot track.
                </p>
              </div>

              {/* Option to Import Targets from Previous Term */}
              {termsList.length > 0 && (
                <div className="p-3.5 bg-amber-50/70 border border-amber-200 rounded-lg space-y-2.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newTermImportTargets}
                      onChange={(e) => setNewTermImportTargets(e.target.checked)}
                      className="w-4 h-4 text-amber-500 rounded border-slate-300 focus:ring-amber-400"
                    />
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <Download className="w-3.5 h-3.5 text-amber-700" />
                      Import targets from previous term
                    </span>
                  </label>
                  <p className="text-[11px] text-slate-600 pl-6">
                    Copies targets, subjects, teachers, and LSAs as untracked.
                  </p>

                  {newTermImportTargets && (
                    <div className="pl-6 pt-1 flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-700">Source term:</span>
                      <select
                        value={newTermImportSource}
                        onChange={(e) => setNewTermImportSource(e.target.value)}
                        className="text-xs font-mono font-bold uppercase border border-slate-300 rounded px-2.5 py-1 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                      >
                        {termsList.map((t) => (
                          <option key={t.id || t.name} value={t.name}>
                            {t.name} (
                            {
                              targets.filter((tgt) =>
                                doesTargetMatchTerm(tgt.term, t.name)
                              ).length
                            }{' '}
                            targets)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddTermModal(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isImportingTargets}
                  className="px-4 py-1.5 text-xs font-bold text-slate-950 bg-amber-400 hover:bg-amber-300 border border-amber-500/40 rounded-lg transition-colors inline-flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{isImportingTargets ? 'Importing & Creating...' : 'Create Term'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showArchiveConfirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-full bg-amber-100 text-amber-600 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-slate-900 text-base">
                  Archive &amp; Reset Tracking?
                </h3>
                <p className="text-xs text-slate-600">
                  Snapshots profiles and summary into an archive folder, then resets tracking ratings. Students, targets, and staff remain intact.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowArchiveConfirmModal(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowArchiveConfirmModal(false);
                  setShowArchiveDetailsModal(true);
                }}
                className="px-4 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors inline-flex items-center gap-1.5"
              >
                <span>Proceed to Archive Details</span>
                <span>→</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: ARCHIVE FOLDER DETAILS MODAL */}
      {showArchiveDetailsModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateArchiveAndResetTracking}
            className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4 animate-in fade-in zoom-in duration-150"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <FolderArchive className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 text-base">
                  Archive Folder Details
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowArchiveDetailsModal(false)}
                disabled={isArchiving}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Folder Name *
                </label>
                <input
                  type="text"
                  required
                  value={archiveFolderName}
                  onChange={(e) => setArchiveFolderName(e.target.value)}
                  placeholder="e.g. Term 1 - 2026-2027 Academic Snapshot"
                  className="w-full text-xs font-semibold border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Academic Year *
                  </label>
                  <input
                    type="text"
                    required
                    value={archiveAcademicYear}
                    onChange={(e) => setArchiveAcademicYear(e.target.value)}
                    placeholder="e.g. 2026-2027"
                    className="w-full text-xs font-mono font-semibold border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Term (ALL CAPS) *
                  </label>
                  <input
                    type="text"
                    required
                    value={archiveTerm}
                    onChange={(e) => setArchiveTerm(e.target.value.toUpperCase())}
                    placeholder="e.g. TERM 1"
                    className="w-full text-xs font-mono font-bold uppercase border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Optional Notes / Comments
                </label>
                <textarea
                  rows={2}
                  value={archiveNotes}
                  onChange={(e) => setArchiveNotes(e.target.value)}
                  placeholder="e.g. End of Autumn Term evaluation prior to holiday break."
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowArchiveDetailsModal(false)}
                disabled={isArchiving}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isArchiving}
                className="px-4 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors inline-flex items-center gap-2 disabled:opacity-50"
              >
                {isArchiving ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Archiving &amp; Resetting...</span>
                  </>
                ) : (
                  <>
                    <FolderArchive className="w-3.5 h-3.5" />
                    <span>Confirm Archive &amp; Reset Tracking</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* DELETE STUDENT CONFIRMATION MODAL */}
      {pendingDeleteStudent && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-rose-50 text-rose-600 shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    Delete Student
                  </h3>
                  <p className="text-xs text-slate-500">
                    {pendingDeleteStudent.name} · {pendingDeleteStudent.yearGroup}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={() => setPendingDeleteStudent(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Delete <span className="font-bold text-slate-900">{pendingDeleteStudent.name}</span> and all of their targets? This cannot be undone.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={() => setPendingDeleteStudent(null)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={handleConfirmDeleteStudent}
                className="px-4 py-1.5 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isDeletingRecord ? 'Deleting...' : 'Delete Student'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE STAFF CONFIRMATION MODAL */}
      {pendingDeleteStaff && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-rose-50 text-rose-600 shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    Delete Staff Member
                  </h3>
                  <p className="text-xs text-slate-500">
                    {pendingDeleteStaff.name} · {pendingDeleteStaff.email}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={() => setPendingDeleteStaff(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Delete <span className="font-bold text-slate-900">{pendingDeleteStaff.name}</span> from Staff Management? Any targets assigned to them will become unassigned.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={() => setPendingDeleteStaff(null)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingRecord}
                onClick={handleConfirmDeleteStaff}
                className="px-4 py-1.5 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isDeletingRecord ? 'Deleting...' : 'Delete Staff'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD STUDENT MODAL */}
      {showAddStudentModal && (
        <div
          data-student-create="true"
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleAddStudentFromModal}
            className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-slate-800" />
                <h3 className="font-bold text-slate-900 text-base">
                  Add Student
                </h3>
              </div>
              <button
                type="button"
                disabled={isCreatingStudent}
                onClick={() => setShowAddStudentModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Student Name *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={100}
                  value={addStudentModalName}
                  onChange={(e) => setAddStudentModalName(e.target.value)}
                  placeholder="e.g. Jordan Smith"
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Year &amp; Group *
                </label>
                <input
                  type="text"
                  required
                  maxLength={40}
                  value={addStudentModalYear}
                  onChange={(e) => setAddStudentModalYear(e.target.value)}
                  placeholder="e.g. Year 10 · Group A"
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {[
                    'Year 7 · Group A',
                    'Year 8 · Group B',
                    'Year 9 · Group A',
                    'Year 10 · Group A',
                    'Year 11 · Group A',
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAddStudentModalYear(preset)}
                      className="text-[10px] font-medium px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Mentor&apos;s Name *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={addStudentModalMentor}
                    onChange={(e) => setAddStudentModalMentor(e.target.value)}
                    placeholder="e.g. Ms. Eleanor Vance"
                    className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Student Code (Optional)
                  </label>
                  <input
                    type="text"
                    maxLength={30}
                    value={addStudentModalCode}
                    onChange={(e) => setAddStudentModalCode(e.target.value)}
                    placeholder="Auto (e.g. STU-106)"
                    className="w-full text-xs font-mono border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isCreatingStudent}
                onClick={() => setShowAddStudentModal(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreatingStudent}
                className="px-4 py-1.5 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{isCreatingStudent ? 'Adding...' : 'Add Student'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
