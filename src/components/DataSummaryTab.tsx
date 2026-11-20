import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Calendar,
  Search,
  Copy,
  Check,
  BookOpen,
  Save,
  GraduationCap,
  FileSpreadsheet,
  Download,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Student,
  Target,
  WeekSetupConfig,
  SchoolTier,
  TrackingRating,
  getStudentSchoolTier,
  buildWeekScheduleFromOffset,
  getTargetRatingForWeek,
  sanitizeBoundedString,
  formatTermTitleWithYear,
  TargetFontColor,
  normalizeTargetFontColor,
  groupTargetsHierarchically,
  doesTargetMatchTerm,
} from '../types';

interface DataSummaryTabProps {
  students: Student[];
  targets: Target[];
  weekSetup: WeekSetupConfig;
}

const UNASSIGNED_SUBJECT_PLACEHOLDER = 'Unassigned Subject';
const OVERALL_REMARKS_STORAGE_KEY =
  'targettrack_data_summary_overall_cohort_remarks';

/**
 * Clean column header for each target, matching the photo:
 * e.g. "Target 1 Class Participation", "Target 1.1 ..."
 */
function formatTargetColumnHeader(
  num: number | string,
  rawTitle: string,
  heading?: string,
  challenge?: string,
  isSubTarget = false
): string {
  const clean = rawTitle.trim();
  const cleanHeading = (heading || '').trim();
  const cleanChallenge = (challenge || '').trim();
  const match = clean.match(/^target\s*#?\s*\d+\s*[:\-–]?\s*(.*)$/i);
  const body = match && match[1]?.trim() ? match[1].trim() : clean;
  const parts: string[] = [];
  if (isSubTarget) {
    parts.push(`${num}`);
    parts.push(body);
  } else if (cleanHeading) {
    parts.push(`Target ${num}: ${cleanHeading}`);
    parts.push(body);
  } else {
    parts.push(`Target ${num}`);
    parts.push(body);
  }
  if (cleanChallenge) {
    parts.push(`Challenge: ${cleanChallenge}`);
  }
  return parts.join('\n');
}

/**
 * Returns distinct, vibrant colour fill classes for each tracking rating
 */
export function getRatingColorClasses(rating: TrackingRating | string): string {
  switch (rating) {
    case 'M':
    case 'A':
    case 'PA':
    case 'WT':
    case 'NA':
    default:
      return 'bg-transparent text-black';
  }
}

export interface SubjectRatingGroup {
  subjectsFormatted: string; // e.g. "All subjects" or "English (Mr. Foster), Maths (Mrs. Gable)" or "Robotics"
  rating: TrackingRating;
}

/**
 * Groups subjects by consolidated rating:
 * - "All subjects - [Rating]" if all subjects share the same rating.
 * - Otherwise groups subjects that have the same rating:
 *   e.g.:
 *   English, Maths, Science - A
 *   Robotics - WT
 *   Geography - PA
 */
function formatConsolidatedGroupsForTarget(
  subjectsApplied: Array<{
    subject: string;
    effectiveRating: TrackingRating;
  }>
): SubjectRatingGroup[] {
  if (subjectsApplied.length === 0) {
    return [{ subjectsFormatted: 'No subjects tracked', rating: 'NA' }];
  }

  // Group by rating code
  const byRating: Record<string, string[]> = {};
  for (const item of subjectsApplied) {
    const r =
      item.effectiveRating === 'UNTRACKED' ? 'Pending' : item.effectiveRating;
    if (!byRating[r]) byRating[r] = [];
    byRating[r].push(item.subject);
  }

  const distinctRatings = Object.keys(byRating);

  // If all subjects have the same rating: "All subjects - [Rating]"
  if (distinctRatings.length === 1) {
    return [
      {
        subjectsFormatted: 'All subjects',
        rating: distinctRatings[0] as TrackingRating,
      },
    ];
  }

  // If there are variations in ratings: group subjects with identical ratings
  // Sort ratings by academic priority: M, A, PA, WT, NA, Pending
  const priority = ['M', 'A', 'PA', 'WT', 'NA', 'Pending'];
  distinctRatings.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return distinctRatings.map((rating) => {
    const list = byRating[rating];
    return {
      subjectsFormatted: list.join(', '),
      rating: rating as TrackingRating,
    };
  });
}

export const DataSummaryTab: React.FC<DataSummaryTabProps> = ({
  students,
  targets,
  weekSetup,
}) => {
  const isDark = false;
  const activeTerm = weekSetup.term?.trim()
    ? formatTermTitleWithYear(weekSetup.term)
    : 'NO ACTIVE TERM';

  const availableTerms = useMemo(() => {
    const list = (weekSetup.termsList || [])
      .filter((t) => !t.isArchived && t.name?.trim())
      .map((t) => formatTermTitleWithYear(t.name, t.academicYear));
    if (activeTerm !== 'NO ACTIVE TERM' && !list.includes(activeTerm)) {
      list.unshift(activeTerm);
    }
    return Array.from(new Set(list));
  }, [weekSetup.termsList, activeTerm]);

  const [selectedSummaryTerm, setSelectedSummaryTerm] = useState<string>(
    activeTerm
  );

  useEffect(() => {
    setSelectedSummaryTerm((prev) => {
      if (activeTerm !== 'NO ACTIVE TERM') return activeTerm;
      if (availableTerms.length > 0 && availableTerms.includes(prev)) {
        return prev;
      }
      return availableTerms[0] || 'NO ACTIVE TERM';
    });
  }, [activeTerm, availableTerms]);

  // Summary View Mode: Consolidated vs Individual Results (Week 1 to Current Week per Student per Subject)
  const [summaryViewMode, setSummaryViewMode] = useState<
    'CONSOLIDATED' | 'WEEKLY_BY_SUBJECT'
  >('CONSOLIDATED');

  // 1. School Tier Filter: All, Middle School (Yr 7-8), Upper School (Yr 9-13)
  const [selectedTier, setSelectedTier] = useState<SchoolTier>('ALL');

  // 1b. Student Name Dropdown Filter
  const [selectedStudentId, setSelectedStudentId] = useState<string>('ALL');

  // 2. Student Search input
  const [searchQuery, setSearchQuery] = useState('');

  // 3. Date Range Filter State
  const [filterMode, setFilterMode] = useState<'RANGE' | 'CUSTOM_SELECT'>(
    'RANGE'
  );

  const currentWeekNumber = Math.max(1, weekSetup.baseWeekNumber || 1);
  const maxAvailableWeek = Math.max(currentWeekNumber + 4, 12);

  const availableWeeksList = useMemo(() => {
    const list: Array<{
      weekNumber: number;
      weekOffset: number;
      weekKey: string;
      mondayStr: string;
      fridayStr: string;
      rangeLabel: string;
    }> = [];

    for (let wk = 1; wk <= maxAvailableWeek; wk++) {
      const offset = wk - currentWeekNumber;
      const sched = buildWeekScheduleFromOffset(offset, 0, weekSetup);
      list.push({
        weekNumber: wk,
        weekOffset: offset,
        weekKey: sched.weekKey,
        mondayStr: sched.mondayDateStr,
        fridayStr: sched.fridayDateStr,
        rangeLabel: sched.rangeLabel,
      });
    }
    return list;
  }, [currentWeekNumber, maxAvailableWeek, weekSetup]);

  // Date Range Selection: Start Week and End Week (defaults to Week 1 to 5 or current week)
  const [startWeek, setStartWeek] = useState<number>(1);
  const [endWeek, setEndWeek] = useState<number>(
    Math.max(5, currentWeekNumber)
  );

  // Custom multi-select weeks set
  const [selectedWeekNumbers, setSelectedWeekNumbers] = useState<number[]>([
    2,
    3,
  ]);

  // UI helpers for copy confirmation
  const [copiedStudentId, setCopiedStudentId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // PDF Export State & Ref
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const pdfExportContainerRef = useRef<HTMLDivElement | null>(null);

  // Overall Remarks State (cohort-level at the end)
  const [overallRemarks, setOverallRemarks] = useState<string>(() => {
    try {
      return localStorage.getItem(OVERALL_REMARKS_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [savedRemarksStatus, setSavedRemarksStatus] = useState<boolean>(false);

  const handleOverallRemarksChange = (text: string) => {
    setOverallRemarks(text);
    try {
      localStorage.setItem(OVERALL_REMARKS_STORAGE_KEY, text);
    } catch {
      // ignore
    }
  };

  const handleSaveOverallRemarks = () => {
    const clean = sanitizeBoundedString(overallRemarks, 5000);
    try {
      localStorage.setItem(OVERALL_REMARKS_STORAGE_KEY, clean);
    } catch {
      // ignore
    }
    setSavedRemarksStatus(true);
    setTimeout(() => {
      setSavedRemarksStatus(false);
    }, 2500);
  };

  // Active weeks according to the filter mode
  const activeSelectedWeeks = useMemo(() => {
    if (filterMode === 'RANGE') {
      const s = Math.min(startWeek, endWeek);
      const e = Math.max(startWeek, endWeek);
      return availableWeeksList.filter(
        (w) => w.weekNumber >= s && w.weekNumber <= e
      );
    } else {
      return availableWeeksList.filter((w) =>
        selectedWeekNumbers.includes(w.weekNumber)
      );
    }
  }, [filterMode, startWeek, endWeek, selectedWeekNumbers, availableWeeksList]);

  // Human-readable date range label for the header
  const activeDateRangeLabel = useMemo(() => {
    if (activeSelectedWeeks.length === 0) return 'No weeks selected';
    if (activeSelectedWeeks.length === 1) {
      const w = activeSelectedWeeks[0];
      return `Week ${w.weekNumber} (${w.rangeLabel})`;
    }

    if (filterMode === 'RANGE') {
      const first = activeSelectedWeeks[0];
      const last = activeSelectedWeeks[activeSelectedWeeks.length - 1];
      return `Week ${first.weekNumber} – Week ${last.weekNumber} (${first.mondayStr} – ${last.fridayStr})`;
    } else {
      const sortedWks = [...activeSelectedWeeks].sort(
        (a, b) => a.weekNumber - b.weekNumber
      );
      const wkNames = sortedWks
        .map((w) => `Week ${w.weekNumber}`)
        .join(' & ');
      const first = sortedWks[0];
      const last = sortedWks[sortedWks.length - 1];
      return `${wkNames} (${first.mondayStr} – ${last.fridayStr})`;
    }
  }, [activeSelectedWeeks, filterMode]);

  // Week range text for the first column of the table (matching photo): e.g. "1 to 5"
  const weekRangeCellText = useMemo(() => {
    if (filterMode === 'RANGE') {
      const s = Math.min(startWeek, endWeek);
      const e = Math.max(startWeek, endWeek);
      if (s === e) return `${s}`;
      return `${s} to ${e}`;
    } else {
      if (selectedWeekNumbers.length === 0) return '—';
      if (selectedWeekNumbers.length === 1) return `${selectedWeekNumbers[0]}`;
      const sorted = [...selectedWeekNumbers].sort((a, b) => a - b);
      if (sorted.length === 2) return `${sorted[0]} & ${sorted[1]}`;
      return sorted.join(', ');
    }
  }, [filterMode, startWeek, endWeek, selectedWeekNumbers]);

  // Counts for Middle School vs Upper School
  const tierCounts = useMemo(() => {
    let middle = 0;
    let upper = 0;
    for (const stu of students) {
      if (getStudentSchoolTier(stu) === 'MIDDLE') {
        middle += 1;
      } else {
        upper += 1;
      }
    }
    return { all: students.length, middle, upper };
  }, [students]);

  // Students available in the Student Name dropdown (respecting tier filter, sorted alphabetically)
  const dropdownStudents = useMemo(() => {
    return students
      .filter((stu) => {
        if (selectedTier !== 'ALL') {
          return getStudentSchoolTier(stu) === selectedTier;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [students, selectedTier]);

  useEffect(() => {
    if (
      selectedStudentId !== 'ALL' &&
      !dropdownStudents.some((s) => s.id === selectedStudentId)
    ) {
      setSelectedStudentId('ALL');
    }
  }, [dropdownStudents, selectedStudentId]);

  // Filter students by School Tier, Selected Student dropdown, and Search query
  const filteredStudents = useMemo(() => {
    return students.filter((stu) => {
      if (selectedTier !== 'ALL') {
        const stuTier = getStudentSchoolTier(stu);
        if (stuTier !== selectedTier) return false;
      }
      if (selectedStudentId !== 'ALL' && stu.id !== selectedStudentId) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesName = stu.name.toLowerCase().includes(q);
        const matchesCode = stu.studentCode.toLowerCase().includes(q);
        const matchesYear = stu.yearGroup.toLowerCase().includes(q);
        if (!matchesName && !matchesCode && !matchesYear) return false;
      }
      return true;
    });
  }, [students, selectedTier, selectedStudentId, searchQuery]);

  // Term Weeks: Week 1 through Current Week of the selected term
  const termWeeksToCurrent = useMemo(() => {
    return availableWeeksList.filter(
      (w) => w.weekNumber >= 1 && w.weekNumber <= currentWeekNumber
    );
  }, [availableWeeksList, currentWeekNumber]);

  const effectiveDisplayTerm =
    selectedSummaryTerm && selectedSummaryTerm !== 'NO ACTIVE TERM'
      ? selectedSummaryTerm
      : activeTerm;

  // Build consolidated target progress data structure per student matching photo layout
  const studentSummaries = useMemo(() => {
    return filteredStudents.map((student) => {
      const stuTargets = targets.filter(
        (t) =>
          t.studentId === student.id &&
          t.subject !== UNASSIGNED_SUBJECT_PLACEHOLDER &&
          (effectiveDisplayTerm === 'NO ACTIVE TERM' ||
            doesTargetMatchTerm(t.term, effectiveDisplayTerm))
      );

      const targetMapByTitle: Record<
        string,
        {
          title: string;
          heading?: string;
          challenge?: string;
          targetGroupId?: string;
          fontColor: TargetFontColor;
          targetNumber: number;
          subjectsApplied: Array<{
            subject: string;
            staffName: string;
            effectiveRating: TrackingRating;
          }>;
        }
      > = {};

      let currentTargetIndex = 1;

      for (const tgt of stuTargets) {
        const rawTitle = tgt.title.trim();
        if (!rawTitle) continue;

        if (!targetMapByTitle[rawTitle]) {
          targetMapByTitle[rawTitle] = {
            title: rawTitle,
            heading: tgt.heading?.trim() || undefined,
            challenge: tgt.challenge?.trim() || undefined,
            targetGroupId: tgt.targetGroupId?.trim() || undefined,
            fontColor: normalizeTargetFontColor(tgt.fontColor),
            targetNumber: currentTargetIndex++,
            subjectsApplied: [],
          };
        } else {
          if (!targetMapByTitle[rawTitle].heading && tgt.heading?.trim()) {
            targetMapByTitle[rawTitle].heading = tgt.heading.trim();
          }
          if (!targetMapByTitle[rawTitle].challenge && tgt.challenge?.trim()) {
            targetMapByTitle[rawTitle].challenge = tgt.challenge.trim();
          }
          if (
            !targetMapByTitle[rawTitle].targetGroupId &&
            tgt.targetGroupId?.trim()
          ) {
            targetMapByTitle[rawTitle].targetGroupId =
              tgt.targetGroupId.trim();
          }
          if (
            targetMapByTitle[rawTitle].fontColor === 'black' &&
            tgt.fontColor
          ) {
            targetMapByTitle[rawTitle].fontColor = normalizeTargetFontColor(
              tgt.fontColor
            );
          }
        }

        if (tgt.trackingRequired) {
          // Collect ratings across all active selected weeks
          const weeklyRatings = activeSelectedWeeks.map((wk) => ({
            weekNumber: wk.weekNumber,
            weekKey: wk.weekKey,
            rating: getTargetRatingForWeek(tgt, wk.weekKey),
          }));

          // Calculate consolidated tracking rating across the selected date range
          const tracked = weeklyRatings.filter(
            (w) => w.rating !== 'UNTRACKED'
          );
          let effectiveRating: TrackingRating = 'UNTRACKED';

          if (tracked.length === 0) {
            effectiveRating = 'UNTRACKED';
          } else if (tracked.every((w) => w.rating === 'NA')) {
            effectiveRating = 'NA';
          } else {
            const scored = tracked.filter((w) => w.rating !== 'NA');
            if (scored.length === 0) {
              effectiveRating = 'NA';
            } else {
              const first = scored[0].rating;
              if (scored.every((w) => w.rating === first)) {
                effectiveRating = first;
              } else {
                let sum = 0;
                let countM = 0;
                let countPA = 0;
                let countWT = 0;
                for (const item of scored) {
                  if (item.rating === 'M') {
                    sum += 100;
                    countM += 1;
                  } else if (item.rating === 'A') {
                    sum += 100;
                  } else if (item.rating === 'PA') {
                    sum += 70;
                    countPA += 1;
                  } else if (item.rating === 'WT') {
                    sum += 35;
                    countWT += 1;
                  }
                }
                const avg = Math.round(sum / scored.length);
                if (countM > 0 && countPA === 0 && countWT === 0) {
                  effectiveRating = 'M';
                } else if (avg >= 85) {
                  effectiveRating = 'A';
                } else if (avg >= 55) {
                  effectiveRating = 'PA';
                } else {
                  effectiveRating = 'WT';
                }
              }
            }
          }

          targetMapByTitle[rawTitle].subjectsApplied.push({
            subject: tgt.subject,
            staffName: tgt.assignedStaffName || tgt.subjectStaffEmail,
            effectiveRating,
          });
        }
      }

      const hierarchical = groupTargetsHierarchically(
        Object.values(targetMapByTitle)
      );

      const targetList = hierarchical.flatEntries.map((entry) => {
        const groups = formatConsolidatedGroupsForTarget(
          entry.item.subjectsApplied
        );
        return {
          ...entry.item,
          targetNumber: entry.groupNumber,
          displayNumber: entry.displayNumber,
          isSubTarget: entry.isSubTarget,
          groups,
        };
      });

      const byTitle = new Map(targetList.map((tl) => [tl.title, tl]));
      const targetGroups = hierarchical.groups.map((grp) => {
        const items = grp.entries
          .map((e) => byTitle.get(e.item.title))
          .filter((x): x is (typeof targetList)[number] => Boolean(x));
        return {
          groupKey: grp.groupKey,
          groupNumber: grp.groupNumber,
          sharedHeading: grp.sharedHeading,
          fontColor: items[0]?.fontColor || ('black' as TargetFontColor),
          items,
        };
      });

      const hasAnySubTargets = targetGroups.some((g) => g.items.length > 1);

      return {
        student,
        schoolTier: getStudentSchoolTier(student),
        targetList,
        targetGroups,
        hasAnySubTargets,
        totalTargetsCount: targetList.length,
      };
    });
  }, [filteredStudents, targets, activeSelectedWeeks, effectiveDisplayTerm]);

  // Build Individual Results (Target Number & Title | Target Description | One column per Subject with Wk1..Current rows)
  const studentWeeklyBySubjectSummaries = useMemo(() => {
    return filteredStudents.map((student) => {
      const stuTargets = targets.filter(
        (t) =>
          t.studentId === student.id &&
          t.subject !== UNASSIGNED_SUBJECT_PLACEHOLDER &&
          (effectiveDisplayTerm === 'NO ACTIVE TERM' ||
            doesTargetMatchTerm(t.term, effectiveDisplayTerm))
      );

      // Unique subjects for this student (sorted alphabetically)
      const subjectMetaMap: Record<
        string,
        {
          subject: string;
          teacherName: string;
          lsaName: string;
        }
      > = {};

      // Unique targets keyed by title
      const targetMetaMap: Record<
        string,
        {
          title: string;
          heading?: string;
          challenge?: string;
          targetGroupId?: string;
          fontColor: TargetFontColor;
          docsBySubject: Record<string, Target>;
        }
      > = {};

      for (const tgt of stuTargets) {
        const subj = tgt.subject.trim();
        const rawTitle = tgt.title.trim();
        if (!subj || !rawTitle) continue;

        if (!subjectMetaMap[subj]) {
          subjectMetaMap[subj] = {
            subject: subj,
            teacherName: tgt.teacherName?.trim() || '',
            lsaName:
              (tgt.lsaName &&
              tgt.lsaName !== 'Not Assigned' &&
              tgt.lsaName !== 'Not Applicable'
                ? tgt.lsaName
                : tgt.assignedStaffName &&
                  tgt.assignedStaffName !== 'Not Applicable' &&
                  tgt.assignedStaffName !== 'Unassigned'
                ? tgt.assignedStaffName
                : ''
              ).trim(),
          };
        } else {
          if (!subjectMetaMap[subj].teacherName && tgt.teacherName?.trim()) {
            subjectMetaMap[subj].teacherName = tgt.teacherName.trim();
          }
          if (
            !subjectMetaMap[subj].lsaName &&
            tgt.lsaName &&
            tgt.lsaName !== 'Not Assigned'
          ) {
            subjectMetaMap[subj].lsaName = tgt.lsaName.trim();
          }
        }

        if (!targetMetaMap[rawTitle]) {
          targetMetaMap[rawTitle] = {
            title: rawTitle,
            heading: tgt.heading?.trim() || undefined,
            challenge: tgt.challenge?.trim() || undefined,
            targetGroupId: tgt.targetGroupId?.trim() || undefined,
            fontColor: normalizeTargetFontColor(tgt.fontColor),
            docsBySubject: {},
          };
        } else {
          if (!targetMetaMap[rawTitle].heading && tgt.heading?.trim()) {
            targetMetaMap[rawTitle].heading = tgt.heading.trim();
          }
          if (!targetMetaMap[rawTitle].challenge && tgt.challenge?.trim()) {
            targetMetaMap[rawTitle].challenge = tgt.challenge.trim();
          }
          if (
            !targetMetaMap[rawTitle].targetGroupId &&
            tgt.targetGroupId?.trim()
          ) {
            targetMetaMap[rawTitle].targetGroupId = tgt.targetGroupId.trim();
          }
          if (
            targetMetaMap[rawTitle].fontColor === 'black' &&
            tgt.fontColor
          ) {
            targetMetaMap[rawTitle].fontColor = normalizeTargetFontColor(
              tgt.fontColor
            );
          }
        }

        const existingDoc = targetMetaMap[rawTitle].docsBySubject[subj];
        if (!existingDoc || (!existingDoc.trackingRequired && tgt.trackingRequired)) {
          targetMetaMap[rawTitle].docsBySubject[subj] = tgt;
        }
      }

      const subjects = Object.values(subjectMetaMap).sort((a, b) =>
        a.subject.localeCompare(b.subject)
      );

      const hierarchical = groupTargetsHierarchically(
        Object.values(targetMetaMap)
      );

      const sharedHeadingByGroup = new Map<number, string>();
      hierarchical.groups.forEach((grp) => {
        if (grp.sharedHeading) {
          sharedHeadingByGroup.set(grp.groupNumber, grp.sharedHeading);
        }
      });

      const targetRows = hierarchical.flatEntries.map((entry) => {
        const meta = entry.item;
        const targetNumberLabel = entry.isSubTarget
          ? `Target ${entry.displayNumber}`
          : `Target ${entry.groupNumber}`;
        const resolvedHeading = (
          meta.heading ||
          (entry.isSubTarget
            ? sharedHeadingByGroup.get(entry.groupNumber)
            : '') ||
          ''
        ).trim();

        const bySubject: Record<
          string,
          {
            applicable: boolean;
            weeklyRatings: Array<{
              weekNumber: number;
              weekKey: string;
              rating: TrackingRating;
            }>;
          }
        > = {};

        for (const subj of subjects) {
          const docItem = meta.docsBySubject[subj.subject];
          if (docItem && docItem.trackingRequired) {
            bySubject[subj.subject] = {
              applicable: true,
              weeklyRatings: termWeeksToCurrent.map((wk) => ({
                weekNumber: wk.weekNumber,
                weekKey: wk.weekKey,
                rating: getTargetRatingForWeek(docItem, wk.weekKey),
              })),
            };
          } else {
            bySubject[subj.subject] = {
              applicable: false,
              weeklyRatings: [],
            };
          }
        }

        return {
          key: `${entry.displayNumber}__${meta.title}`,
          displayNumber: entry.displayNumber,
          targetNumberLabel,
          targetTitle: resolvedHeading,
          description: meta.title,
          challenge: (meta.challenge || '').trim(),
          fontColor: meta.fontColor,
          bySubject,
        };
      });

      return {
        student,
        schoolTier: getStudentSchoolTier(student),
        subjects,
        targetRows,
      };
    });
  }, [filteredStudents, targets, termWeeksToCurrent, effectiveDisplayTerm]);

  // Formats a single student's summary as clean plain text
  const generateStudentTextSummary = (
    summary: (typeof studentSummaries)[0]
  ) => {
    const { student, targetGroups } = summary;
    const lines: string[] = [];

    lines.push(`[${student.name} ${student.yearGroup || 'Year 10'}]`);
    lines.push(`Week: ${weekRangeCellText}`);
    lines.push('');

    if (targetGroups.length === 0) {
      lines.push('No targets currently configured for this student.');
    } else {
      targetGroups.forEach((grp) => {
        if (grp.items.length > 1) {
          lines.push(
            grp.sharedHeading
              ? `Target ${grp.groupNumber}: ${grp.sharedHeading}`
              : `Target ${grp.groupNumber}`
          );
          grp.items.forEach((item) => {
            lines.push(
              `  ${item.displayNumber} ${item.title}${
                item.challenge ? ` (Challenge: ${item.challenge})` : ''
              }:`
            );
            item.groups.forEach((g) => {
              lines.push(`    ${g.subjectsFormatted}: ${g.rating}`);
            });
          });
          lines.push('');
        } else if (grp.items[0]) {
          const item = grp.items[0];
          const colHeader = formatTargetColumnHeader(
            item.targetNumber,
            item.title,
            item.heading,
            item.challenge,
            false
          );
          lines.push(`${colHeader}:`);
          item.groups.forEach((g) => {
            lines.push(`  ${g.subjectsFormatted}: ${g.rating}`);
          });
          lines.push('');
        }
      });
    }

    return lines.join('\n');
  };

  const handleCopySingleStudent = async (
    summary: (typeof studentSummaries)[0]
  ) => {
    const text = generateStudentTextSummary(summary);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStudentId(summary.student.id);
      setTimeout(() => {
        setCopiedStudentId((prev) =>
          prev === summary.student.id ? null : prev
        );
      }, 2500);
    } catch {
      // Fallback
    }
  };

  const generateStudentWeeklyTextSummary = (
    stuWeekly: (typeof studentWeeklyBySubjectSummaries)[0]
  ) => {
    const { student, subjects, targetRows } = stuWeekly;
    const lines: string[] = [];
    lines.push(`[${student.name} ${student.yearGroup || 'Year 10'}]`);
    lines.push(`Term: ${effectiveDisplayTerm} (Week 1 – Week ${currentWeekNumber})`);
    lines.push('');

    if (targetRows.length === 0 || subjects.length === 0) {
      lines.push('No tracked targets found for this term.');
    } else {
      targetRows.forEach((row) => {
        const headingStr = row.targetTitle
          ? `${row.targetNumberLabel}: ${row.targetTitle}`
          : row.targetNumberLabel;
        lines.push(headingStr);
        lines.push(`  Description: ${row.description}`);
        if (row.challenge) {
          lines.push(`  Challenge: ${row.challenge}`);
        }
        subjects.forEach((subj) => {
          const cell = row.bySubject[subj.subject];
          const subjLabel = subj.teacherName
            ? `${subj.subject} (Teacher: ${subj.teacherName})`
            : subj.subject;
          if (!cell || !cell.applicable) {
            lines.push(`  ${subjLabel}: Not Applicable`);
          } else {
            const weekPairs = cell.weeklyRatings
              .map(
                (w) =>
                  `Wk${w.weekNumber}: ${
                    w.rating === 'UNTRACKED' ? '—' : w.rating
                  }`
              )
              .join(' | ');
            lines.push(`  ${subjLabel}: ${weekPairs}`);
          }
        });
        lines.push('');
      });
    }
    return lines.join('\n');
  };

  const handleCopySingleStudentWeekly = async (
    stuWeekly: (typeof studentWeeklyBySubjectSummaries)[0]
  ) => {
    const text = generateStudentWeeklyTextSummary(stuWeekly);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStudentId(stuWeekly.student.id);
      setTimeout(() => {
        setCopiedStudentId((prev) =>
          prev === stuWeekly.student.id ? null : prev
        );
      }, 2500);
    } catch {
      // Fallback
    }
  };

  const handleCopyAllSummaries = async () => {
    const divider = '\n' + '='.repeat(50) + '\n\n';
    const cohortText =
      selectedTier === 'ALL'
        ? 'All Students'
        : selectedTier === 'MIDDLE'
        ? 'Middle School (Year 7–8)'
        : 'Upper School (Year 9–13)';

    const allText =
      summaryViewMode === 'WEEKLY_BY_SUBJECT'
        ? `ACADEMIC TARGET TRACKING · INDIVIDUAL REPORT BY SUBJECT · ${effectiveDisplayTerm}\nWeeks: Week 1 – Week ${currentWeekNumber}\nCohort Filter: ${cohortText}\nTotal Students: ${studentWeeklyBySubjectSummaries.length}\n\n` +
          studentWeeklyBySubjectSummaries
            .map(generateStudentWeeklyTextSummary)
            .join(divider) +
          '\n\n' +
          '='.repeat(50) +
          '\n' +
          `OVERALL REMARKS:\n${overallRemarks.trim() || 'No overall remarks recorded.'}\n`
        : `ACADEMIC TARGET TRACKING DATA SUMMARY · ${effectiveDisplayTerm}\nDate Range: ${activeDateRangeLabel} (Week ${weekRangeCellText})\n` +
          `Cohort Filter: ${cohortText}\n` +
          `Total Students: ${studentSummaries.length}\n\n` +
          studentSummaries.map(generateStudentTextSummary).join(divider) +
          '\n\n' +
          '='.repeat(50) +
          '\n' +
          `OVERALL REMARKS:\n${overallRemarks.trim() || 'No overall remarks recorded.'}\n`;

    try {
      await navigator.clipboard.writeText(allText);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2500);
    } catch {
      // Fallback
    }
  };

  // Export to CSV matching the active summary view
  const handleExportCSV = () => {
    const rows: string[][] = [];
    const safeTermStr = effectiveDisplayTerm.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (summaryViewMode === 'WEEKLY_BY_SUBJECT') {
      rows.push([
        `ACADEMIC TARGET TRACKING · INDIVIDUAL REPORT BY SUBJECT · ${effectiveDisplayTerm}`,
      ]);
      rows.push([
        `Weeks: Week 1 – Week ${currentWeekNumber}`,
        `Total Students: ${studentWeeklyBySubjectSummaries.length}`,
      ]);
      rows.push([]);

      studentWeeklyBySubjectSummaries.forEach((stuWeekly) => {
        rows.push([
          `${stuWeekly.student.name} ${stuWeekly.student.yearGroup || 'Year 10'}`,
        ]);
        const header = [
          'Target',
          'Target Description',
          ...stuWeekly.subjects.map((s) =>
            s.teacherName ? `${s.subject} (Teacher: ${s.teacherName})` : s.subject
          ),
        ];
        rows.push(header);
        if (
          stuWeekly.targetRows.length === 0 ||
          stuWeekly.subjects.length === 0
        ) {
          rows.push(['—', 'No tracked targets found for this term.']);
        } else {
          stuWeekly.targetRows.forEach((row) => {
            const targetCell = row.targetTitle
              ? `${row.targetNumberLabel}\n${row.targetTitle}`
              : row.targetNumberLabel;
            const descCell = row.challenge
              ? `${row.description}\nChallenge: ${row.challenge}`
              : row.description;
            const subjectCells = stuWeekly.subjects.map((subj) => {
              const cell = row.bySubject[subj.subject];
              if (!cell || !cell.applicable) return 'Not Applicable';
              return cell.weeklyRatings
                .map(
                  (w) =>
                    `Wk${w.weekNumber}: ${
                      w.rating === 'UNTRACKED' ? '—' : w.rating
                    }`
                )
                .join('\n');
            });
            rows.push([targetCell, descCell, ...subjectCells]);
          });
        }
        rows.push([]);
      });
    } else {
      // Title & Info Rows
      rows.push([`ACADEMIC TARGET TRACKING DATA SUMMARY · ${effectiveDisplayTerm}`]);
      rows.push([
        `Date Range: ${activeDateRangeLabel}`,
        `Week Range: ${weekRangeCellText}`,
      ]);
      rows.push([
        `Filter: ${
          selectedTier === 'ALL'
            ? 'All Students'
            : selectedTier === 'MIDDLE'
            ? 'Middle School (Yr 7-8)'
            : 'Upper School (Yr 9-13)'
        }`,
        `Total Students: ${studentSummaries.length}`,
      ]);
      rows.push([]);

      // For each student, output the exact table format
      studentSummaries.forEach((summary) => {
        const studentHeading = `${summary.student.name} ${
          summary.student.yearGroup || 'Year 10'
        }`;
        rows.push([studentHeading]);

        // Header row
        const headerRow = ['Week'];
        summary.targetList.forEach((t) => {
          const prefixHeading = t.isSubTarget && t.heading ? `${t.heading} — ` : '';
          headerRow.push(
            t.isSubTarget
              ? `${prefixHeading}${formatTargetColumnHeader(
                  t.displayNumber,
                  t.title,
                  undefined,
                  t.challenge,
                  true
                )}`
              : formatTargetColumnHeader(
                  t.targetNumber,
                  t.title,
                  t.heading,
                  t.challenge,
                  false
                )
          );
        });
        rows.push(headerRow);

        // Data row
        const dataRow = [weekRangeCellText];
        summary.targetList.forEach((t) => {
          const cellText = t.groups
            .map((g) => `${g.subjectsFormatted}: ${g.rating}`)
            .join('\n');
          dataRow.push(cellText);
        });
        rows.push(dataRow);
        rows.push([]); // blank line between students
      });
    }

    // Overall Remarks at the very end
    rows.push(['OVERALL REMARKS:']);
    rows.push([overallRemarks.trim() || 'No overall remarks recorded.']);

    // Format as valid CSV with RFC 4180 multiline escaping
    const csvContent = rows
      .map((row) =>
        row
          .map((field) => {
            const str = String(field ?? '');
            if (
              str.includes(',') ||
              str.includes('"') ||
              str.includes('\n') ||
              str.includes('\r')
            ) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(',')
      )
      .join('\r\n');

    const blob = new Blob(['\ufeff' + csvContent], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeDateStr = weekRangeCellText.replace(/[^a-zA-Z0-9_-]/g, '_');
    link.setAttribute(
      'download',
      summaryViewMode === 'WEEKLY_BY_SUBJECT'
        ? `TargetTrack_Individual_Report_${safeTermStr}_W1_W${currentWeekNumber}.csv`
        : `TargetTrack_Data_Summary_${safeTermStr}_Week_${safeDateStr}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /**
   * Directly generates and downloads a clean, vector A4 Portrait PDF.
   * Renders only the spreadsheet-style tables with yellow student badges,
   * exact black borders, and color-filled rating badges.
   * Completely eliminates screenshot rasterization, webpage chrome, and data scrollbars.
   */
  const handleExportPDF = async () => {
    if (isExportingPDF) return;
    setIsExportingPDF(true);

    try {
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const margin = 10;
      const pageWidth = 210;
      const usableWidth = pageWidth - margin * 2; // 190 mm

      // Document Title & Metadata Header
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(13);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`ACADEMIC TARGET TRACKING · DATA SUMMARY · ${effectiveDisplayTerm}`, margin, 14);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(0, 0, 0);
      const cohortLabel =
        selectedTier === 'ALL'
          ? 'All Students'
          : selectedTier === 'MIDDLE'
          ? 'Middle School (Yr 7-8)'
          : 'Upper School (Yr 9-13)';
      pdf.text(
        `Date Range: ${activeDateRangeLabel}   |   Week Range: ${weekRangeCellText}   |   Cohort: ${cohortLabel}`,
        margin,
        19
      );

      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.4);
      pdf.line(margin, 22, margin + usableWidth, 22);

      let currentY = 27;

      if (studentSummaries.length === 0) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(9);
        pdf.setTextColor(0, 0, 0);
        pdf.text('No students found matching your filters.', margin, currentY + 10);
      } else {
        studentSummaries.forEach((summary) => {
          const { student, targetList } = summary;

          // If no targets, draw placeholder table
          if (targetList.length === 0) {
            if (currentY + 35 > 275) {
              pdf.addPage('a4', 'portrait');
              currentY = 15;
            }
            // Yellow Student Header Badge
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(10.5);
            const studentBadgeText = `${student.name} ${student.yearGroup || 'Year 10'}`;
            const textW = pdf.getTextWidth(studentBadgeText);
            const badgeBoxW = textW + 7;
            const badgeBoxH = 6.8;

            pdf.setFillColor(254, 240, 138);
            pdf.setDrawColor(0, 0, 0);
            pdf.setLineWidth(0.35);
            pdf.rect(margin, currentY, badgeBoxW, badgeBoxH, 'FD');

            pdf.setTextColor(0, 0, 0);
            pdf.text(studentBadgeText, margin + 3.5, currentY + 4.8);
            currentY += badgeBoxH + 2;

            autoTable(pdf, {
              startY: currentY,
              margin: { left: margin, right: margin },
              tableWidth: usableWidth,
              head: [['Week', 'Status']],
              body: [[weekRangeCellText, 'No targets configured for this student']],
              styles: {
                font: 'helvetica',
                fontSize: 8,
                lineColor: [0, 0, 0] as [number, number, number],
                lineWidth: 0.35,
              },
            });
            const lastTable = (pdf as any).lastAutoTable;
            currentY = lastTable?.finalY ? lastTable.finalY + 8 : currentY + 25;
            return;
          }

          // Exact column widths calculation
          const weekColW = 18; // mm
          const numTargets = targetList.length;
          const targetColW = (usableWidth - weekColW) / numTargets;

          // Pre-calculate exact layout for each cell to guarantee no text overflows the border
          const paddingX = 2;
          const availableW = Math.max(targetColW - paddingX * 2, 8);

          interface RenderItem {
            lines: string[];
            ratingStr: string;
          }

          const cellPlans = targetList.map((item) => {
            const items: RenderItem[] = [];
            let totalVisualLines = 0;

            item.groups.forEach((grp) => {
              const ratingStr = grp.rating || 'NA';
              const subText = grp.subjectsFormatted;
              const combinedText = `${subText}:\u00A0${ratingStr}`;

              pdf.setFont('helvetica', 'normal');
              pdf.setFontSize(7.2);
              const splitLines = pdf.splitTextToSize(
                combinedText,
                Math.max(availableW - 1.5, 6)
              ) as string[];

              items.push({
                lines: splitLines.length > 0 ? splitLines : [`${subText}: ${ratingStr}`],
                ratingStr,
              });
              totalVisualLines += Math.max(1, splitLines.length);
            });

            // Required height in mm for this cell (line height 3.8mm + top/bottom padding)
            const requiredHeight = Math.max(12, totalVisualLines * 3.8 + 4.5);
            return { items, totalVisualLines, requiredHeight };
          });

          // Enforce row height across the table so all cells match the tallest content
          const maxRowHeight = Math.max(
            14,
            ...cellPlans.map((p) => p.requiredHeight)
          );

          // Estimate total student block height
          const estBlockHeight = 7.5 + 8 + maxRowHeight + 6;

          // If next student table doesn't fit on current page, start clean on next page
          if (currentY + estBlockHeight > 275) {
            pdf.addPage('a4', 'portrait');
            currentY = 15;
          }

          // 1. Yellow Student Header Badge (matches spreadsheet reference photo)
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(10.5);
          const studentBadgeText = `${student.name} ${student.yearGroup || 'Year 10'}`;
          const textW = pdf.getTextWidth(studentBadgeText);
          const badgeBoxW = textW + 7;
          const badgeBoxH = 6.8;

          pdf.setFillColor(254, 240, 138); // Yellow fill
          pdf.setDrawColor(0, 0, 0); // Solid black border
          pdf.setLineWidth(0.35);
          pdf.rect(margin, currentY, badgeBoxW, badgeBoxH, 'FD');

          pdf.setTextColor(0, 0, 0);
          pdf.text(studentBadgeText, margin + 3.5, currentY + 4.8);

          currentY += badgeBoxH + 2;

          // 2. Spreadsheet-Style Table
          const colStyles: Record<number, any> = {
            0: {
              cellWidth: weekColW,
              halign: 'center' as const,
              valign: 'middle' as const,
            },
          };
          targetList.forEach((_, idx) => {
            colStyles[idx + 1] = { cellWidth: targetColW };
          });

          const pdfHeadRows: any[] = summary.hasAnySubTargets
            ? [
                [
                  {
                    content: 'Week',
                    rowSpan: 2,
                    styles: {
                      valign: 'middle' as const,
                      halign: 'center' as const,
                    },
                  },
                  ...summary.targetGroups.map((grp) => {
                    if (grp.items.length > 1) {
                      return {
                        content: grp.sharedHeading
                          ? `Target ${grp.groupNumber}: ${grp.sharedHeading}`
                          : `Target ${grp.groupNumber}`,
                        colSpan: grp.items.length,
                        metaType: 'GROUP_PARENT',
                        groupObj: grp,
                        styles: {
                          textColor: [0, 0, 0] as [number, number, number],
                          fontStyle: 'bold' as const,
                          halign: 'center' as const,
                          valign: 'middle' as const,
                        },
                      };
                    }
                    const single = grp.items[0];
                    return {
                      content: formatTargetColumnHeader(
                        single.targetNumber,
                        single.title,
                        single.heading,
                        single.challenge,
                        false
                      ),
                      rowSpan: 2,
                      metaType: 'SINGLE_COL',
                      subTargetItem: single,
                      styles: {
                        textColor: [0, 0, 0] as [number, number, number],
                        fontStyle: 'bold' as const,
                      },
                    };
                  }),
                ],
                summary.targetGroups
                  .filter((grp) => grp.items.length > 1)
                  .flatMap((grp) =>
                    grp.items.map((sub) => ({
                      content: formatTargetColumnHeader(
                        sub.displayNumber,
                        sub.title,
                        undefined,
                        sub.challenge,
                        true
                      ),
                      metaType: 'SUB_COL',
                      subTargetItem: sub,
                      styles: {
                        textColor: [0, 0, 0] as [number, number, number],
                        fontStyle: 'bold' as const,
                      },
                    }))
                  ),
              ]
            : [
                [
                  'Week',
                  ...targetList.map((item) => ({
                    content: formatTargetColumnHeader(
                      item.targetNumber,
                      item.title,
                      item.heading,
                      item.challenge,
                      false
                    ),
                    metaType: 'SINGLE_COL',
                    subTargetItem: item,
                    styles: {
                      textColor: [0, 0, 0] as [number, number, number],
                      fontStyle: 'bold' as const,
                    },
                  })),
                ],
              ];

          autoTable(pdf, {
            startY: currentY,
            margin: { left: margin, right: margin },
            tableWidth: usableWidth,
            head: pdfHeadRows,
            body: [
              [
                {
                  content: weekRangeCellText,
                  styles: {
                    halign: 'center' as const,
                    valign: 'middle' as const,
                    fontStyle: 'bold' as const,
                    fillColor: [248, 250, 252] as [number, number, number],
                    textColor: [0, 0, 0] as [number, number, number],
                    lineColor: [0, 0, 0] as [number, number, number],
                    lineWidth: 0.35,
                    minCellHeight: maxRowHeight,
                  },
                },
                ...targetList.map((_, tIdx) => {
                  const plan = cellPlans[tIdx];
                  return {
                    content: Array(plan.totalVisualLines || 1)
                      .fill(' ')
                      .join('\n'),
                    cellPlan: plan,
                    styles: {
                      fillColor: [255, 255, 255] as [number, number, number],
                      lineColor: [0, 0, 0] as [number, number, number],
                      lineWidth: 0.35,
                      minCellHeight: maxRowHeight,
                    },
                  };
                }),
              ],
            ],
            styles: {
              font: 'helvetica',
              fontSize: 7.5,
              cellPadding: 2,
              lineColor: [0, 0, 0] as [number, number, number],
              lineWidth: 0.35,
              textColor: [0, 0, 0] as [number, number, number],
              fillColor: [255, 255, 255] as [number, number, number],
              overflow: 'linebreak',
            },
            headStyles: {
              fillColor: [255, 255, 255] as [number, number, number],
              textColor: [0, 0, 0] as [number, number, number],
              fontStyle: 'bold' as const,
              lineWidth: 0.35,
              lineColor: [0, 0, 0] as [number, number, number],
              halign: 'center' as const,
            },
            columnStyles: colStyles,
            willDrawCell: (data) => {
              const rawHead = data.cell.raw as any;
              if (
                data.section === 'head' &&
                (rawHead?.metaType || data.column.index > 0)
              ) {
                data.cell.text = [];
              }
              if (data.section === 'body' && data.column.index > 0) {
                data.cell.text = [];
              }
            },
            didDrawCell: (data) => {
              if (data.section === 'head') {
                const rawHead = data.cell.raw as any;
                if (rawHead?.metaType === 'GROUP_PARENT') {
                  const grp = rawHead.groupObj as (typeof summary.targetGroups)[0];
                  const titleStr = grp.sharedHeading
                    ? `Target ${grp.groupNumber}: ${grp.sharedHeading}`
                    : `Target ${grp.groupNumber}`;
                  const maxW = Math.max(data.cell.width - 4, 8);
                  const centerX = data.cell.x + data.cell.width / 2;
                  pdf.setFont('helvetica', 'bold');
                  pdf.setFontSize(7.5);
                  pdf.setTextColor(0, 0, 0);
                  const split = pdf.splitTextToSize(titleStr, maxW) as string[];
                  const lineStep = 3.2;
                  const totalH = split.length * lineStep;
                  let lineY =
                    data.cell.y +
                    Math.max(4.0, (data.cell.height - totalH) / 2 + 2.4);
                  const maxHeadY = data.cell.y + data.cell.height - 1.0;
                  split.forEach((ln) => {
                    if (lineY <= maxHeadY && ln) {
                      pdf.text(ln, centerX, lineY, { align: 'center' });
                    }
                    lineY += lineStep;
                  });
                  return;
                }

                const item =
                  rawHead?.subTargetItem ||
                  (data.column.index > 0 ? targetList[data.column.index - 1] : null);
                if (!item) return;

                const maxW = Math.max(data.cell.width - 4, 8);
                const centerX = data.cell.x + data.cell.width / 2;
                const cleanBody = item.title.trim();
                const match = cleanBody.match(
                  /^target\s*#?\s*\d+\s*[:\-–]?\s*(.*)$/i
                );
                const bodyText =
                  match && match[1]?.trim() ? match[1].trim() : cleanBody;

                const headerSegments: Array<{
                  text: string;
                  style: 'bold' | 'normal';
                  isChallenge?: boolean;
                }> = [];

                if (rawHead?.metaType === 'SUB_COL' || item.isSubTarget) {
                  headerSegments.push({
                    text: `${item.displayNumber}`,
                    style: 'bold',
                  });
                  headerSegments.push({
                    text: bodyText,
                    style: 'normal',
                  });
                } else if (item.heading?.trim()) {
                  headerSegments.push({
                    text: `Target ${item.targetNumber}: ${item.heading.trim()}`,
                    style: 'bold',
                  });
                  headerSegments.push({
                    text: bodyText,
                    style: 'normal',
                  });
                } else {
                  headerSegments.push({
                    text: `Target ${item.targetNumber}`,
                    style: 'bold',
                  });
                  headerSegments.push({
                    text: bodyText,
                    style: 'normal',
                  });
                }

                if (item.challenge?.trim()) {
                  headerSegments.push({
                    text: `Challenge: ${item.challenge.trim()}`,
                    style: 'bold',
                    isChallenge: true,
                  });
                }

                const linesToDraw: Array<{
                  line: string;
                  style: 'bold' | 'normal';
                  highlightChallengeWord?: boolean;
                }> = [];

                headerSegments.forEach((seg) => {
                  pdf.setFont('helvetica', seg.style);
                  pdf.setFontSize(7.5);
                  const split = pdf.splitTextToSize(seg.text, maxW) as string[];
                  split.forEach((ln, idx) => {
                    linesToDraw.push({
                      line: ln,
                      style: seg.style,
                      highlightChallengeWord: Boolean(
                        seg.isChallenge && idx === 0 && ln.startsWith('Challenge')
                      ),
                    });
                  });
                });

                const lineStep = 3.2;
                const totalTextH = linesToDraw.length * lineStep;
                let lineY =
                  data.cell.y +
                  Math.max(4.0, (data.cell.height - totalTextH) / 2 + 2.4);

                pdf.setFontSize(7.5);
                const maxHeadY = data.cell.y + data.cell.height - 1.0;

                linesToDraw.forEach(({ line, style, highlightChallengeWord }) => {
                  if (lineY > maxHeadY) return;
                  if (line) {
                    pdf.setFont('helvetica', style);
                    if (highlightChallengeWord) {
                      const totalLineW = pdf.getTextWidth(line);
                      const challengeWordW = pdf.getTextWidth('Challenge');
                      const lineLeftX = centerX - totalLineW / 2;
                      pdf.setFillColor(254, 240, 138);
                      pdf.rect(
                        lineLeftX - 0.4,
                        lineY - 2.4,
                        challengeWordW + 0.8,
                        3.2,
                        'F'
                      );
                    }
                    pdf.setTextColor(0, 0, 0);
                    pdf.text(line, centerX, lineY, { align: 'center' });
                  }
                  lineY += lineStep;
                });
                return;
              }
              if (data.section === 'body' && data.column.index > 0) {
                const rawCell = data.cell.raw as any;
                const plan = rawCell?.cellPlan;
                if (!plan || !plan.items || plan.items.length === 0) return;

                const cellX = data.cell.x;
                const cellY = data.cell.y;
                const cellH = data.cell.height;
                const startX = cellX + 2;
                const maxY = cellY + cellH - 1.5;
                let lineY = cellY + 3.8;

                plan.items.forEach((item: RenderItem) => {
                  if (lineY > maxY) return; // Strict boundary: will NEVER draw outside table border

                  item.lines.forEach((rawLine: string, lIdx: number) => {
                    if (lineY > maxY) return;
                    const cleanLine = rawLine.replace(/\u00A0/g, ' ');
                    const isLastLine = lIdx === item.lines.length - 1;

                    if (isLastLine && cleanLine.endsWith(item.ratingStr)) {
                      const prefix = cleanLine.slice(
                        0,
                        cleanLine.length - item.ratingStr.length
                      );
                      pdf.setFont('helvetica', 'normal');
                      pdf.setFontSize(7.2);
                      pdf.setTextColor(0, 0, 0);
                      pdf.text(prefix, startX, lineY);

                      const prefixW = pdf.getTextWidth(prefix);
                      pdf.setFont('helvetica', 'bold');
                      pdf.setFontSize(7.2);
                      pdf.setTextColor(0, 0, 0);
                      pdf.text(item.ratingStr, startX + prefixW, lineY);
                    } else {
                      pdf.setFont('helvetica', 'normal');
                      pdf.setFontSize(7.2);
                      pdf.setTextColor(0, 0, 0);
                      pdf.text(cleanLine, startX, lineY);
                    }

                    lineY += isLastLine ? 4.0 : 3.6;
                  });
                });
              }
            },
          });

          const lastTable = (pdf as any).lastAutoTable;
          currentY = lastTable?.finalY ? lastTable.finalY + 8 : currentY + 35;
        });
      }

      // 3. Overall Remarks Box (End of Document)
      const remarksTitle = 'OVERALL REMARKS & OBSERVATIONS';
      const remarksContent =
        overallRemarks.trim() ||
        'No overall remarks entered for this period.';

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const splitRemarks = pdf.splitTextToSize(remarksContent, usableWidth - 8);
      const remarksBoxH = Math.max(splitRemarks.length * 4 + 13, 20);

      if (currentY + remarksBoxH > 280) {
        pdf.addPage('a4', 'portrait');
        currentY = 15;
      }

      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.35);
      pdf.rect(margin, currentY, usableWidth, remarksBoxH, 'FD');

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(0, 0, 0);
      pdf.text(remarksTitle, margin + 3.5, currentY + 5.5);

      pdf.setDrawColor(203, 213, 225); // slate-300
      pdf.setLineWidth(0.2);
      pdf.line(margin + 3.5, currentY + 7.5, margin + usableWidth - 3.5, currentY + 7.5);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(0, 0, 0);
      pdf.text(splitRemarks, margin + 3.5, currentY + 11.5);

      // 4. Page numbering on all pages
      const totalPages = pdf.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(0, 0, 0);
        pdf.text(
          `Page ${p} of ${totalPages} · Academic Target Tracking Summary`,
          pageWidth / 2,
          291,
          { align: 'center' }
        );
      }

      const safeDateStr = weekRangeCellText.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTermStr = effectiveDisplayTerm.replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`TargetTrack_Data_Summary_${safeTermStr}_Week_${safeDateStr}.pdf`);
    } catch (err) {
      console.error('Failed to download PDF:', err);
    } finally {
      setIsExportingPDF(false);
    }
  };

  /**
   * Generates a clean vector PDF showing Individual Results per student:
   * Col 1: Target number & title | Col 2: Target description | Cols 3+: Subjects
   * Inside each subject cell aligned to a target: Wk1: (+indicator) ... to current week.
   */
  const handleExportWeeklyBySubjectPDF = async () => {
    if (isExportingPDF) return;
    setIsExportingPDF(true);

    try {
      const maxSubjectsCount = studentWeeklyBySubjectSummaries.reduce(
        (max, s) => Math.max(max, s.subjects.length),
        0
      );
      const useLandscape = maxSubjectsCount >= 2;
      const pdf = new jsPDF({
        orientation: useLandscape ? 'landscape' : 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const margin = 10;
      const pageWidth = useLandscape ? 297 : 210;
      const pageHeight = useLandscape ? 210 : 297;
      const usableWidth = pageWidth - margin * 2;

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12.5);
      pdf.setTextColor(0, 0, 0);
      pdf.text(
        `ACADEMIC TARGET TRACKING · INDIVIDUAL REPORT BY SUBJECT · ${effectiveDisplayTerm}`,
        margin,
        14
      );

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(0, 0, 0);
      const cohortLabel =
        selectedTier === 'ALL'
          ? 'All Students'
          : selectedTier === 'MIDDLE'
          ? 'Middle School (Yr 7-8)'
          : 'Upper School (Yr 9-13)';
      pdf.text(
        `Weeks Shown: Wk1 – Wk${currentWeekNumber} (${termWeeksToCurrent.length} week(s))   |   Cohort: ${cohortLabel}   |   Students: ${studentWeeklyBySubjectSummaries.length}`,
        margin,
        19
      );

      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.4);
      pdf.line(margin, 22, margin + usableWidth, 22);

      let currentY = 27;

      if (studentWeeklyBySubjectSummaries.length === 0) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(9);
        pdf.setTextColor(0, 0, 0);
        pdf.text('No students found matching your filters.', margin, currentY + 10);
      } else {
        const MAX_SUBJECTS_PER_TABLE = useLandscape ? 6 : 3;

        studentWeeklyBySubjectSummaries.forEach((stuWeekly) => {
          const { student, subjects, targetRows } = stuWeekly;

          if (currentY + 34 > pageHeight - 16) {
            pdf.addPage('a4', useLandscape ? 'landscape' : 'portrait');
            currentY = 14;
          }

          // Yellow Student Header Badge
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(10);
          const studentBadgeText = `${student.name} ${student.yearGroup || 'Year 10'}`;
          const badgeW = pdf.getTextWidth(studentBadgeText) + 7;
          const badgeH = 6.5;

          pdf.setFillColor(254, 240, 138);
          pdf.setDrawColor(0, 0, 0);
          pdf.setLineWidth(0.35);
          pdf.rect(margin, currentY, badgeW, badgeH, 'FD');

          pdf.setTextColor(0, 0, 0);
          pdf.text(studentBadgeText, margin + 3.5, currentY + 4.6);
          currentY += badgeH + 2;

          if (targetRows.length === 0 || subjects.length === 0) {
            autoTable(pdf, {
              startY: currentY,
              margin: { left: margin, right: margin },
              tableWidth: usableWidth,
              head: [['Target', 'Status']],
              body: [['—', 'No targets configured for this term.']],
              styles: {
                font: 'helvetica',
                fontSize: 8,
                lineColor: [0, 0, 0] as [number, number, number],
                lineWidth: 0.3,
                fillColor: [255, 255, 255] as [number, number, number],
                textColor: [0, 0, 0] as [number, number, number],
              },
              headStyles: {
                fillColor: [248, 250, 252] as [number, number, number],
                textColor: [0, 0, 0] as [number, number, number],
                fontStyle: 'bold' as const,
              },
            });
            const lastTable = (pdf as any).lastAutoTable;
            currentY = lastTable?.finalY ? lastTable.finalY + 7 : currentY + 20;
            return;
          }

          const subjectChunks: Array<typeof subjects> = [];
          for (let i = 0; i < subjects.length; i += MAX_SUBJECTS_PER_TABLE) {
            subjectChunks.push(subjects.slice(i, i + MAX_SUBJECTS_PER_TABLE));
          }

          subjectChunks.forEach((subjChunk, chunkIdx) => {
            if (chunkIdx > 0 && currentY + 28 > pageHeight - 16) {
              pdf.addPage('a4', useLandscape ? 'landscape' : 'portrait');
              currentY = 14;
            }

            const targetColW = useLandscape ? 36 : 32;
            const descColW = useLandscape ? 58 : 48;
            const remainingW = usableWidth - targetColW - descColW;
            const subjColW = Math.max(remainingW / subjChunk.length, 24);

            const headRow = [
              'Target',
              'Target Description',
              ...subjChunk.map((s) =>
                [
                  s.subject,
                  ...(s.teacherName ? [`Teacher: ${s.teacherName}`] : []),
                  ...(s.lsaName ? [`LSA: ${s.lsaName}`] : []),
                ].join('\n')
              ),
            ];

            const bodyRows = targetRows.map((row) => {
              const targetCellStr = row.targetTitle
                ? `${row.targetNumberLabel}\n${row.targetTitle}`
                : row.targetNumberLabel;
              const descCellStr = row.challenge
                ? `${row.description}\nChallenge: ${row.challenge}`
                : row.description;

              return [
                {
                  content: targetCellStr,
                  styles: {
                    fontStyle: 'bold' as const,
                    textColor: [0, 0, 0] as [number, number, number],
                    valign: 'top' as const,
                    fillColor: [248, 250, 252] as [number, number, number],
                  },
                },
                {
                  content: descCellStr,
                  descMeta: {
                    description: row.description,
                    challenge: row.challenge,
                  },
                  styles: {
                    textColor: [0, 0, 0] as [number, number, number],
                    valign: 'top' as const,
                  },
                },
                ...subjChunk.map((subj) => {
                  const cell = row.bySubject[subj.subject];
                  if (!cell || !cell.applicable) {
                    return {
                      content: 'Not Applicable',
                      styles: {
                        fontStyle: 'italic' as const,
                        textColor: [0, 0, 0] as [number, number, number],
                        valign: 'top' as const,
                      },
                    };
                  }
                  const wkLines = cell.weeklyRatings
                    .map(
                      (wr) =>
                        `Wk${wr.weekNumber}: ${
                          wr.rating === 'UNTRACKED' ? '—' : wr.rating
                        }`
                    )
                    .join('\n');
                  return {
                    content: wkLines,
                    styles: {
                      fontStyle: 'normal' as const,
                      textColor: [0, 0, 0] as [number, number, number],
                      valign: 'top' as const,
                    },
                  };
                }),
              ];
            });

            const colStyles: Record<number, any> = {
              0: { cellWidth: targetColW },
              1: { cellWidth: descColW },
            };
            subjChunk.forEach((_, sIdx) => {
              colStyles[sIdx + 2] = { cellWidth: subjColW };
            });

            autoTable(pdf, {
              startY: currentY,
              margin: { left: margin, right: margin },
              tableWidth: usableWidth,
              head: [headRow],
              body: bodyRows,
              styles: {
                font: 'helvetica',
                fontSize: 7.4,
                cellPadding: 2,
                lineColor: [0, 0, 0] as [number, number, number],
                lineWidth: 0.3,
                fillColor: [255, 255, 255] as [number, number, number],
                textColor: [0, 0, 0] as [number, number, number],
                overflow: 'linebreak',
              },
              headStyles: {
                fillColor: [248, 250, 252] as [number, number, number],
                textColor: [0, 0, 0] as [number, number, number],
                fontStyle: 'bold' as const,
                lineColor: [0, 0, 0] as [number, number, number],
                lineWidth: 0.35,
                halign: 'center' as const,
                valign: 'middle' as const,
              },
              columnStyles: colStyles,
              willDrawCell: (data) => {
                if (data.section === 'body' && data.column.index === 1) {
                  const rawCell = data.cell.raw as any;
                  if (rawCell?.descMeta) {
                    data.cell.text = [];
                  }
                }
              },
              didDrawCell: (data) => {
                if (data.section === 'body' && data.column.index === 1) {
                  const rawCell = data.cell.raw as any;
                  const descMeta = rawCell?.descMeta as
                    | { description: string; challenge: string }
                    | undefined;
                  if (!descMeta) return;

                  const padX = 2;
                  const maxW = Math.max(data.cell.width - padX * 2, 10);
                  const startX = data.cell.x + padX;
                  const maxY = data.cell.y + data.cell.height - 1.2;
                  let lineY = data.cell.y + 4.3;
                  const lineStep = 3.15;

                  pdf.setFont('helvetica', 'normal');
                  pdf.setFontSize(7.4);
                  pdf.setTextColor(0, 0, 0);
                  const descLines = pdf.splitTextToSize(
                    descMeta.description,
                    maxW
                  ) as string[];
                  descLines.forEach((ln) => {
                    if (lineY <= maxY && ln) {
                      pdf.text(ln, startX, lineY);
                    }
                    lineY += lineStep;
                  });

                  if (descMeta.challenge) {
                    pdf.setFont('helvetica', 'bold');
                    pdf.setFontSize(7.4);
                    const chLines = pdf.splitTextToSize(
                      `Challenge: ${descMeta.challenge}`,
                      maxW
                    ) as string[];
                    chLines.forEach((ln, idx) => {
                      if (lineY > maxY) return;
                      if (ln) {
                        if (idx === 0 && ln.startsWith('Challenge')) {
                          const wordW = pdf.getTextWidth('Challenge');
                          pdf.setFillColor(254, 240, 138);
                          pdf.rect(
                            startX - 0.4,
                            lineY - 2.35,
                            wordW + 0.8,
                            3.1,
                            'F'
                          );
                        }
                        pdf.setTextColor(0, 0, 0);
                        pdf.text(ln, startX, lineY);
                      }
                      lineY += lineStep;
                    });
                  }
                }
              },
            });

            const lastTable = (pdf as any).lastAutoTable;
            currentY = lastTable?.finalY ? lastTable.finalY + 5 : currentY + 25;
          });

          currentY += 3;
        });
      }

      // Overall Remarks Box
      const remarksTitle = 'OVERALL REMARKS & OBSERVATIONS';
      const remarksContent =
        overallRemarks.trim() || 'No overall remarks entered for this period.';
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const splitRemarks = pdf.splitTextToSize(remarksContent, usableWidth - 8);
      const remarksBoxH = Math.max(splitRemarks.length * 4 + 13, 20);

      if (currentY + remarksBoxH > pageHeight - 15) {
        pdf.addPage('a4', useLandscape ? 'landscape' : 'portrait');
        currentY = 14;
      }

      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.35);
      pdf.rect(margin, currentY, usableWidth, remarksBoxH, 'FD');

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(0, 0, 0);
      pdf.text(remarksTitle, margin + 3.5, currentY + 5.5);

      pdf.setDrawColor(203, 213, 225);
      pdf.setLineWidth(0.2);
      pdf.line(margin + 3.5, currentY + 7.5, margin + usableWidth - 3.5, currentY + 7.5);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(0, 0, 0);
      pdf.text(splitRemarks, margin + 3.5, currentY + 11.5);

      const totalPages = pdf.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(0, 0, 0);
        pdf.text(
          `Page ${p} of ${totalPages} · Individual Report by Subject`,
          pageWidth / 2,
          pageHeight - 6,
          { align: 'center' }
        );
      }

      const safeTermStr = effectiveDisplayTerm.replace(/[^a-zA-Z0-9_-]/g, '_');
      const selectedStu =
        selectedStudentId !== 'ALL'
          ? dropdownStudents.find((s) => s.id === selectedStudentId)
          : undefined;
      const safeStuPrefix = selectedStu
        ? `${selectedStu.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}_`
        : '';
      pdf.save(
        `TargetTrack_Individual_Report_${safeStuPrefix}${safeTermStr}_W1_W${currentWeekNumber}.pdf`
      );
    } catch (err) {
      console.error('Failed to download individual report PDF:', err);
    } finally {
      setIsExportingPDF(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Tab Header & Action Controls */}
      <div
        className={`${
          isDark
            ? 'bg-slate-900 border-slate-800 text-slate-100'
            : 'bg-white border-slate-200 text-slate-900'
        } border rounded-xl p-5 shadow-2xs space-y-4 no-print transition-colors`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`p-1.5 rounded-lg ${
                  isDark
                    ? 'bg-emerald-950/80 text-emerald-300'
                    : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                <BookOpen className="w-5 h-5" />
              </span>
              <h2
                className={`text-base font-bold ${
                  isDark ? 'text-white' : 'text-slate-900'
                }`}
              >
                Student Targets Progress · Data Summary
              </h2>
            </div>
            <p
              className={`text-xs mt-1 ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              Consolidated per-student breakdown showing each target title with
              subjects and consolidated tracking results, matching spreadsheet
              format.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <button
              type="button"
              onClick={handleCopyAllSummaries}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-2xs ${
                isDark
                  ? 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                  : 'text-slate-700 bg-white border border-slate-300 hover:bg-slate-50'
              }`}
              title="Copy formatted summary of all filtered students to clipboard"
            >
              {copiedAll ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-emerald-400 font-bold">
                    Copied All!
                  </span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-400" />
                  <span>Copy Text</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleExportCSV}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-2xs ${
                isDark
                  ? 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                  : 'text-slate-700 bg-white border border-slate-300 hover:bg-slate-50'
              }`}
              title="Export data summary as CSV spreadsheet"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" />
              <span>Export CSV</span>
            </button>

            <button
              type="button"
              disabled={isExportingPDF}
              onClick={
                summaryViewMode === 'WEEKLY_BY_SUBJECT'
                  ? handleExportWeeklyBySubjectPDF
                  : handleExportPDF
              }
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-2xs ${
                isExportingPDF
                  ? 'bg-slate-700 text-white cursor-wait'
                  : isDark
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer shadow-md shadow-indigo-950/60'
                  : 'bg-slate-900 text-white hover:bg-slate-800 cursor-pointer'
              }`}
              title={
                summaryViewMode === 'WEEKLY_BY_SUBJECT'
                  ? 'Download individual student report (Week 1 to Current Week by subject) as PDF'
                  : 'Download consolidated data summary directly as A4 portrait PDF'
              }
            >
              <Download
                className={`w-3.5 h-3.5 text-white ${
                  isExportingPDF ? 'animate-bounce' : ''
                }`}
              />
              <span>
                {isExportingPDF
                  ? 'Downloading PDF...'
                  : summaryViewMode === 'WEEKLY_BY_SUBJECT'
                  ? 'Export Report PDF'
                  : 'Export PDF'}
              </span>
            </button>
          </div>
        </div>

        {/* Summary View Mode Switcher + Student Selector + Term Selector */}
        <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 border border-slate-200 w-fit">
              <button
                type="button"
                onClick={() => setSummaryViewMode('CONSOLIDATED')}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                  summaryViewMode === 'CONSOLIDATED'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Consolidated Results
              </button>
              <button
                type="button"
                onClick={() => setSummaryViewMode('WEEKLY_BY_SUBJECT')}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                  summaryViewMode === 'WEEKLY_BY_SUBJECT'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Individual Report
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-600">Student:</span>
              <select
                value={selectedStudentId}
                onChange={(e) => setSelectedStudentId(e.target.value)}
                aria-label="Select student name"
                className="text-xs font-semibold border border-slate-300 rounded-md px-2.5 py-1.5 bg-white text-slate-900 min-w-[180px]"
              >
                <option value="ALL">
                  All Students ({dropdownStudents.length})
                </option>
                {dropdownStudents.map((stu) => (
                  <option key={stu.id} value={stu.id}>
                    {stu.name} ({stu.yearGroup || 'Year 10'})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {availableTerms.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-600">Term:</span>
              <select
                value={effectiveDisplayTerm}
                onChange={(e) => setSelectedSummaryTerm(e.target.value)}
                className="text-xs font-mono font-bold border border-slate-300 rounded-md px-2.5 py-1 bg-white text-slate-900"
              >
                {availableTerms.map((termName) => (
                  <option key={termName} value={termName}>
                    {termName}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* School Tier Filters & Student Search */}
        <div
          className={`pt-3 border-t flex flex-col md:flex-row md:items-center justify-between gap-4 ${
            isDark ? 'border-slate-800' : 'border-slate-100'
          }`}
        >
          <div
            className={`flex items-center gap-1 p-1 rounded-lg ${
              isDark ? 'bg-slate-800 border border-slate-700' : 'bg-slate-100'
            }`}
          >
            <button
              type="button"
              onClick={() => setSelectedTier('ALL')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                selectedTier === 'ALL'
                  ? isDark
                    ? 'bg-indigo-600 text-white font-bold shadow-xs'
                    : 'bg-white text-slate-900 shadow-2xs'
                  : isDark
                  ? 'text-slate-300 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All Schools ({tierCounts.all})
            </button>
            <button
              type="button"
              onClick={() => setSelectedTier('MIDDLE')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                selectedTier === 'MIDDLE'
                  ? isDark
                    ? 'bg-emerald-600 text-white font-bold shadow-xs'
                    : 'bg-white text-emerald-800 shadow-2xs'
                  : isDark
                  ? 'text-slate-300 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Middle School (Year 7–8) ({tierCounts.middle})
            </button>
            <button
              type="button"
              onClick={() => setSelectedTier('UPPER')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                selectedTier === 'UPPER'
                  ? isDark
                    ? 'bg-sky-600 text-white font-bold shadow-xs'
                    : 'bg-white text-sky-800 shadow-2xs'
                  : isDark
                  ? 'text-slate-300 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Upper School (Year 9–13) ({tierCounts.upper})
            </button>
          </div>

          {/* Student Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search student or code..."
              className={`w-full text-xs pl-8 pr-3 py-1.5 border rounded-lg focus:outline-none focus:ring-1 ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder:text-slate-400 focus:ring-indigo-400'
                  : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:ring-slate-900'
              }`}
            />
          </div>
        </div>

        {/* Date Range Filter Section (Consolidated Mode) or Term Week Summary (Weekly by Subject Mode) */}
        {summaryViewMode === 'WEEKLY_BY_SUBJECT' ? (
          <div className="pt-3 border-t -mx-5 -mb-5 p-4 px-5 rounded-b-xl border-slate-100 bg-slate-50/80 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-600" />
              <span className="font-bold text-slate-900">
                Individual Report (All Tracked Weeks by Subject):
              </span>
              <span className="font-mono font-semibold px-2.5 py-0.5 rounded bg-white border border-slate-300 text-slate-800">
                Week 1 – Week {currentWeekNumber} ({termWeeksToCurrent.length}{' '}
                week{termWeeksToCurrent.length === 1 ? '' : 's'})
              </span>
            </div>
            <span className="text-slate-500 font-medium">
              {effectiveDisplayTerm}
            </span>
          </div>
        ) : (
        <div
          className={`pt-3 border-t -mx-5 -mb-5 p-5 rounded-b-xl space-y-3 ${
            isDark
              ? 'border-slate-800 bg-slate-950/60'
              : 'border-slate-100 bg-slate-50/80'
          }`}
        >
          <div className="flex items-center gap-2">
            <Calendar
              className={`w-4 h-4 ${
                isDark ? 'text-slate-400' : 'text-slate-600'
              }`}
            />
            <span
              className={`text-xs font-bold ${
                isDark ? 'text-slate-200' : 'text-slate-900'
              }`}
            >
              Date Range Filter:
            </span>
            <span
              className={`text-xs font-mono font-semibold px-2.5 py-0.5 rounded shadow-2xs ${
                isDark
                  ? 'bg-slate-800 border border-slate-700 text-slate-200'
                  : 'bg-white border border-slate-300 text-slate-800'
              }`}
            >
              {activeDateRangeLabel}
            </span>
          </div>

          {/* Interactive Date Range Selector Controls */}
          <div
            className={`flex flex-col md:flex-row items-stretch md:items-center gap-4 p-3 rounded-lg border ${
              isDark
                ? 'bg-slate-900 border-slate-800'
                : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-semibold ${
                  isDark ? 'text-slate-300' : 'text-slate-600'
                }`}
              >
                Mode:
              </span>
              <button
                type="button"
                onClick={() => setFilterMode('RANGE')}
                className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                  filterMode === 'RANGE'
                    ? isDark
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'bg-slate-900 text-white font-bold'
                    : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Continuous Range (e.g. W1–W5)
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('CUSTOM_SELECT')}
                className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                  filterMode === 'CUSTOM_SELECT'
                    ? isDark
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'bg-slate-900 text-white font-bold'
                    : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Specific Weeks (e.g. W2 &amp; W3)
              </button>
            </div>

            {filterMode === 'RANGE' ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-xs ${
                    isDark ? 'text-slate-400' : 'text-slate-500'
                  }`}
                >
                  From:
                </span>
                <select
                  value={startWeek}
                  onChange={(e) =>
                    setStartWeek(parseInt(e.target.value, 10))
                  }
                  className={`text-xs border rounded px-2 py-1 font-mono ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-slate-200'
                      : 'bg-white border-slate-300 text-slate-900'
                  }`}
                >
                  {availableWeeksList.map((w) => (
                    <option key={w.weekNumber} value={w.weekNumber}>
                      Week {w.weekNumber} ({w.rangeLabel})
                    </option>
                  ))}
                </select>
                <span
                  className={`text-xs ${
                    isDark ? 'text-slate-400' : 'text-slate-500'
                  }`}
                >
                  To:
                </span>
                <select
                  value={endWeek}
                  onChange={(e) => setEndWeek(parseInt(e.target.value, 10))}
                  className={`text-xs border rounded px-2 py-1 font-mono ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-slate-200'
                      : 'bg-white border-slate-300 text-slate-900'
                  }`}
                >
                  {availableWeeksList.map((w) => (
                    <option key={w.weekNumber} value={w.weekNumber}>
                      Week {w.weekNumber} ({w.rangeLabel})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`text-xs mr-1 ${
                    isDark ? 'text-slate-400' : 'text-slate-500'
                  }`}
                >
                  Select weeks:
                </span>
                {availableWeeksList.map((w) => {
                  const isChecked = selectedWeekNumbers.includes(
                    w.weekNumber
                  );
                  return (
                    <button
                      key={w.weekNumber}
                      type="button"
                      onClick={() => {
                        setSelectedWeekNumbers((prev) =>
                          isChecked
                            ? prev.length > 1
                              ? prev.filter((num) => num !== w.weekNumber)
                              : prev
                            : [...prev, w.weekNumber]
                        );
                      }}
                      className={`text-[11px] font-mono px-2 py-0.5 rounded border transition-colors ${
                        isChecked
                          ? isDark
                            ? 'bg-indigo-600 text-white border-indigo-500 font-bold'
                            : 'bg-slate-900 text-white border-slate-900 font-bold'
                          : isDark
                          ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                          : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      W{w.weekNumber}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Printable / Downloadable Content Container */}
      <div
        ref={pdfExportContainerRef}
        className="space-y-8 bg-white p-4 sm:p-6 rounded-xl border border-slate-200"
      >
        {/* PDF Header block (included in exported PDF) */}
        <div className="border-b-2 border-slate-900 pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h1 className="text-base sm:text-lg font-bold text-black tracking-tight">
                {summaryViewMode === 'WEEKLY_BY_SUBJECT'
                  ? `ACADEMIC TARGET TRACKING · INDIVIDUAL REPORT BY SUBJECT · ${effectiveDisplayTerm}`
                  : `ACADEMIC TARGET TRACKING · DATA SUMMARY · ${effectiveDisplayTerm}`}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-black mt-1 font-medium">
                {summaryViewMode === 'WEEKLY_BY_SUBJECT' ? (
                  <span>
                    <strong>Weeks Shown:</strong> Week 1 – Week{' '}
                    {currentWeekNumber}
                  </span>
                ) : (
                  <>
                    <span>
                      <strong>Date Range:</strong> {activeDateRangeLabel}
                    </span>
                    <span>•</span>
                    <span>
                      <strong>Week Range:</strong> {weekRangeCellText}
                    </span>
                  </>
                )}
                <span>•</span>
                <span>
                  <strong>Cohort:</strong>{' '}
                  {selectedTier === 'ALL'
                    ? 'All Students'
                    : selectedTier === 'MIDDLE'
                    ? 'Middle School (Yr 7-8)'
                    : 'Upper School (Yr 9-13)'}
                </span>
              </div>
            </div>
            <div className="text-xs font-mono text-black">
              Total Students:{' '}
              {summaryViewMode === 'WEEKLY_BY_SUBJECT'
                ? studentWeeklyBySubjectSummaries.length
                : studentSummaries.length}
            </div>
          </div>
        </div>

        {/* Student Data Summaries List */}
        {summaryViewMode === 'WEEKLY_BY_SUBJECT' ? (
          studentWeeklyBySubjectSummaries.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
              <GraduationCap className="w-10 h-10 text-slate-400 mx-auto" />
              <h3 className="text-sm font-bold text-slate-800">
                No students found matching your filters
              </h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Adjust your search or school filter.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {studentWeeklyBySubjectSummaries.map((stuWeekly) => {
                const { student, subjects, targetRows } = stuWeekly;
                const isCopied = copiedStudentId === student.id;

                return (
                  <div
                    key={student.id}
                    className="print-student-card bg-white border border-slate-300 rounded-lg p-5 shadow-xs space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="inline-block bg-yellow-300 text-slate-900 border border-slate-900 font-bold px-3.5 py-1.5 text-sm sm:text-base shadow-2xs">
                        {student.name} {student.yearGroup || 'Year 10'}
                      </div>

                      <div className="flex items-center gap-2 no-print">
                        <button
                          type="button"
                          onClick={() => handleCopySingleStudentWeekly(stuWeekly)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition-colors shadow-2xs"
                          title="Copy individual results text to clipboard"
                        >
                          {isCopied ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              <span className="text-emerald-700 font-bold">
                                Copied!
                              </span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-slate-400" />
                              <span>Copy Table</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {targetRows.length === 0 || subjects.length === 0 ? (
                      <div className="text-xs text-slate-500 italic p-4 border border-dashed border-slate-300 rounded">
                        No tracked targets found for {student.name} in{' '}
                        {effectiveDisplayTerm}.
                      </div>
                    ) : (
                      <div className="overflow-x-auto border border-slate-900 bg-white text-black">
                        <table className="w-full border-collapse border border-slate-900 text-left text-xs text-black">
                          <thead>
                            <tr className="bg-slate-50">
                              <th className="border border-slate-900 p-2.5 font-bold text-black min-w-[140px] align-middle sticky left-0 bg-slate-50 z-10">
                                Target
                              </th>
                              <th className="border border-slate-900 p-2.5 font-bold text-black min-w-[230px] align-middle">
                                Target Description
                              </th>
                              {subjects.map((subj) => (
                                <th
                                  key={subj.subject}
                                  className="border border-slate-900 p-2.5 text-left font-bold text-black min-w-[140px] align-middle"
                                >
                                  <div>{subj.subject}</div>
                                  {subj.teacherName && (
                                    <div className="text-[10px] font-normal text-black mt-0.5">
                                      Teacher: {subj.teacherName}
                                    </div>
                                  )}
                                  {subj.lsaName && (
                                    <div className="text-[10px] font-normal text-black">
                                      LSA: {subj.lsaName}
                                    </div>
                                  )}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {targetRows.map((row) => (
                              <tr key={row.key} className="bg-white text-black">
                                <td className="border border-slate-900 p-2.5 align-top sticky left-0 bg-slate-50/80 z-10 text-black">
                                  <div className="font-bold">
                                    {row.targetNumberLabel}
                                  </div>
                                  {row.targetTitle && (
                                    <div className="font-semibold mt-0.5 whitespace-pre-wrap break-words">
                                      {row.targetTitle}
                                    </div>
                                  )}
                                </td>
                                <td className="border border-slate-900 p-2.5 align-top whitespace-pre-wrap break-words text-black">
                                  <div>{row.description}</div>
                                  {row.challenge && (
                                    <div className="font-bold mt-1 text-black">
                                      <span className="bg-yellow-200 text-black px-1 rounded-2xs">
                                        Challenge
                                      </span>
                                      : {row.challenge}
                                    </div>
                                  )}
                                </td>
                                {subjects.map((subj) => {
                                  const cell = row.bySubject[subj.subject];
                                  if (!cell || !cell.applicable) {
                                    return (
                                      <td
                                        key={subj.subject}
                                        className="border border-slate-900 p-2.5 align-top text-[11px] italic text-black"
                                      >
                                        Not Applicable
                                      </td>
                                    );
                                  }
                                  return (
                                    <td
                                      key={subj.subject}
                                      className="border border-slate-900 p-2 align-top font-mono text-[11px] text-black"
                                    >
                                      <div className="space-y-0.5 leading-snug">
                                        {cell.weeklyRatings.map((wr) => {
                                          const code =
                                            wr.rating === 'UNTRACKED'
                                              ? '—'
                                              : wr.rating;
                                          return (
                                            <div
                                              key={wr.weekKey}
                                              className="whitespace-nowrap text-black"
                                            >
                                              <span className="font-semibold">
                                                Wk{wr.weekNumber}:
                                              </span>{' '}
                                              <span
                                                className={
                                                  code === '—'
                                                    ? 'font-normal'
                                                    : 'font-bold'
                                                }
                                              >
                                                {code}
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : studentSummaries.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
            <GraduationCap className="w-10 h-10 text-slate-400 mx-auto" />
            <h3 className="text-sm font-bold text-slate-800">
              No students found matching your filters
            </h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Adjust your search or school filter.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {studentSummaries.map((summary) => {
              const { student, targetList } = summary;
              const isCopied = copiedStudentId === student.id;

              return (
                <div
                  key={student.id}
                  className="print-student-card bg-white border border-slate-300 rounded-lg p-5 shadow-xs space-y-3"
                >
                  {/* Header row: Yellow student name box (matching the photo) + copy action */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="inline-block bg-yellow-300 text-slate-900 border border-slate-900 font-bold px-3.5 py-1.5 text-sm sm:text-base shadow-2xs">
                      {student.name} {student.yearGroup || 'Year 10'}
                    </div>

                    <div className="flex items-center gap-2 no-print">
                      <button
                        type="button"
                        onClick={() => handleCopySingleStudent(summary)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition-colors shadow-2xs"
                        title="Copy summary table text to clipboard"
                      >
                        {isCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span className="text-emerald-700 font-bold">
                              Copied!
                            </span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy Table</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Spreadsheet-style Table matching the photo */}
                  {targetList.length === 0 ? (
                    <div className="text-xs text-slate-500 italic p-4 border border-dashed border-slate-300 rounded">
                      No targets have been configured for {student.name} yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-slate-900 bg-white text-black">
                      <table className="w-full border-collapse border border-slate-900 text-left text-black">
                        <thead>
                          {summary.hasAnySubTargets ? (
                            <>
                              <tr className="bg-white">
                                <th
                                  rowSpan={2}
                                  className="border border-slate-900 p-2.5 text-center font-bold text-xs text-black w-28 whitespace-nowrap align-middle"
                                >
                                  Week
                                </th>
                                {summary.targetGroups.map((grp) => {
                                  if (grp.items.length > 1) {
                                    return (
                                      <th
                                        key={grp.groupKey}
                                        colSpan={grp.items.length}
                                        className="border border-slate-900 p-2 text-center text-xs font-bold align-middle whitespace-pre-wrap break-words bg-slate-50/70 text-black"
                                      >
                                        {grp.sharedHeading
                                          ? `Target ${grp.groupNumber}: ${grp.sharedHeading}`
                                          : `Target ${grp.groupNumber}`}
                                      </th>
                                    );
                                  }
                                  const single = grp.items[0];
                                  return (
                                    <th
                                      key={single.title}
                                      rowSpan={2}
                                      className="border border-slate-900 p-2.5 text-center text-xs min-w-[150px] align-top whitespace-normal space-y-1 text-black"
                                    >
                                      <div className="font-bold whitespace-pre-wrap break-words">
                                        {single.heading
                                          ? `Target ${single.targetNumber}: ${single.heading}`
                                          : `Target ${single.targetNumber}`}
                                      </div>
                                      <div className="font-normal whitespace-pre-wrap break-words">
                                        {single.title}
                                      </div>
                                      {single.challenge && (
                                        <div className="font-bold whitespace-pre-wrap break-words">
                                          <span className="bg-yellow-200 text-black px-1 rounded-2xs">
                                            Challenge
                                          </span>
                                          : {single.challenge}
                                        </div>
                                      )}
                                    </th>
                                  );
                                })}
                              </tr>
                              <tr className="bg-white">
                                {summary.targetGroups
                                  .filter((grp) => grp.items.length > 1)
                                  .flatMap((grp) =>
                                    grp.items.map((item) => (
                                      <th
                                        key={item.title}
                                        className="border border-slate-900 p-2.5 text-center text-xs min-w-[140px] align-top whitespace-normal space-y-1 text-black"
                                      >
                                        <div className="font-bold">
                                          {item.displayNumber}
                                        </div>
                                        <div className="font-normal whitespace-pre-wrap break-words">
                                          {item.title}
                                        </div>
                                        {item.challenge && (
                                          <div className="font-bold whitespace-pre-wrap break-words">
                                            <span className="bg-yellow-200 text-black px-1 rounded-2xs">
                                              Challenge
                                            </span>
                                            : {item.challenge}
                                          </div>
                                        )}
                                      </th>
                                    ))
                                  )}
                              </tr>
                            </>
                          ) : (
                            <tr className="bg-white">
                              <th className="border border-slate-900 p-2.5 text-center font-bold text-xs text-black w-28 whitespace-nowrap align-middle">
                                Week
                              </th>
                              {targetList.map((item) => (
                                <th
                                  key={item.title}
                                  className="border border-slate-900 p-2.5 text-center text-xs min-w-[150px] align-top whitespace-normal space-y-1 text-black"
                                >
                                  <div className="font-bold whitespace-pre-wrap break-words">
                                    {item.heading
                                      ? `Target ${item.targetNumber}: ${item.heading}`
                                      : `Target ${item.targetNumber}`}
                                  </div>
                                  <div className="font-normal whitespace-pre-wrap break-words">
                                    {item.title}
                                  </div>
                                  {item.challenge && (
                                    <div className="font-bold whitespace-pre-wrap break-words">
                                      <span className="bg-yellow-200 text-black px-1 rounded-2xs">
                                        Challenge
                                      </span>
                                      : {item.challenge}
                                    </div>
                                  )}
                                </th>
                              ))}
                            </tr>
                          )}
                        </thead>
                        <tbody>
                          <tr className="bg-white text-black">
                            <td className="border border-slate-900 p-3 text-center font-bold text-xs text-black align-top whitespace-nowrap bg-slate-50/40">
                              {weekRangeCellText}
                            </td>
                            {targetList.map((item) => {
                              const groups = item.groups;
                              return (
                                <td
                                  key={item.title}
                                  className="border border-slate-900 p-3 text-xs text-black align-top leading-relaxed"
                                >
                                  <div className="space-y-1.5">
                                    {groups.map((grp, idx) => (
                                      <div
                                        key={idx}
                                        className="text-xs text-black leading-normal"
                                      >
                                        <span className="font-medium text-black">
                                          {grp.subjectsFormatted}:
                                        </span>{' '}
                                        <span
                                          className={`inline font-bold whitespace-nowrap ${getRatingColorClasses(
                                            grp.rating
                                          )}`}
                                        >
                                          {grp.rating}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* OVERALL REMARKS BOX (Cohort-Level at the End) */}
        <div className="bg-white border-2 border-slate-900 text-slate-900 rounded-lg p-5 shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wide flex items-center gap-2 text-slate-900">
                <span className="w-2.5 h-2.5 rounded-full inline-block bg-slate-900"></span>
                Overall Remarks &amp; Observations
              </h3>
            </div>

            <div className="flex items-center gap-2 no-print">
              {savedRemarksStatus ? (
                <span className="text-xs text-emerald-600 font-bold inline-flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Saved!
                </span>
              ) : null}
              <button
                type="button"
                onClick={handleSaveOverallRemarks}
                className="px-3.5 py-1.5 text-xs font-semibold rounded hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 shadow-2xs bg-slate-900 text-white"
              >
                <Save className="w-3.5 h-3.5" />
                Save Overall Remarks
              </button>
            </div>
          </div>

          <textarea
            value={overallRemarks}
            onChange={(e) => handleOverallRemarksChange(e.target.value)}
            onBlur={handleSaveOverallRemarks}
            placeholder="Enter overall remarks, cohort summary notes, achievements, or next focus areas..."
            rows={4}
            className="w-full text-xs border border-slate-300 rounded-md p-3 focus:outline-none focus:border-slate-900 bg-slate-50/50 text-slate-900 leading-relaxed font-sans"
          />
        </div>
      </div>
    </div>
  );
};
