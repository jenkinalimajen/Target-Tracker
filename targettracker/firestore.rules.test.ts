/**
 * Security Rules Red-Team Test Suite (Dirty Dozen Verification)
 * Verifies all 12 adversarial payloads defined in security_spec.md return PERMISSION_DENIED.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  collection: string;
  operation: 'create' | 'update' | 'get' | 'list' | 'delete';
  auth: {
    uid: string;
    email: string;
    email_verified: boolean;
  } | null;
  docId: string;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
  blockingGate: string;
}

export const DIRTY_DOZEN_TEST_SUITE: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Student Create',
    collection: 'students',
    operation: 'create',
    auth: { uid: 'uid_attacker', email: 'attacker@school.edu', email_verified: true },
    docId: 'stu_1',
    payload: {
      adminUid: 'uid_victim_admin',
      name: 'Amelia Clarke',
      yearGroup: 'Year 10',
      studentCode: 'STU-101',
      subjects: ['Mathematics'],
      assignedStaffEmails: ['teacher@school.edu'],
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isValidStudent(incoming()) && incoming().adminUid == request.auth.uid',
  },
  {
    id: 2,
    name: 'Unverified Email Admin Spoof',
    collection: 'staff',
    operation: 'get',
    auth: { uid: 'uid_spoof', email: 'buxkillian@gmail.com', email_verified: false },
    docId: 'staff_1',
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isVerified() requires request.auth.token.email_verified == true',
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Target Update',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_staff_a', email: 'teacherA@school.edu', email_verified: true },
    docId: 'tgt_1',
    payload: {
      currentWeekStatus: 'A',
      isVerified: true, // Ghost field
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isValidTarget(incoming()) data.keys().hasOnly(...) && affectedKeys().hasOnly(...)',
  },
  {
    id: 4,
    name: 'Disabled Target Tracking Bypass',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_staff_a', email: 'teacherA@school.edu', email_verified: true },
    docId: 'tgt_disabled',
    payload: {
      currentWeekStatus: 'WT',
      progressScore: 35,
      lastTrackedByEmail: 'teacherA@school.edu',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'existing().trackingRequired == true',
  },
  {
    id: 5,
    name: 'Unassigned Staff Target Update',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_staff_b', email: 'teacherB@school.edu', email_verified: true },
    docId: 'tgt_assigned_to_a',
    payload: {
      currentWeekStatus: 'PA',
      progressScore: 70,
      lastTrackedByEmail: 'teacherB@school.edu',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'existing().assignedStaffEmail == request.auth.token.email',
  },
  {
    id: 6,
    name: 'Orphaned Target Creation',
    collection: 'targets',
    operation: 'create',
    auth: { uid: 'uid_admin', email: 'admin@school.edu', email_verified: true },
    docId: 'tgt_orphan',
    payload: {
      adminUid: 'uid_admin',
      studentId: 'non_existent_student_id',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'exists(/databases/$(database)/documents/students/$(incoming().studentId))',
  },
  {
    id: 7,
    name: 'ID Poisoning Attack',
    collection: 'students',
    operation: 'create',
    auth: { uid: 'uid_admin', email: 'admin@school.edu', email_verified: true },
    docId: 'invalid..id$$!!',
    payload: {},
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isValidId(studentId) regex ^[a-zA-Z0-9_\\-]+$',
  },
  {
    id: 8,
    name: 'Denial of Wallet / Oversized String in Notes',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_staff_a', email: 'teacherA@school.edu', email_verified: true },
    docId: 'tgt_1',
    payload: {
      notes: 'X'.repeat(5000),
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isValidTarget(incoming()) -> data.notes.size() <= 400',
  },
  {
    id: 9,
    name: 'Unbounded Array Overflow on Student',
    collection: 'students',
    operation: 'create',
    auth: { uid: 'uid_admin', email: 'admin@school.edu', email_verified: true },
    docId: 'stu_overflow',
    payload: {
      assignedStaffEmails: Array.from({ length: 25 }, (_, i) => `staff${i}@school.edu`),
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'isValidStudent(incoming()) -> data.assignedStaffEmails.size() <= 20',
  },
  {
    id: 10,
    name: 'Immortal Field Mutation on Target',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_admin', email: 'admin@school.edu', email_verified: true },
    docId: 'tgt_1',
    payload: {
      studentId: 'different_student_id',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'incoming().studentId == existing().studentId && incoming().createdAt == existing().createdAt',
  },
  {
    id: 11,
    name: 'Forged Client Timestamp',
    collection: 'targets',
    operation: 'update',
    auth: { uid: 'uid_staff_a', email: 'teacherA@school.edu', email_verified: true },
    docId: 'tgt_1',
    payload: {
      currentWeekStatus: 'A',
      updatedAt: '2099-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'incoming().updatedAt == request.time',
  },
  {
    id: 12,
    name: 'Cross-Staff PII Leakage on /staff',
    collection: 'staff',
    operation: 'get',
    auth: { uid: 'uid_staff_b', email: 'teacherB@school.edu', email_verified: true },
    docId: 'staff_teacher_a',
    expectedResult: 'PERMISSION_DENIED',
    blockingGate: 'existing().adminUid == request.auth.uid || existing().email == request.auth.token.email',
  },
];
