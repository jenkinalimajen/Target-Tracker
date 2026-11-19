import React, { useState, useMemo, useEffect } from 'react';
import {
  CheckCircle2,
  Clock,
  Check,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Calendar,
  Save,
  RotateCcw,
  User,
  BookOpen,
  Pencil,
  Link2,
  Sparkles,
  Lock,
  Bookmark,
  Archive,
  Download,
} from 'lucide-react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { exportStudentTargetsPdf } from '../utils/exportStudentTargetsPdf';
import { buildStaffShareLink, copyTextReliably } from '../utils/shareLinks';
import {
  Student,
  Target,
  NotificationItem,
  TrackingRating,
  WeekScheduleInfo,
  WeekSetupConfig,
  AcademicTerm,
  getSavedAcademicTerms,
  RATING_METADATA,
  sanitizeBoundedString,
  computeUpdatedHistorySummary,
  getTrackingWeeksList,
  getTargetRatingForWeek,
  isTargetTrackedInWeek,
  formatStudentYearAndGroup,
  getStudentMentorName,
  getStudentSchoolTier,
  formatTargetDisplayTitle,
  doesTargetMatchTerm,
  getTargetFontColorClass,
  groupTargetsHierarchically,
} from '../types';

const UNASSIGNED_SUBJECT_PLACEHOLDER = 'Unassigned Subject';

interface StaffDashboardProps {
  staffEmail: string;
  staffName: string;
  staffDepartment: string;
  students: Student[];
  targets: Target[];
  notifications: NotificationItem[];
  weekSetup: WeekSetupConfig;
  configuredPublicUrl?: string | null;
  isAdminViewing?: boolean;
  onBackToAdmin?: () => void;
}

interface StudentSubjectCardItem {
  cardKey: string;
  student: Student;
  subject: string;
  teacherName?: string;
  displayTargets: Array<{
    target: Target;
    isApplicableToSubjectAndStaff: boolean;
    displayNumber: string;
    isSubTarget: boolean;
  }>;
  applicableTargets: Target[];
  savedTrackedCount: number;
  requiredCount: number;
  isComplete: boolean;
}

export const StaffDashboard: React.FC<StaffDashboardProps> = ({
  staffEmail,
  staffName,
  staffDepartment,
  students,
  targets,
  notifications,
  weekSetup,
  configuredPublicUrl,
  isAdminViewing = false,
  onBackToAdmin,
}) => {
  const normalizedEmail = staffEmail.trim().toLowerCase();

  // Null = Main Staff Dashboard (Buttons of Student Name + Assigned Subject).
  // Non-null = Redirected to that Student's Profile for the clicked Subject.
  const [activeCardKey, setActiveCardKey] = useState<string | null>(null);


  // Week Offset: 0 = Current Monday–Friday Week; 1 = Next Monday (+1 Week)
  const [activeWeekOffset, setActiveWeekOffset] = useState<number>(0);

  // Editable Student Profile state
  const [isEditingStudentProfile, setIsEditingStudentProfile] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [editProfileYearGroup, setEditProfileYearGroup] = useState('');
  const [editProfileMentorName, setEditProfileMentorName] = useState('');
  const [isSavingStudentProfile, setIsSavingStudentProfile] = useState(false);

  // Track which past (ended) weeks are uncollapsed (expanded) so they can be viewed, edited, and resubmitted
  const [expandedPastWeekKeys, setExpandedPastWeekKeys] = useState<
    Record<string, boolean>
  >({});

  // Draft ratings selected by staff before clicking "Save and Submit" per weekKey -> targetId -> TrackingRating
  const [draftRatingsByWeek, setDraftRatingsByWeek] = useState<
    Record<string, Record<string, TrackingRating>>
  >({});

  const [savingWeekKey, setSavingWeekKey] = useState<string | null>(null);
  const [saveFeedbackMessage, setSaveFeedbackMessage] = useState<string | null>(
    null
  );

  const trackingWeeks = useMemo(
    () => getTrackingWeeksList(activeWeekOffset, weekSetup),
    [activeWeekOffset, weekSetup]
  );
  const currentActiveWeek = trackingWeeks[0];

  const allTerms = useMemo(() => {
    const base = Array.isArray(weekSetup.termsList)
      ? weekSetup.termsList
      : getSavedAcademicTerms();
    return base.filter((t) => !t.isArchived);
  }, [weekSetup.termsList]);

  const activeTermName = (
    weekSetup.term ||
    allTerms[0]?.name ||
    ''
  )
    .trim()
    .toUpperCase();

  const [selectedStaffTerm, setSelectedStaffTerm] = useState<string>(activeTermName);

  useEffect(() => {
    setSelectedStaffTerm((prev) => {
      if (allTerms.length === 0) return '';
      const stillExists = allTerms.some((t) => t.name === prev);
      if (stillExists) return prev;
      return activeTermName || allTerms[0]?.name || '';
    });
  }, [activeTermName, allTerms]);

  // Keep synced when admin switches active term externally
  useEffect(() => {
    setSelectedStaffTerm(activeTermName);
  }, [activeTermName]);

  const currentTermObj =
    allTerms.find((t) => t.name === selectedStaffTerm) || allTerms[0] || null;
  const isTermLocked = Boolean(currentTermObj?.isLocked);
  const isTermArchived = Boolean(currentTermObj?.isArchived);

  // Targets filtered by the active academic term
  const termTargets = useMemo(() => {
    if (!selectedStaffTerm) return [];
    return targets.filter((t) => doesTargetMatchTerm(t.term, selectedStaffTerm));
  }, [targets, selectedStaffTerm]);

  // Build one button per (Student + Assigned Subject) pair that this staff member is tracking.
  // The same student will appear multiple times on the staff dashboard if the staff member tracks multiple subjects for that student.
  const studentSubjectCards = useMemo<StudentSubjectCardItem[]>(() => {
    if (!normalizedEmail) return [];
    const cards: StudentSubjectCardItem[] = [];

    const isTargetAssignedToStaff = (t: Target): boolean => {
      const aEmail = (t.assignedStaffEmail || '').trim().toLowerCase();
      const lEmail = (t.lsaEmail || '').trim().toLowerCase();
      const sEmail = (t.subjectStaffEmail || '').trim().toLowerCase();
      const effectiveSubjectEmail =
        lEmail && lEmail !== 'none' && lEmail !== 'none@pending.local'
          ? lEmail
          : sEmail;
      return (
        aEmail === normalizedEmail ||
        (Boolean(effectiveSubjectEmail) &&
          effectiveSubjectEmail !== 'none' &&
          effectiveSubjectEmail !== 'none@pending.local' &&
          effectiveSubjectEmail === normalizedEmail)
      );
    };

    for (const student of students) {
      const stuTargets = termTargets.filter(
        (t) =>
          t.studentId === student.id &&
          t.subject !== UNASSIGNED_SUBJECT_PLACEHOLDER
      );
      if (stuTargets.length === 0) continue;

      // Unique target titles across the student's entire profile (so non-applicable targets are also visible in light grey)
      const allUniqueTitlesForStudent = Array.from(
        new Set(stuTargets.map((t) => t.title.trim()).filter(Boolean))
      );

      // Find all subjects for this student where this staff member is actively assigned to track targets
      const subjectsForThisStaff = new Set<string>();
      for (const t of stuTargets) {
        if (!t.trackingRequired) continue;
        if (isTargetAssignedToStaff(t)) {
          subjectsForThisStaff.add(t.subject);
        }
      }

      for (const subjectName of Array.from(subjectsForThisStaff)) {
        const subjectTargetDocs = stuTargets.filter(
          (t) => t.subject === subjectName
        );

        // Build the complete list of targets for this student on their profile:
        // If a target exists in this subject and is trackingRequired for this staff member -> applicable (normal font, clickable)
        // Otherwise -> not applicable (light grey font, readable, unclickable)
        const rawDisplayTargets: Array<{
          target: Target;
          isApplicableToSubjectAndStaff: boolean;
        }> = [];

        const seenTitles = new Set<string>();

        for (const docItem of subjectTargetDocs) {
          const titleKey = docItem.title.trim().toLowerCase();
          seenTitles.add(titleKey);
          const isApplicable =
            Boolean(docItem.trackingRequired) &&
            isTargetAssignedToStaff(docItem);

          rawDisplayTargets.push({
            target: docItem,
            isApplicableToSubjectAndStaff: isApplicable,
          });
        }

        // Also include any other active target titles on the student's profile that weren't in this subject
        for (const title of allUniqueTitlesForStudent) {
          const titleKey = title.toLowerCase();
          if (seenTitles.has(titleKey)) continue;
          const fallbackDoc = stuTargets.find(
            (t) => t.title.trim().toLowerCase() === titleKey
          );
          if (fallbackDoc) {
            seenTitles.add(titleKey);
            rawDisplayTargets.push({
              target: fallbackDoc,
              isApplicableToSubjectAndStaff: false,
            });
          }
        }

        const groupedDisplay = groupTargetsHierarchically(
          rawDisplayTargets.map((item) => ({
            title: item.target.title,
            heading: item.target.heading,
            targetGroupId: item.target.targetGroupId,
            raw: item,
          }))
        );

        const displayTargets = groupedDisplay.flatEntries.map((entry) => ({
          target: entry.item.raw.target,
          isApplicableToSubjectAndStaff:
            entry.item.raw.isApplicableToSubjectAndStaff,
          displayNumber: entry.displayNumber,
          isSubTarget: entry.isSubTarget,
        }));

        const applicableTargets = displayTargets
          .filter((d) => d.isApplicableToSubjectAndStaff)
          .map((d) => d.target);

        if (applicableTargets.length === 0) continue;

        const savedTrackedCount = applicableTargets.filter((t) =>
          isTargetTrackedInWeek(t, currentActiveWeek.weekKey)
        ).length;

        const requiredCount = applicableTargets.length;
        const isComplete =
          requiredCount > 0 && savedTrackedCount === requiredCount;

        const defaultTeacherMap: Record<string, string> = {
          Mathematics: 'Mrs. Gable',
          'Further Mathematics': 'Mr. Vance',
          English: 'Mr. Foster',
          Science: 'Dr. Aris',
        };
        const matchedTgtWithTeacher = subjectTargetDocs.find(
          (t) => t.teacherName && t.teacherName.trim()
        );
        const resolvedTeacher =
          matchedTgtWithTeacher?.teacherName ||
          defaultTeacherMap[subjectName] ||
          'Class Teacher';

        cards.push({
          cardKey: `${student.id}::${subjectName}`,
          student,
          subject: subjectName,
          teacherName: resolvedTeacher,
          displayTargets,
          applicableTargets,
          savedTrackedCount,
          requiredCount,
          isComplete,
        });
      }
    }

    return cards;
  }, [
    students,
    termTargets,
    normalizedEmail,
    staffDepartment,
    currentActiveWeek.weekKey,
  ]);

  const middleCards = useMemo(() => {
    return studentSubjectCards.filter(
      (c) => getStudentSchoolTier(c.student) === 'MIDDLE'
    );
  }, [studentSubjectCards]);

  const upperCards = useMemo(() => {
    return studentSubjectCards.filter(
      (c) => getStudentSchoolTier(c.student) === 'UPPER'
    );
  }, [studentSubjectCards]);

  const selectedCard = useMemo(
    () => studentSubjectCards.find((c) => c.cardKey === activeCardKey) || null,
    [studentSubjectCards, activeCardKey]
  );

  const showTempMessage = (msg: string) => {
    setSaveFeedbackMessage(msg);
    setTimeout(() => {
      setSaveFeedbackMessage((prev) => (prev === msg ? null : prev));
    }, 3500);
  };

  const getEffectiveRatingForWeek = (
    target: Target,
    weekKey: string
  ): TrackingRating => {
    const draftForWeek = draftRatingsByWeek[weekKey]?.[target.id];
    if (draftForWeek) {
      return draftForWeek;
    }
    return getTargetRatingForWeek(target, weekKey);
  };

  const handleSelectDraftRating = (
    target: Target,
    isApplicable: boolean,
    weekKey: string,
    rating: TrackingRating
  ) => {
    if (!isApplicable) return;

    setDraftRatingsByWeek((prev) => ({
      ...prev,
      [weekKey]: {
        ...(prev[weekKey] || {}),
        [target.id]: rating,
      },
    }));
  };

  const handleSaveAndSubmitWeek = async (
    weekInfo: WeekScheduleInfo,
    applicableTargets: Target[],
    studentName: string,
    subjectName: string
  ) => {
    if (applicableTargets.length === 0) return;

    const allTracked = applicableTargets.every((t) => {
      const r = getEffectiveRatingForWeek(t, weekInfo.weekKey);
      return r === 'M' || r === 'WT' || r === 'PA' || r === 'A' || r === 'NA';
    });
    if (!allTracked) return;

    setSavingWeekKey(weekInfo.weekKey);
    try {
      for (const target of applicableTargets) {
        const rating = getEffectiveRatingForWeek(target, weekInfo.weekKey);
        const progressScore = RATING_METADATA[rating].progressValue;
        const updatedHistory = computeUpdatedHistorySummary(
          target.weeklyHistorySummary,
          weekInfo.weekKey,
          rating
        );

        const isCurrentActiveWeek =
          weekInfo.weekKey === currentActiveWeek.weekKey;

        const path = `targets/${target.id}`;
        await updateDoc(doc(db, 'targets', target.id), {
          currentWeekStatus: isCurrentActiveWeek
            ? rating
            : target.currentWeekStatus,
          currentWeekKey: isCurrentActiveWeek
            ? weekInfo.weekKey
            : target.currentWeekKey,
          progressScore: isCurrentActiveWeek
            ? progressScore
            : target.progressScore,
          weeklyHistorySummary: updatedHistory,
          lastTrackedByEmail: normalizedEmail,
          notes: target.notes,
          updatedAt: serverTimestamp(),
        });
      }

      setDraftRatingsByWeek((prev) => {
        const next = { ...prev };
        delete next[weekInfo.weekKey];
        return next;
      });

      showTempMessage(
        weekInfo.isPastEndDate
          ? `Resubmitted Week ${weekInfo.weekNumber}.`
          : `Saved (${studentName} — ${subjectName}).`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'targets');
    } finally {
      setSavingWeekKey(null);
    }
  };

  const toggleExpandPastWeek = (weekKey: string) => {
    setExpandedPastWeekKeys((prev) => ({
      ...prev,
      [weekKey]: !prev[weekKey],
    }));
  };

  // Render a Week Section (Targets with Tracking Buttons directly next to each target, and Save and Submit button below)
  const renderWeekTrackingSection = (
    weekInfo: WeekScheduleInfo,
    card: StudentSubjectCardItem
  ) => {
    const { displayTargets, applicableTargets, student, subject } = card;

    const selectedApplicableCount = applicableTargets.filter((t) => {
      const r = getEffectiveRatingForWeek(t, weekInfo.weekKey);
      return r === 'WT' || r === 'PA' || r === 'A' || r === 'NA';
    }).length;

    const savedApplicableCount = applicableTargets.filter((t) =>
      isTargetTrackedInWeek(t, weekInfo.weekKey)
    ).length;

    const allApplicableTracked =
      applicableTargets.length > 0 &&
      selectedApplicableCount === applicableTargets.length;

    const isWeekAlreadySavedInDb =
      applicableTargets.length > 0 &&
      savedApplicableCount === applicableTargets.length;

    const hasUnsavedDraftChanges = Boolean(
      draftRatingsByWeek[weekInfo.weekKey] &&
        Object.keys(draftRatingsByWeek[weekInfo.weekKey]).length > 0
    );

    const isExpanded = weekInfo.isPastEndDate
      ? Boolean(expandedPastWeekKeys[weekInfo.weekKey])
      : true;

    return (
      <div
        key={weekInfo.weekKey}
        className={`bg-white border rounded-lg overflow-hidden transition-all ${
          weekInfo.isPastEndDate
            ? 'border-slate-200 bg-slate-50/40'
            : isWeekAlreadySavedInDb && !hasUnsavedDraftChanges
            ? 'border-emerald-500'
            : 'border-slate-300 shadow-xs'
        }`}
      >
        {/* Week Header Bar */}
        <div
          className={`px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            weekInfo.isPastEndDate
              ? 'bg-slate-100/80 cursor-pointer hover:bg-slate-200/50'
              : 'bg-slate-50 border-b border-slate-200'
          }`}
          onClick={() => {
            if (weekInfo.isPastEndDate) {
              toggleExpandPastWeek(weekInfo.weekKey);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded bg-slate-900 text-white font-mono">
              <Calendar className="w-3.5 h-3.5" />
              Week {weekInfo.weekNumber}
            </span>
            <span className="text-sm font-bold text-slate-900">
              {weekInfo.rangeLabel}
            </span>
            {weekInfo.isPastEndDate ? (
              <span className="text-xs text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded">
                Past Week
              </span>
            ) : (
              <span className="text-xs font-semibold text-emerald-800 bg-emerald-100/80 px-2 py-0.5 rounded">
                Active Week
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 self-end sm:self-auto">
            <span className="text-xs font-mono tabular-nums text-slate-600">
              {selectedApplicableCount}/{applicableTargets.length} Tracked
            </span>

            {weekInfo.isPastEndDate && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpandPastWeek(weekInfo.weekKey);
                }}
                className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    Collapse
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    Edit
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Expanded Week Body */}
        {isExpanded && (
          <div className="p-5 space-y-4">
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden bg-white">
              {displayTargets.map(
                (
                  { target, isApplicableToSubjectAndStaff, displayNumber },
                  index
                ) => {
                  const effectiveRating = getEffectiveRatingForWeek(
                    target,
                    weekInfo.weekKey
                  );
                  const meta = RATING_METADATA[effectiveRating];
                  const isTrackedInUI =
                    effectiveRating === 'M' ||
                    effectiveRating === 'WT' ||
                    effectiveRating === 'PA' ||
                    effectiveRating === 'A' ||
                    effectiveRating === 'NA';

                  return (
                    <div
                      key={`${weekInfo.weekKey}_${target.id}_${index}`}
                      className={`p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition-colors ${
                        !isApplicableToSubjectAndStaff
                          ? 'bg-slate-50/60'
                          : isTrackedInUI
                          ? 'bg-emerald-50/20'
                          : 'bg-white'
                      }`}
                    >
                      {/* Left Side: Target Description (Normal font if applicable; Light grey font if not applicable) */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start gap-2.5">
                          <span
                            className={`text-xs font-mono font-semibold mt-0.5 shrink-0 ${
                              isApplicableToSubjectAndStaff
                                ? 'text-slate-500'
                                : 'text-slate-300'
                            }`}
                          >
                            {displayNumber}.
                          </span>
                          <div className="space-y-0.5 min-w-0 flex-1">
                            <div
                              className={`text-sm space-y-0.5 ${getTargetFontColorClass(
                                target.fontColor,
                                isApplicableToSubjectAndStaff
                              )} ${!isApplicableToSubjectAndStaff ? 'select-text' : ''}`}
                            >
                              {target.heading?.trim() && (
                                <div className="font-bold whitespace-pre-wrap break-words">
                                  {target.heading.trim()}
                                </div>
                              )}
                              {target.internalNote?.trim() && (
                                <div
                                  className={`my-1 px-2.5 py-1.5 rounded border text-xs font-medium whitespace-pre-wrap break-words ${
                                    isApplicableToSubjectAndStaff
                                      ? 'bg-red-50/70 border-red-200 text-red-600'
                                      : 'bg-red-50/30 border-red-100 text-red-400'
                                  }`}
                                >
                                  <span className="font-bold">Note: </span>
                                  {target.internalNote.trim()}
                                </div>
                              )}
                              <div className="font-normal whitespace-pre-wrap break-words">
                                {target.title}
                              </div>
                              {target.challenge?.trim() && (
                                <div className="font-bold whitespace-pre-wrap break-words">
                                  Challenge: {target.challenge.trim()}
                                </div>
                              )}
                              {target.suggestedStrategies?.trim() && (
                                <div
                                  className={`pt-1 text-xs font-normal whitespace-pre-wrap break-words ${
                                    isApplicableToSubjectAndStaff
                                      ? 'text-slate-700'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  <span className="font-semibold">
                                    Suggested Strategies:{' '}
                                  </span>
                                  {target.suggestedStrategies.trim()}
                                </div>
                              )}
                            </div>
                            <div
                              className={`text-[11px] flex items-center gap-2 ${
                                isApplicableToSubjectAndStaff
                                  ? 'text-slate-500'
                                  : 'text-slate-300'
                              }`}
                            >
                              {!isApplicableToSubjectAndStaff ? (
                                <span>Not applicable</span>
                              ) : effectiveRating === 'UNTRACKED' ? (
                                <span>Select M, A, PA, WT, or NA</span>
                              ) : effectiveRating === 'NA' ? (
                                <span>Not Applicable (NA)</span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {effectiveRating === 'M' && (
                                    <Sparkles className="w-3 h-3 text-purple-600" />
                                  )}
                                  <strong>{meta.label}</strong> ({meta.code}) · {meta.progressValue}%
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Real-Time Progress Bar */}
                        <div className="pl-6">
                          <div className="w-full max-w-md h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-150 ${
                                isApplicableToSubjectAndStaff
                                  ? meta.barColorClass
                                  : 'bg-slate-200'
                              }`}
                              style={{
                                width: `${
                                  !isApplicableToSubjectAndStaff
                                    ? 0
                                    : effectiveRating === 'NA'
                                    ? 100
                                    : meta.progressValue
                                }%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Right Side (Directly Next to Target): Tracking Buttons (M, A, PA, WT, NA) */}
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0 pl-6 lg:pl-0">
                        {(['M', 'A', 'PA', 'WT', 'NA'] as TrackingRating[]).map(
                          (rating) => {
                            const isSelected =
                              isApplicableToSubjectAndStaff &&
                              effectiveRating === rating;
                            return (
                              <button
                                key={rating}
                                type="button"
                                disabled={
                                  !isApplicableToSubjectAndStaff ||
                                  savingWeekKey === weekInfo.weekKey
                                }
                                onClick={() =>
                                  handleSelectDraftRating(
                                    target,
                                    isApplicableToSubjectAndStaff,
                                    weekInfo.weekKey,
                                    rating
                                  )
                                }
                                title={RATING_METADATA[rating].label}
                                className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                                  !isApplicableToSubjectAndStaff
                                    ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed'
                                    : isSelected
                                    ? rating === 'M'
                                      ? 'bg-purple-600 text-white border-purple-700 shadow-2xs'
                                      : rating === 'A'
                                      ? 'bg-emerald-600 text-white border-emerald-700 shadow-2xs'
                                      : rating === 'PA'
                                      ? 'bg-sky-600 text-white border-sky-700 shadow-2xs'
                                      : rating === 'WT'
                                      ? 'bg-amber-500 text-white border-amber-600 shadow-2xs'
                                      : 'bg-slate-700 text-white border-slate-800 shadow-2xs'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                                }`}
                              >
                                {isSelected && (
                                  <Check className="w-3.5 h-3.5" />
                                )}
                                <span>{rating}</span>
                              </button>
                            );
                          }
                        )}
                      </div>
                    </div>
                  );
                }
              )}
            </div>

            {/* Below Targets: Save and Submit Button (Activates Once All Applicable Tracking Has Been Clicked) */}
            <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs text-slate-600">
                {allApplicableTracked ? (
                  isWeekAlreadySavedInDb && !hasUnsavedDraftChanges ? (
                    <span className="text-emerald-700 font-semibold inline-flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Submitted (Week {weekInfo.weekNumber})
                    </span>
                  ) : (
                    <span className="text-slate-900 font-semibold">
                      Ready to submit
                    </span>
                  )
                ) : (
                  <span className="text-amber-700 font-medium">
                    {selectedApplicableCount}/{applicableTargets.length} tracked
                  </span>
                )}
              </div>

              <button
                type="button"
                disabled={
                  !allApplicableTracked || savingWeekKey === weekInfo.weekKey
                }
                onClick={() =>
                  handleSaveAndSubmitWeek(
                    weekInfo,
                    applicableTargets,
                    student.name,
                    subject
                  )
                }
                className={`px-5 py-2.5 rounded-md text-xs font-bold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  allApplicableTracked
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs cursor-pointer'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Save className="w-3.5 h-3.5" />
                {savingWeekKey === weekInfo.weekKey
                  ? 'Saving & Submitting...'
                  : weekInfo.isPastEndDate || isWeekAlreadySavedInDb
                  ? 'Save and Resubmit'
                  : 'Save and Submit'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

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
      showTempMessage(`Updated student profile for ${cleanName}.`);
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

  // VIEW 2: STUDENT PROFILE VIEW (Redirected when a Student + Subject button is clicked)
  if (selectedCard) {
    const { student, subject, isComplete, savedTrackedCount, requiredCount } =
      selectedCard;
    const yearAndGroup = formatStudentYearAndGroup(student);
    const mentorName = getStudentMentorName(student);

    if (isTermArchived) {
      return (
        <div className="max-w-md mx-auto my-12 p-8 text-center bg-white border border-slate-200 rounded-xl space-y-4 shadow-xs">
          <Archive className="w-10 h-10 text-indigo-500 mx-auto" />
          <h3 className="font-bold text-slate-900 text-base">{selectedStaffTerm}</h3>
          <p className="text-xs text-slate-600">
            This term is archived... tracking is unavailable.
          </p>
          <button
            type="button"
            onClick={() => setActiveCardKey(null)}
            className="px-4 py-2 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800"
          >
            Back to Dashboard
          </button>
        </div>
      );
    }

    if (isTermLocked && !isAdminViewing) {
      return (
        <div className="max-w-md mx-auto my-12 p-8 text-center bg-white border border-slate-200 rounded-xl space-y-4 shadow-xs">
          <Lock className="w-10 h-10 text-amber-500 mx-auto" />
          <h3 className="font-bold text-slate-900 text-base">{selectedStaffTerm}</h3>
          <p className="text-xs text-slate-600">
            Term locked.
          </p>
          <button
            type="button"
            onClick={() => setActiveCardKey(null)}
            className="px-4 py-2 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800"
          >
            Back to Dashboard
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {isAdminViewing && (
          <div className="bg-slate-900 text-white px-4 py-2.5 rounded-lg flex flex-wrap items-center justify-between gap-3 shadow-xs border border-slate-800">
            <div className="flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span className="font-semibold text-slate-300">Viewing Staff Portal In-App:</span>
              <span className="font-bold text-white">{staffName} ({staffDepartment})</span>
              <span className="text-slate-400 font-mono text-[11px] hidden sm:inline">({normalizedEmail})</span>
            </div>
            {onBackToAdmin && (
              <button
                type="button"
                onClick={onBackToAdmin}
                className="px-3 py-1 text-xs font-bold bg-white text-slate-900 hover:bg-slate-100 rounded-md inline-flex items-center gap-1.5 transition-colors shadow-xs"
              >
                <ArrowLeft className="w-3 h-3" />
                Return to Admin Portal
              </button>
            )}
          </div>
        )}

        <div className="bg-slate-200/70 border border-slate-300 rounded-xl p-5 space-y-5 shadow-xs">
        {/* Filled Student Profile Header */}
        <div
          className={`rounded-lg p-5 border shadow-xs space-y-4 transition-colors ${
            isComplete
              ? 'bg-emerald-900 text-white border-emerald-800'
              : 'bg-slate-900 text-white border-slate-800'
          }`}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setActiveCardKey(null);
                  setIsEditingStudentProfile(false);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-md transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Staff Dashboard
              </button>

              {isComplete ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-100 bg-emerald-500/25 border border-emerald-400/40 px-3 py-1.5 rounded-md">
                  <CheckCircle2 className="w-4 h-4 text-emerald-300" />
                  Completed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-100 bg-amber-500/25 border border-amber-400/40 px-3 py-1.5 rounded-md">
                  <Clock className="w-4 h-4 text-amber-300" />
                  {savedTrackedCount}/{requiredCount} Submitted
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 min-w-0 w-full">
              <div className="inline-flex flex-wrap items-center gap-1.5 bg-white/20 border border-white/30 p-1 rounded-lg text-xs shadow-xs max-w-full">
                <button
                  type="button"
                  onClick={() => setActiveWeekOffset(0)}
                  className={`px-3 py-1.5 rounded-md font-bold transition-all ${
                    activeWeekOffset === 0
                      ? 'bg-white text-slate-900 shadow-md font-extrabold'
                      : 'text-white/80 hover:text-white hover:bg-white/15'
                  }`}
                >
                  Current Week (Mon–Fri)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveWeekOffset(1)}
                  className={`px-3 py-1.5 rounded-md font-bold transition-all ${
                    activeWeekOffset === 1
                      ? 'bg-white text-slate-900 shadow-md font-extrabold'
                      : 'text-white/80 hover:text-white hover:bg-white/15'
                  }`}
                >
                  Next Monday (+1 Week)
                </button>
              </div>

              <button
                type="button"
                onClick={() =>
                  exportStudentTargetsPdf({
                    studentName: student.name,
                    yearGroup: yearAndGroup,
                    term: selectedStaffTerm || 'TERM 1',
                    teacherName: selectedCard.teacherName || 'Class Teacher',
                    subject,
                    targets:
                      selectedCard.applicableTargets.length > 0
                        ? selectedCard.applicableTargets
                        : selectedCard.displayTargets.map((d) => d.target),
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-md transition-colors shadow-xs"
              >
                <Download className="w-3.5 h-3.5" />
                Target Export
              </button>

              <button
                type="button"
                onClick={() => handleStartEditingStudentProfile(student)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-white/15 hover:bg-white/25 text-white rounded-md transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit Profile
              </button>
            </div>
          </div>

          {isEditingStudentProfile ? (
            <form
              onSubmit={(e) => handleSaveStudentProfile(e, student)}
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
                    onChange={(e) => setEditProfileYearGroup(e.target.value)}
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
                    onChange={(e) => setEditProfileMentorName(e.target.value)}
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
            /* Student Profile Details: Name, Year & Group, Mentor's Name (Clickable to Edit) */
            <div className="pt-3 border-t border-white/15 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button
                type="button"
                onClick={() => handleStartEditingStudentProfile(student)}
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
                      {student.name}
                    </div>
                  </div>
                </div>
                <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              </button>

              <button
                type="button"
                onClick={() => handleStartEditingStudentProfile(student)}
                title="Click to edit Year and Group"
                className="text-left p-3.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 flex items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                    Year and Group
                  </div>
                  <div className="text-sm font-bold text-white mt-0.5 truncate">
                    {yearAndGroup}
                  </div>
                </div>
                <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              </button>

              <button
                type="button"
                onClick={() => handleStartEditingStudentProfile(student)}
                title="Click to edit Mentor's Name"
                className="text-left p-3.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 flex items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                    Mentor&apos;s Name
                  </div>
                  <div className="text-sm font-bold text-white mt-0.5 truncate">
                    {mentorName}
                  </div>
                </div>
                <Pencil className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-slate-200">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-slate-300" />
                <span>Subject:</span>
                <strong className="text-white">{subject}</strong>
              </div>
              <span className="text-slate-400">•</span>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-300">Teacher:</span>
                <strong className="text-white">
                  {selectedCard.teacherName || 'Class Teacher'}
                </strong>
              </div>
              <span className="text-slate-400">•</span>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-300">Tracking LSA:</span>
                <strong className="text-emerald-300">{staffName}</strong>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-white bg-white/15 px-2.5 py-1 rounded">
              <Calendar className="w-3.5 h-3.5 text-slate-200" />
              <span>
                Week {currentActiveWeek.weekNumber} ({currentActiveWeek.rangeLabel})
              </span>
            </span>
          </div>
        </div>

        {saveFeedbackMessage && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-4 py-3 text-xs font-semibold flex items-center justify-between">
            <span>{saveFeedbackMessage}</span>
            <button
              type="button"
              onClick={() => setActiveCardKey(null)}
              className="underline font-bold ml-4"
            >
              Return to Staff Dashboard
            </button>
          </div>
        )}

          {/* Active Week + Collapsible Past Weeks */}
          <div className="space-y-4">
            {trackingWeeks.map((weekInfo) =>
              renderWeekTrackingSection(weekInfo, selectedCard)
            )}
          </div>
        </div>
      </div>
    );
  }

  // VIEW 1: MAIN STAFF DASHBOARD (BUTTONS OF STUDENT NAME + ASSIGNED SUBJECT DIRECTLY BELOW)
  return (
    <div className="space-y-6">
      {isAdminViewing && (
        <div className="bg-slate-900 text-white px-4 py-2.5 rounded-lg flex flex-wrap items-center justify-between gap-3 shadow-xs border border-slate-800">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span className="font-semibold text-slate-300">Viewing Staff Portal In-App:</span>
            <span className="font-bold text-white">{staffName} ({staffDepartment})</span>
            <span className="text-slate-400 font-mono text-[11px] hidden sm:inline">({normalizedEmail})</span>
          </div>
          {onBackToAdmin && (
            <button
              type="button"
              onClick={onBackToAdmin}
              className="px-3 py-1 text-xs font-bold bg-white text-slate-900 hover:bg-slate-100 rounded-md inline-flex items-center gap-1.5 transition-colors shadow-xs"
            >
              <ArrowLeft className="w-3 h-3" />
              Return to Admin Portal
            </button>
          )}
        </div>
      )}

      {/* Staff Personal Header & Weekly Schedule Banner */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              Staff Dashboard · <span className="font-mono">{normalizedEmail}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-bold text-slate-900">{staffName}</h1>
              <span className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold bg-slate-900 text-white px-2.5 py-1 rounded">
                <Calendar className="w-3.5 h-3.5" />
                <span>
                  Week {currentActiveWeek.weekNumber}: {currentActiveWeek.rangeLabel}
                </span>
              </span>
              {/* Term Switcher (Archived terms are excluded) */}
              {allTerms.length > 0 && (
                <div className="inline-flex items-center gap-1 bg-amber-50 border border-amber-300 p-0.5 rounded-lg">
                  {allTerms.map((t) => {
                    const isSelected = t.name === selectedStaffTerm;
                    return (
                      <button
                        key={t.id || t.name}
                        type="button"
                        onClick={() => {
                          setSelectedStaffTerm(t.name);
                          setActiveCardKey(null);
                        }}
                        className={`px-2.5 py-1 text-xs font-mono font-black uppercase rounded-md transition-all inline-flex items-center gap-1 ${
                          isSelected
                            ? 'bg-amber-400 text-slate-950 shadow-xs ring-1 ring-amber-500'
                            : 'text-amber-900 hover:bg-amber-100 font-bold'
                        }`}
                        title={t.isLocked ? `${t.name} (Locked)` : t.name}
                      >
                        {t.isLocked ? (
                          <Lock className="w-3 h-3 text-amber-900" />
                        ) : (
                          <Bookmark className="w-3 h-3 text-amber-900" />
                        )}
                        <span>{t.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {isAdminViewing && isTermLocked && (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded">
                  <Lock className="w-3 h-3" />
                  Locked
                </span>
              )}
              <button
                type="button"
                onClick={async () => {
                  const url = buildStaffShareLink(normalizedEmail, configuredPublicUrl);
                  await copyTextReliably(url);
                  showTempMessage('Direct link copied.');
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-300 rounded hover:bg-slate-50 text-slate-700 bg-white"
              >
                <Link2 className="w-3 h-3 text-slate-500" />
                <span>Copy Direct Link</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            {/* HIGH-VISIBILITY MAIN STAFF TABS */}
            <div className="inline-flex items-center gap-1.5 bg-slate-200/90 border border-slate-300 p-1.5 rounded-xl shadow-xs">
              <button
                type="button"
                onClick={() => setActiveWeekOffset(0)}
                className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  activeWeekOffset === 0
                    ? 'bg-emerald-600 text-white shadow-md ring-1 ring-emerald-500 font-extrabold'
                    : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
                }`}
              >
                <Calendar className="w-4 h-4" />
                <span>This Week (Mon–Fri)</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveWeekOffset(1)}
                className={`px-3.5 py-2 text-xs sm:text-sm font-bold rounded-lg transition-all inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  activeWeekOffset === 1
                    ? 'bg-emerald-600 text-white shadow-md ring-1 ring-emerald-500 font-extrabold'
                    : 'text-slate-700 hover:text-slate-900 hover:bg-white/90 font-semibold'
                }`}
              >
                <RotateCcw className="w-4 h-4" />
                <span>Next Monday</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Dashboard Body */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">
            Assigned Students ({isTermArchived || (isTermLocked && !isAdminViewing) ? 0 : studentSubjectCards.length})
          </h2>
        </div>

        {isTermArchived ? (
          <div className="p-10 text-center space-y-2 border border-dashed border-slate-200 rounded-lg bg-slate-50/70">
            <Archive className="w-8 h-8 text-indigo-500 mx-auto" />
            <div className="text-sm font-bold text-slate-900">{selectedStaffTerm}</div>
            <p className="text-xs text-slate-600">
              This term is archived... tracking is unavailable.
            </p>
          </div>
        ) : isTermLocked && !isAdminViewing ? (
          <div className="p-10 text-center space-y-2 border border-dashed border-amber-200 rounded-lg bg-amber-50/50">
            <Lock className="w-8 h-8 text-amber-500 mx-auto" />
            <div className="text-sm font-bold text-slate-900">{selectedStaffTerm} Locked</div>
            <p className="text-xs text-slate-600">
              Term locked. Tracking is unavailable.
            </p>
          </div>
        ) : studentSubjectCards.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
            No students to track.
          </div>
        ) : (
          <div className="space-y-5 pt-1">
            {/* Middle School Section (at Top) */}
            <div className="flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-xl bg-slate-50/80 border border-slate-200">
              {/* Small Title on the Side */}
              <div className="md:w-44 shrink-0 space-y-1">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-100 text-emerald-900 border border-emerald-300 text-xs font-bold uppercase tracking-wider">
                  Middle School
                </div>
                <div className="text-[11px] font-semibold text-slate-500 pl-0.5">
                  Year 7 – Year 8 ({middleCards.length})
                </div>
              </div>

              {/* Middle School Student Cards Grid */}
              <div className="flex-1">
                {middleCards.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 italic bg-white rounded-lg border border-dashed border-slate-200">
                    No students to track.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {middleCards.map((card) => (
                      <button
                        key={card.cardKey}
                        type="button"
                        onClick={() => {
                          setActiveCardKey(card.cardKey);
                        }}
                        className={`w-full text-left p-3.5 rounded-lg border transition-colors flex items-center justify-between gap-3 ${
                          card.isComplete
                            ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 shadow-xs'
                            : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-bold truncate">
                              {card.student.name}
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.2 rounded ${
                                card.isComplete
                                  ? 'bg-emerald-700/80 text-white'
                                  : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              }`}
                            >
                              Yr 7–8
                            </span>
                          </div>

                          <div
                            className={`text-xs font-semibold flex items-center gap-1.5 truncate ${
                              card.isComplete ? 'text-emerald-100' : 'text-slate-700'
                            }`}
                          >
                            <span className="truncate">{card.subject}</span>
                            <span className="text-slate-400 font-normal">•</span>
                            <span className={`text-[11px] font-normal truncate ${card.isComplete ? 'text-emerald-200' : 'text-slate-500'}`}>
                              T: {card.teacherName || 'Class Teacher'}
                            </span>
                          </div>

                          <div
                            className={`text-[11px] font-mono tabular-nums flex items-center gap-2 ${
                              card.isComplete ? 'text-emerald-100' : 'text-slate-500'
                            }`}
                          >
                            <span>
                              {card.savedTrackedCount}/{card.requiredCount} tracked
                            </span>
                            <span>•</span>
                            <span>{card.student.yearGroup || 'Year 7'}</span>
                          </div>
                        </div>

                        {card.isComplete ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0 text-white" />
                        ) : (
                          <Clock className="w-4 h-4 shrink-0 text-amber-500" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Upper School Section (Below) */}
            <div className="flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-xl bg-slate-50/80 border border-slate-200">
              {/* Small Title on the Side */}
              <div className="md:w-44 shrink-0 space-y-1">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-100 text-sky-900 border border-sky-300 text-xs font-bold uppercase tracking-wider">
                  Upper School
                </div>
                <div className="text-[11px] font-semibold text-slate-500 pl-0.5">
                  Year 9 – Year 13 ({upperCards.length})
                </div>
              </div>

              {/* Upper School Student Cards Grid */}
              <div className="flex-1">
                {upperCards.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 italic bg-white rounded-lg border border-dashed border-slate-200">
                    No students to track.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {upperCards.map((card) => (
                      <button
                        key={card.cardKey}
                        type="button"
                        onClick={() => {
                          setActiveCardKey(card.cardKey);
                        }}
                        className={`w-full text-left p-3.5 rounded-lg border transition-colors flex items-center justify-between gap-3 ${
                          card.isComplete
                            ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 shadow-xs'
                            : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-bold truncate">
                              {card.student.name}
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.2 rounded ${
                                card.isComplete
                                  ? 'bg-emerald-700/80 text-white'
                                  : 'bg-sky-50 text-sky-800 border border-sky-200'
                              }`}
                            >
                              Yr 9–13
                            </span>
                          </div>

                          <div
                            className={`text-xs font-semibold flex items-center gap-1.5 truncate ${
                              card.isComplete ? 'text-emerald-100' : 'text-slate-700'
                            }`}
                          >
                            <span className="truncate">{card.subject}</span>
                            <span className="text-slate-400 font-normal">•</span>
                            <span className={`text-[11px] font-normal truncate ${card.isComplete ? 'text-emerald-200' : 'text-slate-500'}`}>
                              T: {card.teacherName || 'Class Teacher'}
                            </span>
                          </div>

                          <div
                            className={`text-[11px] font-mono tabular-nums flex items-center gap-2 ${
                              card.isComplete ? 'text-emerald-100' : 'text-slate-500'
                            }`}
                          >
                            <span>
                              {card.savedTrackedCount}/{card.requiredCount} tracked
                            </span>
                            <span>•</span>
                            <span>{card.student.yearGroup || 'Year 10'}</span>
                          </div>
                        </div>

                        {card.isComplete ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0 text-white" />
                        ) : (
                          <Clock className="w-4 h-4 shrink-0 text-amber-500" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
