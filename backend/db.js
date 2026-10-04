// Storage layer.
//  - Users / accounts (users, students profile, sessions, password-reset tokens) live in MySQL only.
//    See the "MySQL" section below and ../docs/schema.mysql.sql.
//  - Everything else (health records, appointments, announcements, settings, ...) is still kept in
//    data/db.json exactly as before. No account data is written to that file any more.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mysql = require('mysql2/promise');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const VERSION = 2;
let db;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return fmt(d);
};

const DEFAULT_SETTINGS = {
  clinic: {
    name: 'Talisay City College Clinic',
    systemName: 'TCC CLINIC — Student Health Record and Consultation Tracking System',
    address: 'Talisay City College, Talisay City, Cebu',
    email: 'tcclinic@tcc.edu.ph',
    phone: '(032) 494-1234',
    hours: [
      { days: 'Monday – Friday', time: '8:00 AM – 5:00 PM' },
      { days: 'Saturday', time: '8:00 AM – 12:00 PM' },
      { days: 'Sunday & Holidays', time: 'Closed' },
    ],
  },
  notifications: {
    appointmentUpdates: true,
    prescriptionIssued: true,
    newAnnouncements: true,
    followUpReminders: true
  },
  security: {
    sessionHours: 8,
    idleMinutes: 30,
    maxLoginAttempts: 5,
    minPasswordLength: 8
  },
  general: {
    maxAdvanceDays: 60,
    slotMinutes: 30,
    allowRegistration: true
  },
  permissions: {
    staff: {
      manageStudents: true,
      manageConsultations: true,
      manageAppointments: true,
      managePrescriptions: true,
      manageAnnouncements: true,
      viewReports: true,
      deleteRecords: true
    }
  },
};

// Account collections moved to MySQL.
// They are never read from, or written to, db.json.
const ACCOUNT_KEYS = ['users', 'students', 'sessions', 'resetTokens'];

const COLLECTIONS = [
  'healthRecords',
  'medicalHistory',
  'allergies',
  'immunizations',
  'vitalSigns',
  'documents',
  'consultations',
  'appointments',
  'prescriptions',
  'medicines',
  'alerts',
  'announcements',
  'notifications',
  'activity',
  'messages'
];

function emptyDb() {
  const d = {
    version: VERSION,
    nextId: 100,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  };

  COLLECTIONS.forEach((c) => (d[c] = []));

  return d;
}

// ---------- demo data ----------

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPLAINTS = [
  ['Headache and dizziness', 'Tension headache', 'Paracetamol 500mg', '1 tablet', 'every 6 hours as needed', '3 days'],
  ['Sore throat', 'Acute pharyngitis', 'Amoxicillin 500mg', '1 capsule', '3 times a day', '7 days'],
  ['Stomach pain', 'Hyperacidity', 'Antacid (Aluminum hydroxide)', '1 tablet', 'after meals', '5 days'],
  ['Fever and body aches', 'Viral infection', 'Paracetamol 500mg', '1 tablet', 'every 6 hours', '3 days'],
  ['Cough and colds', 'Upper respiratory infection', 'Cetirizine 10mg', '1 tablet', 'once daily at night', '5 days'],
  ['Menstrual cramps', 'Primary dysmenorrhea', 'Mefenamic acid 500mg', '1 capsule', 'every 8 hours as needed', '3 days'],
  ['Minor wound on knee', 'Abrasion', 'Povidone-iodine', 'Apply thin layer', 'twice daily', '5 days'],
  ['Allergic rash', 'Allergic dermatitis', 'Loratadine 10mg', '1 tablet', 'once daily', '5 days'],
  ['Diarrhea', 'Acute gastroenteritis', 'Oral rehydration salts', '1 sachet in 1L water', 'after each loose stool', '3 days'],
  ['Annual physical exam', 'Healthy', null],
];

const STAFF = [
  'Nurse Maria Santos',
  'Dr. Ramon Uy'
];

const MEDS = [
  ['Paracetamol 500mg', 'Tablet'],
  ['Amoxicillin 500mg', 'Capsule'],
  ['Antacid (Aluminum hydroxide)', 'Tablet'],
  ['Cetirizine 10mg', 'Tablet'],
  ['Loratadine 10mg', 'Tablet'],
  ['Mefenamic acid 500mg', 'Capsule'],
  ['Povidone-iodine', 'Solution'],
  ['Oral rehydration salts', 'Sachet'],
  ['Ibuprofen 200mg', 'Tablet'],
  ['Salbutamol inhaler', 'Inhaler']
];

const STUDENTS = [
  ['Ana Marie Reyes', '2023-00214', 'BSIT', '2nd Year', 'Female', 'A+'],
  ['Mark Anthony Villanueva', '2022-00387', 'BSED', '3rd Year', 'Male', 'B+'],
  ['Kristine Joy Ramos', '2024-00456', 'BSBA', '1st Year', 'Female', 'O+'],
  ['John Paul Lim', '2021-00102', 'BSCS', '4th Year', 'Male', 'AB+'],
  ['Maria Cecilia Tan', '2023-00561', 'BEED', '2nd Year', 'Female', 'O-'],
  ['Carlo Miguel Bautista', '2022-00298', 'BSIT', '3rd Year', 'Male', 'A-'],
  ['Jasmine Mae Flores', '2024-00619', 'BSHM', '1st Year', 'Female', 'B+'],
  ['Rafael Gabriel Cruz', '2021-00177', 'BSCrim', '4th Year', 'Male', 'O+'],
  ['Angelica Dizon', '2023-00733', 'BSED', '2nd Year', 'Female', 'A+'],
  ['Nathan Dave Ocampo', '2022-00845', 'BSBA', '3rd Year', 'Male', 'B-'],
  ['Bea Louise Navarro', '2024-00912', 'BSIT', '1st Year', 'Female', 'O+'],
];

function seed() {
  const d = emptyDb();
  const acct = { users: [], students: [] };
  const now = new Date().toISOString();
  const R = rng(20260401);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const id = (p) => `${p}${d.nextId++}`;
  const hash = (p) => bcrypt.hashSync(p, 10);

  acct.users.push(
    {
      id: 'u_admin1',
      role: 'admin',
      name: 'Clinic Administrator',
      studentId: '',
      email: 'admin@tcc.edu.ph',
      passwordHash: hash(process.env.ADMIN_PASSWORD || 'Admin1234'),
      status: 'active',
      photo: '',
      createdAt: now
    },
    {
      id: 'u_staff1',
      role: 'staff',
      name: 'Nurse Maria Santos',
      studentId: '',
      email: 'nurse@tcc.edu.ph',
      passwordHash: hash(process.env.STAFF_PASSWORD || 'Staff1234'),
      status: 'active',
      photo: '',
      createdAt: now
    },
    {
      id: 'u_staff2',
      role: 'staff',
      name: 'Dr. Ramon Uy',
      studentId: '',
      email: 'doctor@tcc.edu.ph',
      passwordHash: hash(process.env.STAFF_PASSWORD || 'Staff1234'),
      status: 'active',
      photo: '',
      createdAt: now
    }
  );

  MEDS.forEach(([name, form]) =>
    d.medicines.push({
      id: id('m'),
      name,
      form
    })
  );

  // Juan Dela Cruz — demo student
  const juan = 'u_student1';

  acct.users.push({
    id: juan,
    role: 'student',
    name: 'Juan Dela Cruz',
    studentId: '2024-00123',
    email: 'juan.delacruz@tcc.edu.ph',
    passwordHash: hash('Student123'),
    status: 'active',
    photo: '',
    createdAt: now
  });

  acct.students.push({
    userId: juan,
    course: 'BSIT',
    yearLevel: '3rd Year',
    contact: '0912-345-6789',
    birthdate: '2003-03-15',
    gender: 'Male',
    bloodType: 'O+',
    address: 'Talisay City, Cebu',
    emergencyContact: 'Elena Dela Cruz (Mother) — 0917-555-0101'
  });

  d.healthRecords.push({
    userId: juan,
    general: 'No chronic illnesses currently recorded. Childhood asthma, no attacks in the past 5 years.',
    lastPhysical: isoDay(-9),
    notes: 'Allergic to penicillin — avoid penicillin-class antibiotics. Hepatitis B series is incomplete.'
  });

  d.medicalHistory.push(
    {
      id: id('mh'),
      userId: juan,
      condition: 'Asthma (childhood)',
      type: 'Condition',
      date: '',
      note: 'No attacks in the past 5 years'
    },
    {
      id: id('mh'),
      userId: juan,
      condition: 'Appendectomy',
      type: 'Hospitalization',
      date: '2018-05-12',
      note: 'Admitted 3 days, no complications'
    }
  );

  d.allergies.push(
    {
      id: id('al'),
      userId: juan,
      name: 'Penicillin',
      reaction: 'Skin rash',
      severity: 'Moderate'
    },
    {
      id: id('al'),
      userId: juan,
      name: 'Peanuts',
      reaction: 'Mild swelling',
      severity: 'Mild'
    }
  );

  d.immunizations.push(
    {
      id: id('im'),
      userId: juan,
      vaccine: 'COVID-19 (booster)',
      date: '2023-02-10',
      status: 'Completed'
    },
    {
      id: id('im'),
      userId: juan,
      vaccine: 'Influenza',
      date: isoDay(-120),
      status: 'Completed'
    },
    {
      id: id('im'),
      userId: juan,
      vaccine: 'Hepatitis B (dose 2 of 3)',
      date: '2022-06-05',
      status: 'Ongoing'
    }
  );

  d.vitalSigns.push(
    {
      id: id('v'),
      userId: juan,
      date: isoDay(-9),
      bp: '120/80',
      heartRate: 78,
      temp: 36.7,
      weight: 62,
      height: 168,
      recordedBy: 'Dr. Ramon Uy'
    },
    {
      id: id('v'),
      userId: juan,
      date: isoDay(-200),
      bp: '118/76',
      heartRate: 74,
      temp: 36.5,
      weight: 61,
      height: 168,
      recordedBy: 'Nurse Maria Santos'
    }
  );

  d.documents.push(
    {
      id: id('d'),
      userId: juan,
      name: 'Physical exam result',
      category: 'Laboratory Result',
      date: isoDay(-200),
      file: null,
      fileName: '',
      mime: '',
      size: 0,
      uploadedBy: 'Nurse Maria Santos'
    },
    {
      id: id('d'),
      userId: juan,
      name: 'Chest X-ray',
      category: 'Laboratory Result',
      date: '2025-11-14',
      file: null,
      fileName: '',
      mime: '',
      size: 0,
      uploadedBy: 'Nurse Maria Santos'
    }
  );

  [[-60, 0], [-41, 1], [-25, 2], [-9, 9]].forEach(([off, ci]) => {
    const c = COMPLAINTS[ci];
    const cid = id('c');
    const staff = ci % 2 ? STAFF[1] : STAFF[0];

    d.consultations.push({
      id: cid,
      userId: juan,
      date: isoDay(off),
      complaint: c[0],
      diagnosis: c[1],
      treatment: c[2]
        ? `${c[2]}, rest and fluids`
        : 'No treatment needed',
      notes: 'Patient assessed by clinic staff. Vitals checked, advised rest and hydration, and to return if symptoms persist.',
      staffName: ci === 3 || ci === 9 ? STAFF[1] : staff,
      status: 'completed'
    });

    if (c[2]) {
      d.prescriptions.push({
        id: id('p'),
        userId: juan,
        consultationId: cid,
        date: isoDay(off),
        medicine: c[2],
        dosage: c[3],
        frequency: c[4],
        duration: c[5],
        instructions: 'Take with water. Stop and consult the clinic if rash or swelling appears.',
        staffName: staff,
        status: off > -30 ? 'active' : 'completed'
      });
    }
  });

  d.appointments.push(
    {
      id: id('a'),
      userId: juan,
      date: isoDay(3),
      time: '09:30',
      purpose: 'Follow-up check-up',
      notes: '',
      status: 'approved',
      staffName: 'Nurse Maria Santos',
      remarks: '',
      createdAt: now
    },
    {
      id: id('a'),
      userId: juan,
      date: isoDay(10),
      time: '14:00',
      purpose: 'Dental screening',
      notes: '',
      status: 'pending',
      staffName: '',
      remarks: '',
      createdAt: now
    },
    {
      id: id('a'),
      userId: juan,
      date: isoDay(-9),
      time: '10:00',
      purpose: 'Annual physical exam',
      notes: '',
      status: 'completed',
      staffName: 'Dr. Ramon Uy',
      remarks: '',
      createdAt: now
    },
    {
      id: id('a'),
      userId: juan,
      date: isoDay(-30),
      time: '13:30',
      purpose: 'Medical certificate',
      notes: '',
      status: 'cancelled',
      staffName: '',
      remarks: 'Cancelled by student',
      createdAt: now
    }
  );

  // other students
  const slotPool = [
    '08:00',
    '08:30',
    '09:00',
    '10:00',
    '10:30',
    '11:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00'
  ];

  STUDENTS.forEach(([name, sid, course, year, gender, blood], i) => {
    const uid = `u_s${i + 2}`;

    acct.users.push({
      id: uid,
      role: 'student',
      name,
      studentId: sid,
      email: `${name.split(' ')[0].toLowerCase()}.${name.split(' ').pop().toLowerCase()}@tcc.edu.ph`,
      passwordHash: hash('Student123'),
      status: i === 9 ? 'disabled' : 'active',
      photo: '',
      createdAt: now
    });

    acct.students.push({
      userId: uid,
      course,
      yearLevel: year,
      contact: `09${17 + (i % 3)}-${String(100 + i * 37).slice(0, 3)}-${String(1000 + i * 211).slice(0, 4)}`,
      birthdate: `${2000 + (i % 5)}-${pad(1 + (i * 5) % 12)}-${pad(1 + (i * 7) % 28)}`,
      gender,
      bloodType: blood,
      address: 'Talisay City, Cebu',
      emergencyContact: ''
    });

    d.healthRecords.push({
      userId: uid,
      general: 'No significant medical concerns on file.',
      lastPhysical: isoDay(-30 - i * 12),
      notes: ''
    });

    d.vitalSigns.push({
      id: id('v'),
      userId: uid,
      date: isoDay(-30 - i * 12),
      bp: `${108 + i * 2}/${70 + (i % 4) * 3}`,
      heartRate: 68 + i * 2,
      temp: 36.4 + (i % 4) / 10,
      weight: 48 + i * 3,
      height: 152 + i * 2,
      recordedBy: STAFF[i % 2]
    });

    d.immunizations.push(
      {
        id: id('im'),
        userId: uid,
        vaccine: 'COVID-19 (primary series)',
        date: '2022-01-15',
        status: 'Completed'
      },
      {
        id: id('im'),
        userId: uid,
        vaccine: 'Influenza',
        date: isoDay(-100 - i * 9),
        status: i % 3 === 0 ? 'Due' : 'Completed'
      }
    );

    if (i % 3 === 1) {
      d.allergies.push({
        id: id('al'),
        userId: uid,
        name: pick(['Shrimp', 'Dust mites', 'Aspirin', 'Pollen']),
        reaction: pick(['Hives', 'Sneezing', 'Itching']),
        severity: pick(['Mild', 'Moderate', 'Severe'])
      });
    }

    const n = 2 + Math.floor(R() * 5);

    for (let k = 0; k < n; k++) {
      const off = -Math.floor(R() * 330) - 3;
      const c = pick(COMPLAINTS);
      const st = pick(STAFF);
      const cid = id('c');

      d.consultations.push({
        id: cid,
        userId: uid,
        date: isoDay(off),
        complaint: c[0],
        diagnosis: c[1],
        treatment: c[2]
          ? `${c[2]}, rest and fluids`
          : 'No treatment needed',
        notes: '',
        staffName: st,
        status: 'completed'
      });

      if (c[2]) {
        d.prescriptions.push({
          id: id('p'),
          userId: uid,
          consultationId: cid,
          date: isoDay(off),
          medicine: c[2],
          dosage: c[3],
          frequency: c[4],
          duration: c[5],
          instructions: 'Take as directed.',
          staffName: st,
          status: off > -10
            ? 'active'
            : R() > 0.1
              ? 'completed'
              : 'cancelled'
        });
      }
    }

    const aStat = [
      'pending',
      'approved',
      'completed',
      'completed',
      'cancelled',
      'rejected'
    ];

    for (let k = 0; k < 2; k++) {
      const status = pick(aStat);
      const off =
        status === 'completed' || status === 'cancelled'
          ? -Math.floor(R() * 40) - 1
          : Math.floor(R() * 12) + 1;

      d.appointments.push({
        id: id('a'),
        userId: uid,
        date: isoDay(off),
        time: pick(slotPool),
        purpose: pick([
          'Medical check-up',
          'Follow-up check',
          'Consultation',
          'Medical certificate'
        ]),
        notes: '',
        status,
        staffName: status === 'pending' ? '' : pick(STAFF),
        remarks: status === 'rejected'
          ? 'Schedule not available'
          : '',
        createdAt: now
      });
    }
  });

  // prevent accidental double booking
  const seen = new Set();

  d.appointments = d.appointments.filter((a) => {
    if (!['pending', 'approved'].includes(a.status)) {
      return true;
    }

    const k = a.date + a.time;

    if (seen.has(k)) {
      return false;
    }

    seen.add(k);
    return true;
  });

  d.alerts.push(
    {
      id: id('h'),
      userId: juan,
      type: 'followup',
      title: 'Vaccination record incomplete',
      message: 'Please submit your Hepatitis B vaccination card to the clinic.',
      severity: 'warning',
      active: true,
      date: isoDay(-5)
    },
    {
      id: id('h'),
      userId: null,
      type: 'notice',
      title: 'Dengue advisory',
      message: 'Cases are rising in the area. Clear standing water and wear long sleeves in the afternoon.',
      severity: 'critical',
      active: true,
      date: isoDay(-2)
    },
    {
      id: id('h'),
      userId: null,
      type: 'health',
      title: 'Stay hydrated this week',
      message: 'Temperatures are high. Drink at least 8 glasses of water and take breaks in the shade.',
      severity: 'info',
      active: true,
      date: isoDay(-1)
    },
    {
      id: id('h'),
      userId: juan,
      type: 'appointment',
      title: 'Appointment reminder',
      message: 'You have a follow-up check-up in 3 days. Bring your school ID.',
      severity: 'info',
      active: true,
      date: isoDay(0)
    },
    {
      id: id('h'),
      userId: juan,
      type: 'prescription',
      title: 'Prescription reminder',
      message: 'Remember to finish your full course of medicine as prescribed.',
      severity: 'info',
      active: true,
      date: isoDay(-3)
    }
  );

  d.announcements.push(
    {
      id: id('n'),
      title: 'Free flu vaccination drive',
      body: 'The clinic is offering free flu shots to all enrolled students. Bring your school ID.',
      date: isoDay(-1),
      category: 'Vaccination Program',
      status: 'published'
    },
    {
      id: id('n'),
      title: 'Clinic hours during exam week',
      body: 'The clinic will stay open until 6:00 PM from Monday to Friday.',
      date: isoDay(-4),
      category: 'Clinic Schedule Update',
      status: 'published'
    },
    {
      id: id('n'),
      title: 'Mental health awareness talk',
      body: 'Join the guidance and clinic team for an open talk in the AVR this Friday at 2 PM.',
      date: isoDay(-8),
      category: 'Medical Campaign',
      status: 'published'
    },
    {
      id: id('n'),
      title: 'Clinic closed for city holiday',
      body: 'The clinic will be closed on the upcoming city holiday. For emergencies, call 911.',
      date: isoDay(5),
      category: 'Clinic Closure',
      status: 'draft'
    }
  );

  d.notifications.push({
    id: id('nt'),
    userId: juan,
    title: 'Appointment approved',
    message: 'Your follow-up check-up was approved.',
    link: '#appointments',
    read: false,
    createdAt: now
  });

  d.activity.push({
    id: id('ac'),
    at: now,
    actor: 'System',
    action: 'Database seeded',
    detail: 'Demo data created'
  });

  return { d, acct };
}

// A clean install: just the staff/admin logins and default settings.
function blank() {
  const { d, acct } = seed();
  const fresh = emptyDb();

  fresh.nextId = d.nextId;

  fresh.activity.push({
    id: `ac${fresh.nextId++}`,
    at: new Date().toISOString(),
    actor: 'System',
    action: 'Database created',
    detail: 'Blank database'
  });

  return {
    d: fresh,
    acct: {
      users: acct.users.filter((u) => u.role !== 'student'),
      students: []
    }
  };
}

const initial = () =>
  process.env.DEMO_DATA === '1'
    ? seed()
    : blank();

// ---------- persistence (db.json: non-account data only) ----------

let legacy = {};
let pendingAccounts = null;

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  const tmp = FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');

  try {
    fs.writeSync(
      fd,
      JSON.stringify(
        { ...db, ...legacy },
        null,
        2
      )
    );

    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, FILE);
}

function persist(undo) {
  try {
    save();
    return true;
  } catch (e) {
    console.error(
      'Could not write the database:',
      e.message
    );

    try {
      if (undo) undo();
    } catch {}

    return false;
  }
}

function load() {
  legacy = {};

  if (fs.existsSync(FILE)) {
    const raw = JSON.parse(
      fs.readFileSync(FILE, 'utf8')
    );

    if (raw.version === VERSION) {
      ACCOUNT_KEYS.forEach((k) => {
        if (Array.isArray(raw[k]) && raw[k].length) {
          legacy[k] = raw[k];
        }

        delete raw[k];
      });

      db = raw;

      COLLECTIONS.forEach(
        (c) => (db[c] = db[c] || [])
      );

      db.settings = {
        ...DEFAULT_SETTINGS,
        ...(db.settings || {})
      };
    } else {
      fs.copyFileSync(
        FILE,
        FILE.replace(
          /\.json$/,
          '.v1-backup.json'
        )
      );

      const i = initial();

      db = i.d;
      pendingAccounts = i.acct;

      save();
    }
  } else {
    const i = initial();

    db = i.d;
    pendingAccounts = i.acct;

    save();
  }

  return db;
}

const get = () => db || load();

const newId = (prefix) =>
  `${prefix}${get().nextId++}`;

const log = (
  actor,
  action,
  detail = ''
) => {
  const a = get().activity;

  a.unshift({
    id: newId('ac'),
    at: new Date().toISOString(),
    actor: actor || 'System',
    action,
    detail
  });

  if (a.length > 500) {
    a.length = 500;
  }
};

const notify = (
  userId,
  title,
  message,
  link = ''
) =>
  get().notifications.unshift({
    id: newId('nt'),
    userId,
    title,
    message,
    link,
    read: false,
    createdAt: new Date().toISOString()
  });


// ============================================================
// MYSQL / AIVEN
// ============================================================

const SCHEMA_FILE = path.join(
  __dirname,
  '..',
  'docs',
  'schema.mysql.sql'
);

// Aiven currently shows defaultdb.
// You can change DB_NAME in .env if you create another database.
const DB_NAME =
  process.env.DB_NAME || 'defaultdb';

let pool;

// Aiven MySQL configuration.
// SSL is REQUIRED by Aiven.
const dbConfig = () => ({
  host:
    process.env.DB_HOST ||
    'mysql-d60679-johnhaver08-2aa5.g.aivencloud.com',

  port:
    Number(process.env.DB_PORT) || 19740,

  user:
    process.env.DB_USER || 'avnadmin',

  password:
    process.env.DB_PASSWORD || '',

  ssl: {
    ca: fs.readFileSync(
      path.join(
        __dirname,
        'certs',
        'ca.pem'
      )
    ),

    rejectUnauthorized: true
  }
});

// Connect to Aiven MySQL.
async function init() {
  if (pool) {
    return pool;
  }

  // Load db.json for non-account data.
  get();

  const cfg = dbConfig();

  try {
    // Connect to Aiven first without selecting a database.
    const c = await mysql.createConnection(cfg);

    try {
      await c.query(
        'CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
        [DB_NAME]
      );
    } catch (e) {
      // Aiven may not allow CREATE DATABASE.
      // If the database already exists, continue.
      if (
        !/ACCESS_DENIED/.test(
          e.code || ''
        )
      ) {
        throw e;
      }
    } finally {
      await c.end();
    }
  } catch (e) {
    throw new Error(
      `Could not connect to Aiven MySQL at ${cfg.host}:${cfg.port} as "${cfg.user}" (${e.code || e.message}). Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and SSL certificate.`
    );
  }

  // Create connection pool.
  const p = mysql.createPool({
    ...cfg,

    database: DB_NAME,

    charset: 'utf8mb4',

    dateStrings: true,

    waitForConnections: true,

    connectionLimit:
      Number(process.env.DB_POOL_SIZE) || 10,

    queueLimit: 0,

    enableKeepAlive: true
  });

  try {
    // Verify connection.
    await p.query('SELECT 1');

    // Load MySQL schema.
    const ddl = fs
      .readFileSync(
        SCHEMA_FILE,
        'utf8'
      )
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);

    for (const stmt of ddl) {
      await p.query(stmt);
    }
  } catch (e) {
    await p.end().catch(() => {});

    throw new Error(
      `Aiven MySQL database "${DB_NAME}" is not usable: ${e.code || ''} ${e.message}`
    );
  }

  pool = p;

  // Check if users table has accounts.
  const [[{ n }]] =
    await pool.query(
      'SELECT COUNT(*) AS n FROM users'
    );

  // Insert default accounts if empty.
  if (Number(n) === 0) {
    await insertAccounts(
      pendingAccounts || blank().acct
    );
  }

  pendingAccounts = null;

  return pool;
}

const close = async () => {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
};

const q = () => {
  if (!pool) {
    throw new Error(
      'MySQL is not connected. Call store.init() first.'
    );
  }

  return pool;
};


// ============================================================
// USER / ACCOUNT FUNCTIONS
// ============================================================

const USER_COLS =
  'id, role, name, email, student_id, password_hash, status, photo, UNIX_TIMESTAMP(created_at) * 1000 AS created_ms';

const PROFILE_COLS =
  'user_id, course, year_level, contact, birthdate, gender, blood_type, address, emergency_contact';

const PROFILE_FIELDS = {
  course: 'course',
  yearLevel: 'year_level',
  contact: 'contact',
  birthdate: 'birthdate',
  gender: 'gender',
  bloodType: 'blood_type',
  address: 'address',
  emergencyContact: 'emergency_contact'
};

const USER_FIELDS = {
  name: 'name',
  email: 'email',
  studentId: 'student_id',
  role: 'role',
  status: 'status',
  passwordHash: 'password_hash',
  photo: 'photo'
};

// Convert MySQL row to API user object.
const toUser = (r) =>
  r && ({
    id: r.id,
    role: r.role,
    name: r.name,
    studentId: r.student_id || '',
    email: r.email || '',
    passwordHash: r.password_hash,
    status: r.status,
    photo: r.photo || '',
    createdAt:
      new Date(
        Number(r.created_ms)
      ).toISOString()
  });

const toProfile = (r) =>
  r && ({
    userId: r.user_id,
    course: r.course || '',
    yearLevel: r.year_level || '',
    contact: r.contact || '',
    birthdate: r.birthdate || '',
    gender: r.gender || '',
    bloodType: r.blood_type || '',
    address: r.address || '',
    emergencyContact:
      r.emergency_contact || ''
  });

const isDuplicate = (e) =>
  !!e &&
  e.code === 'ER_DUP_ENTRY';

const newUserId = () =>
  'u_' +
  crypto
    .randomBytes(6)
    .toString('hex');

async function getUserById(id) {
  const [rows] =
    await q().execute(
      `SELECT ${USER_COLS} FROM users WHERE id = ?`,
      [String(id || '')]
    );

  return (
    toUser(rows[0]) ||
    null
  );
}

// Login lookup.
async function findUser(identifier) {
  const id =
    String(identifier || '').trim();

  const [rows] =
    await q().execute(
      `SELECT ${USER_COLS} FROM users WHERE email = ? OR student_id = ? LIMIT 1`,
      [
        id.toLowerCase(),
        id
      ]
    );

  return (
    toUser(rows[0]) ||
    null
  );
}

// Check duplicate email/student ID.
async function findConflict(
  email,
  studentId,
  exceptId = ''
) {
  const [rows] =
    await q().execute(
      'SELECT id FROM users WHERE id <> ? AND (email = ? OR student_id = ?) LIMIT 1',
      [
        String(exceptId || ''),
        email || null,
        studentId || null
      ]
    );

  return rows.length > 0;
}

async function listUsers(role) {
  const [rows] = role
    ? await q().execute(
        `SELECT ${USER_COLS} FROM users WHERE role = ? ORDER BY created_at, id`,
        [role]
      )
    : await q().execute(
        `SELECT ${USER_COLS} FROM users ORDER BY created_at, id`
      );

  return rows.map(toUser);
}

async function getProfile(userId) {
  const [rows] =
    await q().execute(
      `SELECT ${PROFILE_COLS} FROM students WHERE user_id = ?`,
      [String(userId || '')]
    );

  return (
    toProfile(rows[0]) ||
    null
  );
}

async function accountSnapshot() {
  const [u] =
    await q().query(
      'SELECT id, role, name, email, student_id, status, UNIX_TIMESTAMP(created_at) * 1000 AS created_ms FROM users ORDER BY created_at, id'
    );

  const [s] =
    await q().query(
      `SELECT ${PROFILE_COLS} FROM students`
    );

  return {
    users: u.map((r) =>
      toUser({
        ...r,
        password_hash: '',
        photo: ''
      })
    ),
    students: s.map(toProfile)
  };
}

async function writeProfile(
  c,
  userId,
  p
) {
  const keys =
    Object.keys(p || {})
      .filter(
        (k) => PROFILE_FIELDS[k]
      );

  if (!keys.length) {
    await c.execute(
      'INSERT IGNORE INTO students (user_id) VALUES (?)',
      [userId]
    );

    return;
  }

  const cols = keys.map(
    (k) => PROFILE_FIELDS[k]
  );

  const vals = keys.map(
    (k) =>
      k === 'birthdate'
        ? p[k] || null
        : String(p[k] ?? '')
  );

  await c.execute(
    `INSERT INTO students (user_id, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)}) ON DUPLICATE KEY UPDATE ${cols.map((x) => `${x} = VALUES(${x})`).join(', ')}`,
    [userId, ...vals]
  );
}

async function tx(fn) {
  const c =
    await q().getConnection();

  try {
    await c.beginTransaction();

    const out =
      await fn(c);

    await c.commit();

    return out;
  } catch (e) {
    try {
      await c.rollback();
    } catch {}

    throw e;
  } finally {
    c.release();
  }
}

async function insertUser(c, u) {
  await c.execute(
    `INSERT INTO users (id, role, name, email, student_id, password_hash, status, photo${u.createdAt ? ', created_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${u.createdAt ? ', FROM_UNIXTIME(?)' : ''})`,
    [
      u.id,
      u.role,
      u.name,
      u.email || null,
      u.studentId || null,
      u.passwordHash,
      u.status || 'active',
      u.photo || null,
      ...(u.createdAt
        ? [
            Math.floor(
              new Date(
                u.createdAt
              ).getTime() /
                1000
            )
          ]
        : [])
    ]
  );
}

async function createUser(
  user,
  profile = null
) {
  await tx(async (c) => {
    await insertUser(
      c,
      user
    );

    if (profile) {
      await writeProfile(
        c,
        user.id,
        profile
      );
    }
  });

  return getUserById(
    user.id
  );
}

async function updateUser(
  id,
  fields = {},
  profile = null
) {
  const sets = [];
  const vals = [];

  for (
    const [k, v] of Object.entries(
      fields
    )
  ) {
    if (!USER_FIELDS[k]) {
      continue;
    }

    sets.push(
      `${USER_FIELDS[k]} = ?`
    );

    vals.push(
      k === 'email' ||
      k === 'studentId' ||
      k === 'photo'
        ? v || null
        : v
    );
  }

  await tx(async (c) => {
    if (sets.length) {
      await c.execute(
        `UPDATE users SET ${sets.join(', ')} WHERE id = ?`,
        [...vals, id]
      );
    }

    if (profile) {
      await writeProfile(
        c,
        id,
        profile
      );
    }
  });
}

async function deleteUser(id) {
  await q().execute(
    'DELETE FROM users WHERE id = ?',
    [id]
  );
}


// ============================================================
// SESSIONS
// ============================================================

const toSession = (r) =>
  r && ({
    jti: r.jti,
    userId: r.user_id,
    exp: Number(r.exp),
    lastSeen: Number(
      r.last_seen
    ),
    remember: !!r.remember
  });

async function createSession(s) {
  await q().execute(
    'INSERT INTO sessions (jti, user_id, exp, last_seen, remember) VALUES (?, ?, ?, ?, ?)',
    [
      s.jti,
      s.userId,
      s.exp,
      s.lastSeen,
      s.remember ? 1 : 0
    ]
  );
}

async function getSession(jti) {
  const [r] =
    await q().execute(
      'SELECT jti, user_id, exp, last_seen, remember FROM sessions WHERE jti = ?',
      [String(jti || '')]
    );

  return (
    toSession(r[0]) ||
    null
  );
}

async function touchSession(
  jti,
  lastSeen
) {
  await q().execute(
    'UPDATE sessions SET last_seen = ? WHERE jti = ?',
    [lastSeen, jti]
  );
}

async function deleteSession(jti) {
  await q().execute(
    'DELETE FROM sessions WHERE jti = ?',
    [jti]
  );
}

async function deleteUserSessions(
  userId,
  exceptJti = null
) {
  if (exceptJti) {
    await q().execute(
      'DELETE FROM sessions WHERE user_id = ? AND jti <> ?',
      [userId, exceptJti]
    );
  } else {
    await q().execute(
      'DELETE FROM sessions WHERE user_id = ?',
      [userId]
    );
  }
}

async function purgeExpiredSessions(
  now = Date.now()
) {
  await q().execute(
    'DELETE FROM sessions WHERE exp < ?',
    [now]
  );
}


// ============================================================
// PASSWORD RESET
// ============================================================

const hashToken = (t) =>
  crypto
    .createHash('sha256')
    .update(String(t))
    .digest('hex');

async function createResetToken(
  userId,
  token,
  expires
) {
  await tx(async (c) => {
    await c.execute(
      'DELETE FROM password_reset_tokens WHERE user_id = ? OR expires < ?',
      [userId, Date.now()]
    );

    await c.execute(
      'INSERT INTO password_reset_tokens (token_hash, user_id, expires) VALUES (?, ?, ?)',
      [
        hashToken(token),
        userId,
        expires
      ]
    );
  });
}

async function consumeResetToken(
  token
) {
  return tx(async (c) => {
    const [rows] =
      await c.execute(
        'SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires > ? FOR UPDATE',
        [
          hashToken(token),
          Date.now()
        ]
      );

    if (!rows.length) {
      return null;
    }

    await c.execute(
      'DELETE FROM password_reset_tokens WHERE token_hash = ?',
      [hashToken(token)]
    );

    return rows[0].user_id;
  });
}


// ============================================================
// DEFAULT ACCOUNTS
// ============================================================

async function insertAccounts(acct) {
  await tx(async (c) => {
    for (
      const u of acct.users
    ) {
      await insertUser(
        c,
        u
      );

      const p =
        acct.students.find(
          (x) =>
            x.userId === u.id
        );

      if (p) {
        const {
          userId,
          ...rest
        } = p;

        await writeProfile(
          c,
          u.id,
          rest
        );
      }
    }
  });
}


// ============================================================
// RESET DATABASE
// ============================================================

async function reset({
  demo = false
} = {}) {
  process.env.DEMO_DATA =
    demo ? '1' : '';

  for (
    const f of [
      FILE,
      FILE + '.tmp'
    ]
  ) {
    fs.rmSync(
      f,
      { force: true }
    );
  }

  db = undefined;

  load();

  const acct =
    pendingAccounts ||
    blank().acct;

  pendingAccounts = null;

  await init();

  await q().query(
    'DELETE FROM sessions'
  );

  await q().query(
    'DELETE FROM password_reset_tokens'
  );

  await q().query(
    'DELETE FROM students'
  );

  await q().query(
    'DELETE FROM users'
  );

  await insertAccounts(
    acct
  );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  get,
  save,
  persist,
  newId,
  isoDay,
  log,
  notify,
  DEFAULT_SETTINGS,
  FILE,

  // MySQL
  init,
  close,
  isDuplicate,
  newUserId,
  getUserById,
  findUser,
  findConflict,
  listUsers,
  getProfile,
  accountSnapshot,
  createUser,
  updateUser,
  deleteUser,
  createSession,
  getSession,
  touchSession,
  deleteSession,
  deleteUserSessions,
  purgeExpiredSessions,
  createResetToken,
  consumeResetToken,
  insertAccounts,
  reset,

  _pool: () => pool,
  _legacy: () => legacy,
};