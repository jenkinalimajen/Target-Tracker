import {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  buildWeekScheduleFromOffset,
  getCurrentWeekKey,
  getUpcomingFridayDeadline,
} from './types';

export async function seedAcademicCohortData(
  adminUid: string,
  adminEmail: string,
  adminDisplayName: string
): Promise<void> {
  // 0. Confirm live Firestore connectivity and exit cleanly if cohort is already seeded
  try {
    const existingAdminDoc = await getDocFromServer(
      doc(db, 'staff', 'staff_admin_owner')
    );
    if (existingAdminDoc.exists()) {
      return;
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes('offline')
    ) {
      return;
    }
  }
  const normalizedAdminEmail = (
    adminEmail || 'j.alimajen_wis@gemswis.com'
  )
    .trim()
    .toLowerCase();
  const adminName = (adminDisplayName || 'Administrator').trim().slice(0, 100);
  const weekKey = getCurrentWeekKey(0);
  const prevWeek1Key = buildWeekScheduleFromOffset(-1, 0).weekKey;
  const prevWeek2Key = buildWeekScheduleFromOffset(-2, 0).weekKey;
  const deadline = getUpcomingFridayDeadline(0);

  // 1. Seed Users (Admin + Staff accounts)
  const staffRecords = [
    {
      id: 'staff_admin_owner',
      adminUid,
      name: adminName,
      email: normalizedAdminEmail,
      department: 'Administration',
      role: 'ADMIN' as const,
      inviteStatus: 'ACTIVE' as const,
    },
    {
      id: 'staff_clara_vance',
      adminUid,
      name: 'Clara Vance',
      email: 'clara.vance@oakridge.edu',
      department: 'English',
      role: 'STAFF' as const,
      inviteStatus: 'ACTIVE' as const,
    },
    {
      id: 'staff_david_okafor',
      adminUid,
      name: 'David Okafor',
      email: 'david.okafor@oakridge.edu',
      department: 'Science',
      role: 'STAFF' as const,
      inviteStatus: 'INVITED' as const,
    },
    {
      id: 'staff_hannah_lin',
      adminUid,
      name: 'Hannah Lin',
      email: 'hannah.lin@oakridge.edu',
      department: 'Mathematics',
      role: 'STAFF' as const,
      inviteStatus: 'ACTIVE' as const,
    },
  ];

  for (const staff of staffRecords) {
    const path = `staff/${staff.id}`;
    try {
      const existing = await getDoc(doc(db, 'staff', staff.id));
      if (!existing.exists()) {
        await setDoc(doc(db, 'staff', staff.id), {
          adminUid: staff.adminUid,
          name: staff.name,
          email: staff.email,
          department: staff.department,
          role: staff.role,
          inviteStatus: staff.inviteStatus,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      const cleanSeedEmail = staff.email.trim().toLowerCase();
      if (cleanSeedEmail.includes('@')) {
        await setDoc(doc(db, 'allowed_emails', cleanSeedEmail), {
          email: cleanSeedEmail,
          addedByUid: staff.adminUid,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  // 2. Seed Students
  const studentRecords = [
    {
      id: 'stu_leo_mercer',
      adminUid,
      name: 'Leo Mercer',
      yearGroup: 'Year 10 · Group A',
      studentCode: 'STU-101',
      mentorName: 'Ms. Eleanor Vance',
      subjects: ['Mathematics', 'English'],
      assignedStaffEmails: [
        'hannah.lin@oakridge.edu',
        'clara.vance@oakridge.edu',
      ],
    },
    {
      id: 'stu_maya_patel',
      adminUid,
      name: 'Maya Patel',
      yearGroup: 'Year 10 · Group B',
      studentCode: 'STU-102',
      mentorName: 'Mr. Arthur Pendelton',
      subjects: ['Mathematics', 'Further Mathematics', 'Science'],
      assignedStaffEmails: [
        'hannah.lin@oakridge.edu',
        'david.okafor@oakridge.edu',
      ],
    },
    {
      id: 'stu_amara_osei',
      adminUid,
      name: 'Amara Osei',
      yearGroup: 'Year 9 · Group C',
      studentCode: 'STU-103',
      mentorName: 'Dr. Julian Thorne',
      subjects: ['English', 'Science'],
      assignedStaffEmails: [
        'clara.vance@oakridge.edu',
        'david.okafor@oakridge.edu',
      ],
    },
    {
      id: 'stu_toby_miller',
      adminUid,
      name: 'Toby Miller',
      yearGroup: 'Year 7 · Group A',
      studentCode: 'STU-104',
      mentorName: 'Mr. Arthur Pendelton',
      subjects: ['Mathematics', 'English'],
      assignedStaffEmails: [
        'hannah.lin@oakridge.edu',
        'clara.vance@oakridge.edu',
      ],
    },
    {
      id: 'stu_zara_khan',
      adminUid,
      name: 'Zara Khan',
      yearGroup: 'Year 8 · Group B',
      studentCode: 'STU-105',
      mentorName: 'Ms. Eleanor Vance',
      subjects: ['English', 'Science'],
      assignedStaffEmails: [
        'clara.vance@oakridge.edu',
        'david.okafor@oakridge.edu',
      ],
    },
  ];

  for (const stu of studentRecords) {
    const path = `students/${stu.id}`;
    try {
      const existing = await getDoc(doc(db, 'students', stu.id));
      if (!existing.exists()) {
        await setDoc(doc(db, 'students', stu.id), {
          adminUid: stu.adminUid,
          name: stu.name,
          yearGroup: stu.yearGroup,
          studentCode: stu.studentCode,
          mentorName: stu.mentorName,
          subjects: stu.subjects,
          assignedStaffEmails: stu.assignedStaffEmails,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  // 3. Seed Targets (4 targets per student, showing applicable vs light-grey non-applicable targets & multi-week history)
  const mayaTargetsList = [
    {
      title: 'Complete starter activity independently within 5 minutes',
      mathApplicable: true,
      mathStatus: 'UNTRACKED' as const,
      mathScore: 0,
      mathHistory: `${prevWeek2Key}:WT,${prevWeek1Key}:PA`,
      sciApplicable: true,
      sciStatus: 'UNTRACKED' as const,
      sciScore: 0,
      sciHistory: `${prevWeek2Key}:WT,${prevWeek1Key}:PA`,
    },
    {
      title: 'Show full step-by-step working for multi-step calculations',
      mathApplicable: true,
      mathStatus: 'UNTRACKED' as const,
      mathScore: 0,
      mathHistory: `${prevWeek2Key}:PA,${prevWeek1Key}:A`,
      sciApplicable: true,
      sciStatus: 'UNTRACKED' as const,
      sciScore: 0,
      sciHistory: `${prevWeek2Key}:WT,${prevWeek1Key}:WT`,
    },
    {
      title:
        'Use precise scientific terminology when explaining lab observations',
      mathApplicable: false, // Not applicable in Mathematics -> rendered in light grey, unclickable for Math staff
      mathStatus: 'UNTRACKED' as const,
      mathScore: 0,
      mathHistory: '',
      sciApplicable: true,
      sciStatus: 'UNTRACKED' as const,
      sciScore: 0,
      sciHistory: `${prevWeek2Key}:PA,${prevWeek1Key}:A`,
    },
    {
      title:
        'Ask for clarification proactively when encountering unfamiliar problems',
      mathApplicable: true,
      mathStatus: 'UNTRACKED' as const,
      mathScore: 0,
      mathHistory: `${prevWeek2Key}:WT,${prevWeek1Key}:A`,
      sciApplicable: false, // Not applicable in Science -> rendered in light grey, unclickable for Science staff
      sciStatus: 'UNTRACKED' as const,
      sciScore: 0,
      sciHistory: '',
    },
  ];

  const targetRecords = [
    // Leo Mercer — 4 targets across Mathematics & English (All applicable targets tracked & saved -> GREEN button)
    {
      id: 'tgt_leo_math_1',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'Mathematics',
      title: 'Follow multi-step instructions independently',
      trackingRequired: true,
      assignedStaffEmail: 'hannah.lin@oakridge.edu',
      assignedStaffName: 'Hannah Lin',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:PA,${weekKey}:A`,
      lastTrackedByEmail: 'hannah.lin@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_math_2',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'Mathematics',
      title: 'Solve linear equations with two variables',
      trackingRequired: true,
      assignedStaffEmail: 'hannah.lin@oakridge.edu',
      assignedStaffName: 'Hannah Lin',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A,${weekKey}:A`,
      lastTrackedByEmail: 'hannah.lin@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_math_3',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'Mathematics',
      title: 'Structure analytical paragraphs with textual evidence',
      trackingRequired: false,
      assignedStaffEmail: 'none',
      assignedStaffName: 'Not Applicable',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: '',
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_math_4',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'Mathematics',
      title: 'Check and verify answers before submitting classwork',
      trackingRequired: true,
      assignedStaffEmail: 'hannah.lin@oakridge.edu',
      assignedStaffName: 'Hannah Lin',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'PA' as const,
      currentWeekKey: weekKey,
      progressScore: 70,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:PA,${weekKey}:PA`,
      lastTrackedByEmail: 'hannah.lin@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_eng_1',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'English',
      title: 'Follow multi-step instructions independently',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A,${weekKey}:A`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_eng_2',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'English',
      title: 'Solve linear equations with two variables',
      trackingRequired: false,
      assignedStaffEmail: 'none',
      assignedStaffName: 'Not Applicable',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: '',
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_eng_3',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'English',
      title: 'Structure analytical paragraphs with textual evidence',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'PA' as const,
      currentWeekKey: weekKey,
      progressScore: 70,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:PA,${weekKey}:PA`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_leo_eng_4',
      adminUid,
      studentId: 'stu_leo_mercer',
      studentName: 'Leo Mercer',
      subject: 'English',
      title: 'Check and verify answers before submitting classwork',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A,${weekKey}:A`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },

    // Maya Patel — 4 targets across Mathematics, Further Mathematics & Science
    ...mayaTargetsList.flatMap((item, index) => [
      {
        id: `tgt_maya_math_${index + 1}`,
        adminUid,
        studentId: 'stu_maya_patel',
        studentName: 'Maya Patel',
        subject: 'Mathematics',
        title: item.title,
        trackingRequired: item.mathApplicable,
        assignedStaffEmail: item.mathApplicable
          ? 'hannah.lin@oakridge.edu'
          : 'none',
        assignedStaffName: item.mathApplicable
          ? 'Hannah Lin'
          : 'Not Applicable',
        subjectStaffEmail: 'hannah.lin@oakridge.edu',
        currentWeekStatus: item.mathStatus,
        currentWeekKey: weekKey,
        progressScore: item.mathScore,
        weeklyHistorySummary: item.mathHistory,
        lastTrackedByEmail: 'none',
        deadlineDate: deadline,
        notes: '',
      },
      {
        id: `tgt_maya_fmath_${index + 1}`,
        adminUid,
        studentId: 'stu_maya_patel',
        studentName: 'Maya Patel',
        subject: 'Further Mathematics',
        title: item.title,
        trackingRequired: item.mathApplicable,
        assignedStaffEmail: item.mathApplicable
          ? 'hannah.lin@oakridge.edu'
          : 'none',
        assignedStaffName: item.mathApplicable
          ? 'Hannah Lin'
          : 'Not Applicable',
        subjectStaffEmail: 'hannah.lin@oakridge.edu',
        currentWeekStatus: 'UNTRACKED' as const,
        currentWeekKey: weekKey,
        progressScore: 0,
        weeklyHistorySummary: item.mathHistory,
        lastTrackedByEmail: 'none',
        deadlineDate: deadline,
        notes: '',
      },
      {
        id: `tgt_maya_sci_${index + 1}`,
        adminUid,
        studentId: 'stu_maya_patel',
        studentName: 'Maya Patel',
        subject: 'Science',
        title: item.title,
        trackingRequired: item.sciApplicable,
        assignedStaffEmail: item.sciApplicable
          ? 'david.okafor@oakridge.edu'
          : 'none',
        assignedStaffName: item.sciApplicable
          ? 'David Okafor'
          : 'Not Applicable',
        subjectStaffEmail: 'david.okafor@oakridge.edu',
        currentWeekStatus: item.sciStatus,
        currentWeekKey: weekKey,
        progressScore: item.sciScore,
        weeklyHistorySummary: item.sciHistory,
        lastTrackedByEmail: 'none',
        deadlineDate: deadline,
        notes: '',
      },
    ]),

    // Amara Osei — English & Science
    {
      id: 'tgt_amara_eng_1',
      adminUid,
      studentId: 'stu_amara_osei',
      studentName: 'Amara Osei',
      subject: 'English',
      title: 'Compare poetic form and imagery across texts',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:PA`,
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_amara_eng_2',
      adminUid,
      studentId: 'stu_amara_osei',
      studentName: 'Amara Osei',
      subject: 'English',
      title: 'Explain enzyme reaction rates using collision theory',
      trackingRequired: false,
      assignedStaffEmail: 'none',
      assignedStaffName: 'Not Applicable',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: '',
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_amara_sci_1',
      adminUid,
      studentId: 'stu_amara_osei',
      studentName: 'Amara Osei',
      subject: 'Science',
      title: 'Compare poetic form and imagery across texts',
      trackingRequired: false,
      assignedStaffEmail: 'none',
      assignedStaffName: 'Not Applicable',
      subjectStaffEmail: 'david.okafor@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: '',
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_amara_sci_2',
      adminUid,
      studentId: 'stu_amara_osei',
      studentName: 'Amara Osei',
      subject: 'Science',
      title: 'Explain enzyme reaction rates using collision theory',
      trackingRequired: true,
      assignedStaffEmail: 'david.okafor@oakridge.edu',
      assignedStaffName: 'David Okafor',
      subjectStaffEmail: 'david.okafor@oakridge.edu',
      currentWeekStatus: 'UNTRACKED' as const,
      currentWeekKey: weekKey,
      progressScore: 0,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:WT`,
      lastTrackedByEmail: 'none',
      deadlineDate: deadline,
      notes: '',
    },
    // Middle School: Toby Miller (Year 7)
    {
      id: 'tgt_toby_math_1',
      adminUid,
      studentId: 'stu_toby_miller',
      studentName: 'Toby Miller',
      subject: 'Mathematics',
      title: 'Organisation',
      trackingRequired: true,
      assignedStaffEmail: 'hannah.lin@oakridge.edu',
      assignedStaffName: 'Hannah Lin',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:PA`,
      lastTrackedByEmail: 'hannah.lin@oakridge.edu',
      deadlineDate: deadline,
      notes: 'Study folder and equipment consistently organized.',
    },
    {
      id: 'tgt_toby_math_2',
      adminUid,
      studentId: 'stu_toby_miller',
      studentName: 'Toby Miller',
      subject: 'Mathematics',
      title: 'Active Listening',
      trackingRequired: true,
      assignedStaffEmail: 'hannah.lin@oakridge.edu',
      assignedStaffName: 'Hannah Lin',
      subjectStaffEmail: 'hannah.lin@oakridge.edu',
      currentWeekStatus: 'M' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A`,
      lastTrackedByEmail: 'hannah.lin@oakridge.edu',
      deadlineDate: deadline,
      notes: 'Demonstrating complete mastery and leading group discussion.',
    },
    {
      id: 'tgt_toby_eng_1',
      adminUid,
      studentId: 'stu_toby_miller',
      studentName: 'Toby Miller',
      subject: 'English',
      title: 'Organisation',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'PA' as const,
      currentWeekKey: weekKey,
      progressScore: 70,
      weeklyHistorySummary: `${prevWeek2Key}:WT,${prevWeek1Key}:WT`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_toby_eng_2',
      adminUid,
      studentId: 'stu_toby_miller',
      studentName: 'Toby Miller',
      subject: 'English',
      title: 'Active Listening',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:PA`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    // Middle School: Zara Khan (Year 8)
    {
      id: 'tgt_zara_eng_1',
      adminUid,
      studentId: 'stu_zara_khan',
      studentName: 'Zara Khan',
      subject: 'English',
      title: 'Organisation',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'M' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:A,${prevWeek1Key}:M`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: 'Exceptional file organization and annotations.',
    },
    {
      id: 'tgt_zara_eng_2',
      adminUid,
      studentId: 'stu_zara_khan',
      studentName: 'Zara Khan',
      subject: 'English',
      title: 'Homework Submission',
      trackingRequired: true,
      assignedStaffEmail: 'clara.vance@oakridge.edu',
      assignedStaffName: 'Clara Vance',
      subjectStaffEmail: 'clara.vance@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A`,
      lastTrackedByEmail: 'clara.vance@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_zara_sci_1',
      adminUid,
      studentId: 'stu_zara_khan',
      studentName: 'Zara Khan',
      subject: 'Science',
      title: 'Organisation',
      trackingRequired: true,
      assignedStaffEmail: 'david.okafor@oakridge.edu',
      assignedStaffName: 'David Okafor',
      subjectStaffEmail: 'david.okafor@oakridge.edu',
      currentWeekStatus: 'A' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:PA,${prevWeek1Key}:A`,
      lastTrackedByEmail: 'david.okafor@oakridge.edu',
      deadlineDate: deadline,
      notes: '',
    },
    {
      id: 'tgt_zara_sci_2',
      adminUid,
      studentId: 'stu_zara_khan',
      studentName: 'Zara Khan',
      subject: 'Science',
      title: 'Homework Submission',
      trackingRequired: true,
      assignedStaffEmail: 'david.okafor@oakridge.edu',
      assignedStaffName: 'David Okafor',
      subjectStaffEmail: 'david.okafor@oakridge.edu',
      currentWeekStatus: 'M' as const,
      currentWeekKey: weekKey,
      progressScore: 100,
      weeklyHistorySummary: `${prevWeek2Key}:A,${prevWeek1Key}:M`,
      lastTrackedByEmail: 'david.okafor@oakridge.edu',
      deadlineDate: deadline,
      notes: 'Exceeding syllabus expectations with extended reading.',
    },
  ];

  for (const tgt of targetRecords) {
    const defaultTeacherMap: Record<string, string> = {
      Mathematics: 'Mrs. Gable',
      'Further Mathematics': 'Mr. Vance',
      English: 'Mr. Foster',
      Science: 'Dr. Aris',
    };
    const resolvedTeacher = defaultTeacherMap[tgt.subject] || 'Mr. Harrison';
    const path = `targets/${tgt.id}`;
    try {
      const existing = await getDoc(doc(db, 'targets', tgt.id));
      if (!existing.exists()) {
        await setDoc(doc(db, 'targets', tgt.id), {
          adminUid: tgt.adminUid,
          studentId: tgt.studentId,
          studentName: tgt.studentName,
          subject: tgt.subject,
          title: tgt.title,
          trackingRequired: tgt.trackingRequired,
          assignedStaffEmail: tgt.assignedStaffEmail,
          assignedStaffName: tgt.assignedStaffName,
          subjectStaffEmail: tgt.subjectStaffEmail,
          teacherName: resolvedTeacher,
          lsaName: tgt.assignedStaffName !== 'Not Applicable' ? tgt.assignedStaffName : 'Not Assigned',
          lsaEmail: tgt.subjectStaffEmail,
          currentWeekStatus: tgt.currentWeekStatus,
          currentWeekKey: tgt.currentWeekKey,
          progressScore: tgt.progressScore,
          weeklyHistorySummary: tgt.weeklyHistorySummary,
          lastTrackedByEmail: tgt.lastTrackedByEmail,
          deadlineDate: tgt.deadlineDate,
          notes: tgt.notes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  // 4. Seed Notifications for Staff (Assignment & Target Change Alerts with "View" button)
  const notificationRecords = [
    {
      id: 'notif_hannah_maya_assign',
      adminUid,
      recipientEmail: 'hannah.lin@oakridge.edu',
      recipientName: 'Hannah Lin',
      type: 'PENDING_ASSIGNMENT' as const,
      title: 'Student Assigned & Targets Updated: Maya Patel',
      message:
        'Maya Patel (Mathematics) was assigned to you with 3 applicable targets and 1 non-applicable target.',
      studentId: 'stu_maya_patel',
      studentName: 'Maya Patel',
      subject: 'Mathematics',
      dueDate: deadline,
      isRead: false,
    },
    {
      id: 'notif_clara_amara_assign',
      adminUid,
      recipientEmail: 'clara.vance@oakridge.edu',
      recipientName: 'Clara Vance',
      type: 'PENDING_ASSIGNMENT' as const,
      title: 'Student Assigned & Targets Updated: Amara Osei',
      message:
        'Amara Osei (English) has updated weekly targets ready for your tracking.',
      studentId: 'stu_amara_osei',
      studentName: 'Amara Osei',
      subject: 'English',
      dueDate: deadline,
      isRead: false,
    },
    {
      id: 'notif_david_maya_assign',
      adminUid,
      recipientEmail: 'david.okafor@oakridge.edu',
      recipientName: 'David Okafor',
      type: 'PENDING_ASSIGNMENT' as const,
      title: 'Student Assigned & Targets Updated: Maya Patel',
      message:
        'Maya Patel (Science) was assigned to your dashboard with updated subject target applicability.',
      studentId: 'stu_maya_patel',
      studentName: 'Maya Patel',
      subject: 'Science',
      dueDate: deadline,
      isRead: false,
    },
  ];

  for (const notif of notificationRecords) {
    const path = `notifications/${notif.id}`;
    try {
      const existing = await getDoc(doc(db, 'notifications', notif.id));
      if (!existing.exists()) {
        await setDoc(doc(db, 'notifications', notif.id), {
          adminUid: notif.adminUid,
          recipientEmail: notif.recipientEmail,
          recipientName: notif.recipientName,
          type: notif.type,
          title: notif.title,
          message: notif.message,
          studentId: notif.studentId,
          studentName: notif.studentName,
          subject: notif.subject,
          dueDate: notif.dueDate,
          isRead: notif.isRead,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}
