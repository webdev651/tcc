-- TCC Clinic relational schema (MySQL 8 / PostgreSQL compatible, 3NF).
-- The running app stores the same collections in backend/data/db.json (see db.js);
-- every collection below maps 1:1 to a table, so migrating is a mechanical change.

CREATE TABLE users (
  id            VARCHAR(20) PRIMARY KEY,
  role          VARCHAR(10)  NOT NULL CHECK (role IN ('student','staff','admin')),
  name          VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) UNIQUE,
  student_id    VARCHAR(12)  UNIQUE,                 -- students only, e.g. 2024-00123
  password_hash VARCHAR(100) NOT NULL,               -- bcrypt
  status        VARCHAR(10)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  photo         TEXT,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE students (                              -- clinic_staff details live on users (name, role)
  user_id           VARCHAR(20) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  course            VARCHAR(20),  year_level VARCHAR(12),  contact VARCHAR(20),
  birthdate         DATE,  gender VARCHAR(10),  blood_type VARCHAR(3),
  address           VARCHAR(200), emergency_contact VARCHAR(150)
);

CREATE TABLE health_records (                        -- one summary row per student
  user_id VARCHAR(20) PRIMARY KEY REFERENCES students(user_id) ON DELETE CASCADE,
  general TEXT, last_physical DATE, notes TEXT
);
CREATE TABLE medical_history (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  condition_name VARCHAR(120) NOT NULL, type VARCHAR(20) NOT NULL, date DATE, note VARCHAR(300)
);
CREATE TABLE allergies (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL, reaction VARCHAR(120) NOT NULL, severity VARCHAR(10) NOT NULL CHECK (severity IN ('Mild','Moderate','Severe'))
);
CREATE TABLE immunizations (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  vaccine VARCHAR(100) NOT NULL, date DATE NOT NULL, status VARCHAR(10) NOT NULL CHECK (status IN ('Completed','Ongoing','Due','Overdue'))
);
CREATE TABLE vital_signs (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  date DATE NOT NULL, bp VARCHAR(7) NOT NULL, heart_rate SMALLINT, temp NUMERIC(3,1), weight NUMERIC(5,1), height NUMERIC(4,1), recorded_by VARCHAR(80)
);
CREATE TABLE health_documents (                      -- file bytes are stored on disk, never in a public folder
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL, category VARCHAR(30) NOT NULL, date DATE NOT NULL,
  file VARCHAR(60), file_name VARCHAR(120), mime VARCHAR(40), size INT, uploaded_by VARCHAR(80)
);

CREATE TABLE consultations (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id),
  date DATE NOT NULL, complaint VARCHAR(200) NOT NULL, diagnosis VARCHAR(200), treatment VARCHAR(400), notes TEXT,
  staff_name VARCHAR(80) NOT NULL, status VARCHAR(10) NOT NULL CHECK (status IN ('ongoing','follow-up','completed'))
);
CREATE TABLE appointments (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id),
  date DATE NOT NULL, time CHAR(5) NOT NULL, purpose VARCHAR(80) NOT NULL, notes VARCHAR(300),
  status VARCHAR(10) NOT NULL CHECK (status IN ('pending','approved','completed','cancelled','rejected')),
  staff_name VARCHAR(80), remarks VARCHAR(200), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- "Upcoming" is derived (approved and date >= today). No double booking: one live booking per slot.
CREATE UNIQUE INDEX uq_live_slot ON appointments(date, time) WHERE status IN ('pending','approved');  -- PostgreSQL partial index

CREATE TABLE medicines (id VARCHAR(20) PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, form VARCHAR(30));
CREATE TABLE prescriptions (
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES students(user_id),
  consultation_id VARCHAR(20) REFERENCES consultations(id) ON DELETE SET NULL,
  date DATE NOT NULL, medicine VARCHAR(100) NOT NULL,  -- name copied from medicines so history survives catalogue edits
  dosage VARCHAR(80) NOT NULL, frequency VARCHAR(80) NOT NULL, duration VARCHAR(60) NOT NULL, instructions VARCHAR(400),
  staff_name VARCHAR(80) NOT NULL, status VARCHAR(10) NOT NULL CHECK (status IN ('active','completed','cancelled'))
);

CREATE TABLE health_alerts (                         -- user_id NULL = every student
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) REFERENCES students(user_id) ON DELETE CASCADE,
  type VARCHAR(12) NOT NULL, severity VARCHAR(10) NOT NULL, title VARCHAR(120) NOT NULL, message VARCHAR(500) NOT NULL,
  date DATE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE announcements (
  id VARCHAR(20) PRIMARY KEY, title VARCHAR(120) NOT NULL, body VARCHAR(800) NOT NULL, date DATE NOT NULL,
  category VARCHAR(30) NOT NULL, status VARCHAR(10) NOT NULL CHECK (status IN ('published','draft','archived'))
);
CREATE TABLE notifications (                         -- user_id 'staff' = shared staff inbox
  id VARCHAR(20) PRIMARY KEY, user_id VARCHAR(20) NOT NULL, title VARCHAR(120) NOT NULL, message VARCHAR(300),
  link VARCHAR(40), is_read BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE messages (id VARCHAR(20) PRIMARY KEY, name VARCHAR(80), email VARCHAR(120), subject VARCHAR(120), message TEXT, at TIMESTAMP);
CREATE TABLE activity_log (id VARCHAR(20) PRIMARY KEY, at TIMESTAMP NOT NULL, actor VARCHAR(80), action VARCHAR(80), detail VARCHAR(200));
CREATE TABLE sessions (jti VARCHAR(30) PRIMARY KEY, user_id VARCHAR(20) NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp BIGINT NOT NULL, last_seen BIGINT NOT NULL, remember BOOLEAN);
CREATE TABLE system_settings (key VARCHAR(40) PRIMARY KEY, value JSON NOT NULL);   -- clinic, permissions, notifications, security, general
-- "reports" are computed on demand from the tables above (GET /api/staff/reports), so no table is needed.

CREATE INDEX ix_cons_user ON consultations(user_id, date);
CREATE INDEX ix_appt_date ON appointments(date, status);
CREATE INDEX ix_rx_user ON prescriptions(user_id, status);
