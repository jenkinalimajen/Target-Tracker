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
  getTargetFontColorClass,
  getTargetFontColorRgb,
  groupTargetsHierarchically,
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
      return 'bg-purple-600 text-white border border-purple-700 shadow-2xs';
    case 'A':
      return 'bg-emerald-600 text-white border border-emerald-700 shadow-2xs';
    case 'PA':
      return 'bg-sky-500 text-white border border-sky-600 shadow-2xs';
    case 'WT':
      return 'bg-amber-500 text-white border border-amber-600 shadow-2xs';
    case 'NA':
      return 'bg-slate-500 text-white border border-slate-600 shadow-2xs';
    default:
      return 'bg-slate-200 text-slate-700 border border-slate-300';
  }
}

/**
 * Returns exact RGB colors for crisp vector PDF rendering of rating badges
 */
export function getRatingRgb(
  rating: TrackingRating | string
): [number, number, number] {
  switch (rating) {
    case 'M':
      return [147, 51, 234]; // Purple #9333ea
    case 'A':
      return [22, 163, 74]; // Emerald green #16a34a
    case 'PA':
      return [14, 165, 233]; // Sky blue #0ea5e9
    case 'WT':
      return [217, 119, 6]; // Amber #d97706
    case 'EXP':
      return [99, 102, 241]; // Indigo #6366f1
    case 'NA':
    default:
      return [100, 116, 139]; // Slate #64748b
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
  // 1. School Tier Filter: All, Middle School (Yr 7-8), Upper School (Yr 9-13)
  const [selectedTier, setSelectedTier] = useState<SchoolTier>('ALL');

  // 2. Student Search input
  const [searchQuery, setSearchQuery] = useState('');

  // 3. Date Range Filter State
  const [filterMode, setFilterMode] = useState<'RANGE' | 'CUSTOM_SELECT'>(
    'RANGE'
  );

  const currentWeekNumber = weekSetup.baseWeekNumber || 1;
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

  // Filter students by School Tier and Search query
  const filteredStudents = useMemo(() => {
    return students.filter((stu) => {
      if (selectedTier !== 'ALL') {
        const stuTier = getStudentSchoolTier(stu);
        if (stuTier !== selectedTier) return false;
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
  }, [students, selectedTier, searchQuery]);

  // Build consolidated target progress data structure per student matching photo layout
  const studentSummaries = useMemo(() => {
    return filteredStudents.map((student) => {
      const stuTargets = targets.filter(
        (t) =>
          t.studentId === student.id &&
          t.subject !== UNASSIGNED_SUBJECT_PLACEHOLDER
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
  }, [filteredStudents, targets, activeSelectedWeeks]);

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
              lines.push(`    ${g.subjectsFormatted} - ${g.rating}`);
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
            lines.push(`  ${g.subjectsFormatted} - ${g.rating}`);
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

  const handleCopyAllSummaries = async () => {
    const divider = '\n' + '='.repeat(50) + '\n\n';
    const allText =
      `ACADEMIC TARGET TRACKING DATA SUMMARY · ${activeTerm}\nDate Range: ${activeDateRangeLabel} (Week ${weekRangeCellText})\n` +
      `Cohort Filter: ${
        selectedTier === 'ALL'
          ? 'All Students'
          : selectedTier === 'MIDDLE'
          ? 'Middle School (Year 7–8)'
          : 'Upper School (Year 9–13)'
      }\n` +
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

  // Export to CSV with exact app structure and overall remarks
  const handleExportCSV = () => {
    const rows: string[][] = [];

    // Title & Info Rows
    rows.push([`ACADEMIC TARGET TRACKING DATA SUMMARY · ${activeTerm}`]);
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
          .map((g) => `${g.subjectsFormatted} - ${g.rating}`)
          .join('\n');
        dataRow.push(cellText);
      });
      rows.push(dataRow);
      rows.push([]); // blank line between students
    });

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
    const safeTermStr = activeTerm.replace(/[^a-zA-Z0-9_-]/g, '_');
    link.setAttribute(
      'download',
      `TargetTrack_Data_Summary_${safeTermStr}_Week_${safeDateStr}.csv`
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
      pdf.setTextColor(15, 23, 42);
      pdf.text(`ACADEMIC TARGET TRACKING · DATA SUMMARY · ${activeTerm}`, margin, 14);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(71, 85, 105);
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

      pdf.setDrawColor(15, 23, 42);
      pdf.setLineWidth(0.4);
      pdf.line(margin, 22, margin + usableWidth, 22);

      let currentY = 27;

      if (studentSummaries.length === 0) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(9);
        pdf.setTextColor(100, 116, 139);
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
            type: 'inline' | 'wrapped';
            subText: string;
            dashText: string;
            ratingStr: string;
            badgeW: number;
            badgeH: number;
            subLines: string[];
          }

          const cellPlans = targetList.map((item) => {
            const items: RenderItem[] = [];
            let totalVisualLines = 0;

            item.groups.forEach((grp) => {
              const ratingStr = grp.rating || 'NA';
              pdf.setFont('helvetica', 'bold');
              pdf.setFontSize(6.5);
              const ratingTextW = pdf.getTextWidth(ratingStr);
              const badgeW = Math.max(ratingTextW + 2.6, 6.5);
              const badgeH = 3.4;

              pdf.setFont('helvetica', 'normal');
              pdf.setFontSize(7.2);
              const subText = grp.subjectsFormatted;
              const dashText = ' - ';
              const subW = pdf.getTextWidth(subText);
              const dashW = pdf.getTextWidth(dashText);

              if (subW + dashW + badgeW <= availableW) {
                // Fits on a single line
                items.push({
                  type: 'inline',
                  subText,
                  dashText,
                  ratingStr,
                  badgeW,
                  badgeH,
                  subLines: [],
                });
                totalVisualLines += 1;
              } else {
                // Multi-line wrap
                const splitSub = pdf.splitTextToSize(subText, availableW);
                items.push({
                  type: 'wrapped',
                  subText,
                  dashText,
                  ratingStr,
                  badgeW,
                  badgeH,
                  subLines: splitSub,
                });
                totalVisualLines += splitSub.length + 1; // subject lines + badge below
              }
            });

            // Required height in mm for this cell (line height 3.8mm + top/bottom padding)
            const requiredHeight = Math.max(12, totalVisualLines * 4.0 + 4);
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
                          textColor: getTargetFontColorRgb(grp.fontColor),
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
                        textColor: getTargetFontColorRgb(single.fontColor),
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
                        textColor: getTargetFontColorRgb(sub.fontColor),
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
                      textColor: getTargetFontColorRgb(item.fontColor),
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
              textColor: [15, 23, 42] as [number, number, number],
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
                  const rgb = getTargetFontColorRgb(grp.fontColor);
                  const titleStr = grp.sharedHeading
                    ? `Target ${grp.groupNumber}: ${grp.sharedHeading}`
                    : `Target ${grp.groupNumber}`;
                  const maxW = Math.max(data.cell.width - 4, 8);
                  const centerX = data.cell.x + data.cell.width / 2;
                  pdf.setFont('helvetica', 'bold');
                  pdf.setFontSize(7.5);
                  pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
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

                const rgb = getTargetFontColorRgb(item.fontColor);
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
                  });
                }

                const linesToDraw: Array<{
                  line: string;
                  style: 'bold' | 'normal';
                }> = [];

                headerSegments.forEach((seg) => {
                  pdf.setFont('helvetica', seg.style);
                  pdf.setFontSize(7.5);
                  const split = pdf.splitTextToSize(seg.text, maxW) as string[];
                  split.forEach((ln) => {
                    linesToDraw.push({ line: ln, style: seg.style });
                  });
                });

                const lineStep = 3.2;
                const totalTextH = linesToDraw.length * lineStep;
                let lineY =
                  data.cell.y +
                  Math.max(4.0, (data.cell.height - totalTextH) / 2 + 2.4);

                pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
                pdf.setFontSize(7.5);
                const maxHeadY = data.cell.y + data.cell.height - 1.0;

                linesToDraw.forEach(({ line, style }) => {
                  if (lineY > maxHeadY) return;
                  if (line) {
                    pdf.setFont('helvetica', style);
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

                  const rgb = getRatingRgb(item.ratingStr);

                  if (item.type === 'inline') {
                    // Draw subject text
                    pdf.setFont('helvetica', 'normal');
                    pdf.setFontSize(7.2);
                    pdf.setTextColor(15, 23, 42);
                    pdf.text(item.subText, startX, lineY);

                    // Draw dash
                    pdf.setFont('helvetica', 'bold');
                    pdf.setTextColor(148, 163, 184);
                    const subW = pdf.getTextWidth(item.subText);
                    pdf.text(item.dashText, startX + subW, lineY);

                    // Draw rating badge
                    const dashW = pdf.getTextWidth(item.dashText);
                    const badgeX = startX + subW + dashW;
                    const badgeY = lineY - 2.6;

                    pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
                    pdf.setDrawColor(
                      Math.max(0, rgb[0] - 25),
                      Math.max(0, rgb[1] - 25),
                      Math.max(0, rgb[2] - 25)
                    );
                    pdf.setLineWidth(0.15);
                    pdf.roundedRect(
                      badgeX,
                      badgeY,
                      item.badgeW,
                      item.badgeH,
                      0.6,
                      0.6,
                      'FD'
                    );

                    pdf.setTextColor(255, 255, 255);
                    pdf.setFont('helvetica', 'bold');
                    pdf.setFontSize(6.5);
                    const textW = pdf.getTextWidth(item.ratingStr);
                    pdf.text(
                      item.ratingStr,
                      badgeX + (item.badgeW - textW) / 2,
                      lineY - 0.2
                    );

                    lineY += 4.0;
                  } else {
                    // Wrapped subject lines
                    pdf.setFont('helvetica', 'normal');
                    pdf.setFontSize(7.0);
                    pdf.setTextColor(15, 23, 42);

                    item.subLines.forEach((sLine: string) => {
                      if (lineY <= maxY) {
                        pdf.text(sLine, startX, lineY);
                        lineY += 3.4;
                      }
                    });

                    // Draw rating badge right below
                    if (lineY <= maxY) {
                      const badgeX = startX;
                      const badgeY = lineY - 2.6;

                      pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
                      pdf.setDrawColor(
                        Math.max(0, rgb[0] - 25),
                        Math.max(0, rgb[1] - 25),
                        Math.max(0, rgb[2] - 25)
                      );
                      pdf.setLineWidth(0.15);
                      pdf.roundedRect(
                        badgeX,
                        badgeY,
                        item.badgeW,
                        item.badgeH,
                        0.6,
                        0.6,
                        'FD'
                      );

                      pdf.setTextColor(255, 255, 255);
                      pdf.setFont('helvetica', 'bold');
                      pdf.setFontSize(6.5);
                      const textW = pdf.getTextWidth(item.ratingStr);
                      pdf.text(
                        item.ratingStr,
                        badgeX + (item.badgeW - textW) / 2,
                        lineY - 0.2
                      );

                      lineY += 4.0;
                    }
                  }
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
      pdf.setTextColor(30, 41, 59);
      pdf.text(splitRemarks, margin + 3.5, currentY + 11.5);

      // 4. Page numbering on all pages
      const totalPages = pdf.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(148, 163, 184); // slate-400
        pdf.text(
          `Page ${p} of ${totalPages} · Academic Target Tracking Summary`,
          pageWidth / 2,
          291,
          { align: 'center' }
        );
      }

      const safeDateStr = weekRangeCellText.replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`TargetTrack_Data_Summary_Week_${safeDateStr}.pdf`);
    } catch (err) {
      console.error('Failed to download PDF:', err);
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
              onClick={handleExportPDF}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-2xs ${
                isExportingPDF
                  ? 'bg-slate-700 text-white cursor-wait'
                  : isDark
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer shadow-md shadow-indigo-950/60'
                  : 'bg-slate-900 text-white hover:bg-slate-800 cursor-pointer'
              }`}
              title="Download data summary directly as A4 portrait PDF"
            >
              <Download
                className={`w-3.5 h-3.5 text-white ${
                  isExportingPDF ? 'animate-bounce' : ''
                }`}
              />
              <span>{isExportingPDF ? 'Downloading PDF...' : 'Export PDF'}</span>
            </button>
          </div>
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

        {/* Date Range Filter Section */}
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
              <h1 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                ACADEMIC TARGET TRACKING · DATA SUMMARY · {activeTerm}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700 mt-1 font-medium">
                <span>
                  <strong>Date Range:</strong> {activeDateRangeLabel}
                </span>
                <span>•</span>
                <span>
                  <strong>Week Range:</strong> {weekRangeCellText}
                </span>
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
            <div className="text-xs font-mono text-slate-500">
              Total Students: {studentSummaries.length}
            </div>
          </div>
        </div>

        {/* Student Data Summaries List */}
        {studentSummaries.length === 0 ? (
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
                    <div className="overflow-x-auto border border-slate-900 bg-white">
                      <table className="w-full border-collapse border border-slate-900 text-left">
                        <thead>
                          {summary.hasAnySubTargets ? (
                            <>
                              <tr className="bg-white">
                                <th
                                  rowSpan={2}
                                  className="border border-slate-900 p-2.5 text-center font-bold text-xs text-slate-900 w-28 whitespace-nowrap align-middle"
                                >
                                  Week
                                </th>
                                {summary.targetGroups.map((grp) => {
                                  if (grp.items.length > 1) {
                                    return (
                                      <th
                                        key={grp.groupKey}
                                        colSpan={grp.items.length}
                                        className={`border border-slate-900 p-2 text-center text-xs font-bold align-middle whitespace-pre-wrap break-words bg-slate-50/70 ${getTargetFontColorClass(
                                          grp.fontColor
                                        )}`}
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
                                      className={`border border-slate-900 p-2.5 text-center text-xs min-w-[150px] align-top whitespace-normal space-y-1 ${getTargetFontColorClass(
                                        single.fontColor
                                      )}`}
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
                                          Challenge: {single.challenge}
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
                                        className={`border border-slate-900 p-2.5 text-center text-xs min-w-[140px] align-top whitespace-normal space-y-1 ${getTargetFontColorClass(
                                          item.fontColor
                                        )}`}
                                      >
                                        <div className="font-bold">
                                          {item.displayNumber}
                                        </div>
                                        <div className="font-normal whitespace-pre-wrap break-words">
                                          {item.title}
                                        </div>
                                        {item.challenge && (
                                          <div className="font-bold whitespace-pre-wrap break-words">
                                            Challenge: {item.challenge}
                                          </div>
                                        )}
                                      </th>
                                    ))
                                  )}
                              </tr>
                            </>
                          ) : (
                            <tr className="bg-white">
                              <th className="border border-slate-900 p-2.5 text-center font-bold text-xs text-slate-900 w-28 whitespace-nowrap align-middle">
                                Week
                              </th>
                              {targetList.map((item) => (
                                <th
                                  key={item.title}
                                  className={`border border-slate-900 p-2.5 text-center text-xs min-w-[150px] align-top whitespace-normal space-y-1 ${getTargetFontColorClass(
                                    item.fontColor
                                  )}`}
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
                                      Challenge: {item.challenge}
                                    </div>
                                  )}
                                </th>
                              ))}
                            </tr>
                          )}
                        </thead>
                        <tbody>
                          <tr className="bg-white">
                            <td className="border border-slate-900 p-3 text-center font-bold text-xs text-slate-900 align-top whitespace-nowrap bg-slate-50/40">
                              {weekRangeCellText}
                            </td>
                            {targetList.map((item) => {
                              const groups = item.groups;
                              return (
                                <td
                                  key={item.title}
                                  className="border border-slate-900 p-3 text-xs text-slate-900 align-top leading-relaxed"
                                >
                                  <div className="space-y-1.5">
                                    {groups.map((grp, idx) => (
                                      <div
                                        key={idx}
                                        className="flex flex-wrap items-center gap-1.5 text-xs text-slate-900 leading-normal"
                                      >
                                        <span className="font-medium text-slate-900">
                                          {grp.subjectsFormatted}
                                        </span>
                                        <span className="text-slate-400 font-bold">
                                          -
                                        </span>
                                        <span
                                          className={`inline-block px-2 py-0.5 text-[11px] font-bold rounded ${getRatingColorClasses(
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
