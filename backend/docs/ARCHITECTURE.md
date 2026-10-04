# TCC Clinic — Architecture

## Stack
Node.js + Express REST API (`backend/`), vanilla HTML/CSS/JS front end (`frontend/`, no build step), MySQL for users/accounts (`docs/schema.mysql.sql`) and a JSON-file store with a relational layout for the clinic records (`docs/schema.sql`). Five npm packages: `express`, `bcryptjs`, `jsonwebtoken`, `mysql2`, `dotenv`.

## Folder structure
```
backend/
  server.js            app setup, security headers, route mounting, static files
  db.js                MySQL pool + account queries (users, students, sessions, reset tokens); db.json store for clinic records; demo seed
  scripts/             reset-db.js, migrate-json-to-mysql.js (one-time import), verify-mysql.js
  lib/util.js          validation + sanitising, sessions/JWT, RBAC (requireAuth, can), rate limiting, slot rules
  routes/auth.js       register, login, logout, profile, password, forgot/reset, notifications
  routes/student.js    student-only API (always scoped to the signed-in student)
  routes/staff.js      staff + admin API (students, records, consultations, appointments, Rx, alerts, reports, users, settings)
  routes/public.js     public clinic info, contact form, protected file download
  data/db.json         clinic records (no accounts)      data/uploads/  uploaded documents (not web-accessible)
frontend/
  index.html           landing page            login.html + app.js   login / register / forgot password
  dashboard.html + dashboard.js   student portal      admin.html + admin.js   staff & admin portal
  ui.js                shared toolkit: toasts, modals, validated forms, data tables, SVG charts, notifications
  api.js / icons.js / components.js   fetch wrapper + auth storage, icons, landing components
  styles.css / dashboard.css / portal.css
docs/  schema.sql (full portable schema)  schema.mysql.sql (account tables, applied at startup)  ARCHITECTURE.md
```

## Roles & permissions
| Capability | Student | Clinic Staff | Administrator |
|---|---|---|---|
| Own health record, consultations, prescriptions, alerts | view | – | – |
| Book / cancel / reschedule own appointments | ✔ | – | – |
| Student records, health records, documents | – | if *Manage student records* | ✔ |
| Consultations / Appointments / Prescriptions | – | if enabled in Settings | ✔ |
| Announcements & health alerts | read | if *Manage announcements* | ✔ |
| Reports & analytics | – | if *View reports* | ✔ |
| Delete records | – | if *Delete records* (on by default; admins can switch it off) | ✔ |
| User management, system settings | – | – | ✔ |

Staff switches live in **Settings → User Permissions** and are enforced on the server (`can(...)` middleware), not just hidden in the UI.

## Security measures
- bcrypt password hashing; password rules (min length configurable); temporary passwords for admin-created accounts.
- Server-side sessions: JWT carries a session id (`jti`) that is stored server-side, so **logout, disabling a user, password reset and role change all revoke access immediately**. Idle timeout (default 30 min, plus a matching client-side timer; background notification polling does not count as activity) and a max session length. "Remember me" sessions (30 days) have no idle timeout. Sessions are saved in MySQL and the JWT signing secret is stable across restarts (`JWT_SECRET`, or a generated `data/.jwt-secret`), so restarts do not sign people out.
- Login lockout after repeated failures, rate limits on registration, contact form, password change and booking.
- Role checks on every route; students can only read rows where `userId` equals their own — IDs in URLs never select another student's data. File downloads re-check ownership.
- Input validated per field with a whitelist spec (`validate()`); free text is stripped of HTML and control characters, and the UI escapes all output (`UI.esc`).
- Uploads: PDF/PNG/JPEG only, 2.5 MB cap, file *signature* checked (not just the extension), stored under a server-generated name outside the static folder, served only through an authenticated route with `no-store`.
- Security headers: CSP (scripts from self only), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`; API responses are `no-store`.
- Activity log of sensitive actions (visible on the admin dashboard and in reports).
- The login secret is generated automatically and stored in `data/.jwt-secret` (or taken from `JWT_SECRET` if the host sets it). Password-reset tokens are only ever shown to requests from the server's own machine, and the server warns at startup if default passwords are still in use.

## Appointment rules
Statuses: pending → approved → completed, or cancelled / rejected. "Upcoming" is shown for approved appointments dated today or later. A slot is "taken" while a pending or approved booking holds it, so double booking is refused by the server; a student may hold one live appointment per day. Clinic hours: Mon–Fri 8–12 and 1–5 PM, Sat morning, closed Sunday; 30-minute slots; booking window set in Settings. A student's reschedule goes back to *pending* for staff approval.

## API overview (all JSON, `Authorization: Bearer <token>`)
- `POST /api/auth/register | login | logout | forgot | reset`, `GET /api/auth/me`, `PUT /api/auth/profile`, `POST /api/auth/password`, `GET|POST /api/auth/notifications[/read]`
- `GET /api/student/dashboard`, `GET /api/student/slots?date=`, `POST /api/student/appointments[/:id/cancel|reschedule]`
- `GET /api/staff/dashboard | reports | activity | messages | team | settings`, `PUT /api/staff/settings`
- CRUD: `/api/staff/students` (+ `DELETE /:uid` removes a student and all linked data, `/:uid/record`, `/summary`, `/history|allergies|immunizations|vitals|documents`), `/consultations`, `/prescriptions`, `/announcements`, `/alerts`, `/users`; `POST /api/staff/appointments/:id/approve|reject|cancel|complete|reschedule`
- `GET /api/public/info`, `POST /api/public/contact`, `GET /api/public/files/:id`

## Database
**Accounts are in MySQL** (`users`, `students`, `sessions`, `password_reset_tokens`), configured with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` through a connection pool; every query is parameterised. Staff/admin requests start from a fresh read of the account tables, so nothing about accounts is cached between requests. `db.json` no longer holds any account data.

**Still in `db.json`:** health records, consultations, appointments, prescriptions, announcements, alerts, notifications, messages, the activity log and settings. Each of those collections is one table in `docs/schema.sql`, so moving them to MySQL later means replacing the `store.get()` access in `routes/staff.js` and `routes/student.js` with queries. Note that these records, and the activity log, refer to accounts by id (and the log by name), and deleting a student removes the account from MySQL and their records from `db.json` in two steps.
