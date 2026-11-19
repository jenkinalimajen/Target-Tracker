# Security Specification (`security_spec.md`)

## 1. Data Invariants & Master Source of Truth

1. **Authentication & Verification Gate**: Every read and write operation across `/staff`, `/students`, `/targets`, and `/notifications` requires an authenticated user with a verified email (`request.auth != null && request.auth.token.email_verified == true`).
2. **Administrator Authority & Ownership**:
   - The bootstrapped administrator (`buxkillian@gmail.com` with `email_verified == true`, or a user in `/admins/$(request.auth.uid)`) or the creator administrator (`adminUid == request.auth.uid`) owns the institutional records they create.
   - During creation of any entity (`StaffMember`, `Student`, `Target`, `NotificationItem`), `incoming().adminUid` MUST equal `request.auth.uid`, and `createdAt` / `updatedAt` MUST equal `request.time`.
3. **Relational Parent Integrity (`Target -> Student`)**:
   - A `Target` document in `/targets/{targetId}` cannot be created unless `/students/$(incoming().studentId)` exists (`exists(...)`) and its `adminUid == request.auth.uid`.
4. **Tiered Identity Logic (`Target` Updates)**:
   - **Tier 1 (Administrator)**: Can update target configuration and status fields when `resource.data.adminUid == request.auth.uid`, preserving immutable fields (`adminUid`, `studentId`, `createdAt`).
   - **Tier 2 (Assigned Staff Tracker)**: Can ONLY update weekly tracking fields (`currentWeekStatus`, `currentWeekKey`, `progressScore`, `weeklyHistorySummary`, `lastTrackedByEmail`, `notes`, `updatedAt`) if AND ONLY IF:
     - `resource.data.assignedStaffEmail == request.auth.token.email`
     - `resource.data.trackingRequired == true` (targets marked not applicable / disabled for tracking cannot be tracked)
     - `incoming().lastTrackedByEmail == request.auth.token.email`
     - `incoming().updatedAt == request.time`
5. **PII Isolation & Query Enforcer (`allow list`)**:
   - `/staff/{staffId}` contains staff emails (PII). Reads (`get` and `list`) are strictly restricted to the owning administrator (`resource.data.adminUid == request.auth.uid`) or the specific staff member (`resource.data.email == request.auth.token.email`).
   - `/students/{studentId}` `get` and `list` are strictly restricted to `resource.data.adminUid == request.auth.uid` or staff members assigned to that student (`request.auth.token.email in resource.data.assignedStaffEmails`).
   - `/targets/{targetId}` `get` and `list` are strictly restricted to `resource.data.adminUid == request.auth.uid`, `resource.data.assignedStaffEmail == request.auth.token.email`, or `resource.data.subjectStaffEmail == request.auth.token.email`.
   - `/notifications/{notificationId}` `get` and `list` are strictly restricted to `resource.data.adminUid == request.auth.uid` or `resource.data.recipientEmail == request.auth.token.email`.
   - Zero `get()` or `exists()` calls appear inside any `allow list` rule to prevent O(n) cost explosions.

---

## 2. The "Dirty Dozen" Payloads

1. **Payload 1 (Identity Spoofing on Student Create)**: Authenticated user `uid_attacker` attempts to create `/students/stu_1` with `adminUid: "uid_victim_admin"`. -> `PERMISSION_DENIED`
2. **Payload 2 (Unverified Email Admin Spoof)**: User with `email: "buxkillian@gmail.com"` but `email_verified: false` attempts to read or write `/staff/staff_1`. -> `PERMISSION_DENIED`
3. **Payload 3 (Shadow Field Injection on Target Update)**: Assigned staff member updates `/targets/tgt_1` with valid `currentWeekStatus: "A"` plus ghost field `isVerified: true`. -> `PERMISSION_DENIED`
4. **Payload 4 (Disabled Target Tracking Bypass)**: Assigned staff member attempts to update `currentWeekStatus: "WT"` on `/targets/tgt_disabled` where `trackingRequired == false`. -> `PERMISSION_DENIED`
5. **Payload 5 (Unassigned Staff Target Update)**: Staff member `teacherB@school.edu` attempts to update `/targets/tgt_1` assigned to `teacherA@school.edu`. -> `PERMISSION_DENIED`
6. **Payload 6 (Orphaned Target Creation)**: Admin attempts to create `/targets/tgt_orphan` referencing a non-existent `studentId: "non_existent_student"`. -> `PERMISSION_DENIED`
7. **Payload 7 (ID Poisoning Attack)**: Admin attempts to create `/students/invalid..id$$` or an ID exceeding 128 chars. -> `PERMISSION_DENIED`
8. **Payload 8 (Denial of Wallet / Oversized String)**: Assigned staff attempts to update `notes` on `/targets/tgt_1` with a 5,000-character string (exceeding `maxLength: 400`). -> `PERMISSION_DENIED`
9. **Payload 9 (Unbounded Array Overflow on Student)**: Admin attempts to create `/students/stu_2` with `assignedStaffEmails` containing 25 elements (exceeding `size() <= 20`). -> `PERMISSION_DENIED`
10. **Payload 10 (Immortal Field Mutation)**: Admin attempts to update `/targets/tgt_1` and change `studentId` or `createdAt`. -> `PERMISSION_DENIED`
11. **Payload 11 (Forged Client Timestamp)**: Assigned staff attempts to update `/targets/tgt_1` with a past/future `updatedAt` instead of `request.time`. -> `PERMISSION_DENIED`
12. **Payload 12 (Cross-Staff PII Leakage)**: Staff member `teacherB@school.edu` attempts to `get` or `list` `/staff/staff_teacherA` belonging to `teacherA@school.edu`. -> `PERMISSION_DENIED`
