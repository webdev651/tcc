// Clinic staff + administrator API. Staff are limited by the permission switches in Settings.
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const store = require('../db');
const U = require('../lib/util');
const { COURSES, YEARS } = require('./auth');
const { UPLOADS } = require('./public');
const { AsyncLocalStorage } = require('async_hooks');

const router = express.Router();
const { fail, validate, can, ah } = U;
router.use(U.requireAuth(['staff', 'admin']));

// Accounts live in MySQL. Each staff request starts by reading a fresh snapshot of users + student profiles
// from MySQL (nothing is cached between requests); the lookups below read that snapshot.
const accountsStore = new AsyncLocalStorage();
router.use(async (req, res, next) => {
  try { const snap = await store.accountSnapshot(); accountsStore.run(snap, next); } catch (e) { next(e); }
});
const accounts = () => accountsStore.getStore();

const db = () => store.get(); // db.json: clinic records only (no accounts)
const nameOf = (uid) => (accounts().users.find((u) => u.id === uid) || {}).name || 'Unknown';
const studentUser = (uid) => accounts().users.find((u) => u.id === uid && u.role === 'student');
const profile = (uid) => accounts().students.find((s) => s.userId === uid);
const BLANK_PROFILE = { course: '', yearLevel: '', contact: '', birthdate: '', gender: '', bloodType: '', address: '', emergencyContact: '' };
const profileFields = (s) => ({ course: s.course, yearLevel: s.yearLevel, contact: s.contact, birthdate: s.birthdate, gender: s.gender, bloodType: s.bloodType, address: s.address, emergencyContact: s.emergencyContact });
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '');
const mine = (list, uid) => list.filter((x) => x.userId === uid);
const done = (res, status, body, actor, action, detail) => { if (action) store.log(actor, action, detail); store.save(); res.status(status).json(body); };
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : fail(res, 403, 'Only an administrator can do this.'));
const month = (iso) => iso.slice(0, 7);

// ---------- dashboard ----------
function lastMonths(n) { const out = []; const d = new Date(); d.setDate(1); for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); } return out; }
const count = (list, keyFn) => list.reduce((m, x) => { const k = keyFn(x); m[k] = (m[k] || 0) + 1; return m; }, {});

router.get('/dashboard', (req, res) => {
  const d = db(); const today = store.isoDay(0); const months = lastMonths(6);
  const students = accounts().users.filter((u) => u.role === 'student');
  res.json({
    stats: {
      totalStudents: students.length, totalConsultations: d.consultations.length,
      todaysAppointments: d.appointments.filter((a) => a.date === today && ['approved', 'pending', 'completed'].includes(a.status)).length,
      pendingAppointments: d.appointments.filter((a) => a.status === 'pending').length,
      activePrescriptions: d.prescriptions.filter((p) => p.status === 'active').length, healthAlerts: d.alerts.filter((a) => a.active).length,
    },
    charts: {
      months, consultations: months.map((m) => d.consultations.filter((c) => month(c.date) === m).length),
      appointments: months.map((m) => d.appointments.filter((a) => month(a.date) === m).length),
      appointmentStatus: count(d.appointments.map((a) => ({ s: U.effStatus(a) })), (x) => x.s),
      allergySeverity: count(d.allergies, (a) => a.severity), immunization: count(d.immunizations, (i) => i.status),
      byCourse: count(accounts().students, (s) => s.course || 'Unspecified'),
    },
    todayList: d.appointments.filter((a) => a.date === today && ['approved', 'pending'].includes(a.status)).sort((a, b) => a.time.localeCompare(b.time)).map((a) => ({ ...a, student: nameOf(a.userId), effStatus: U.effStatus(a) })),
    activity: d.activity.slice(0, 8),
  });
});

router.get('/team', (req, res) => res.json({ team: accounts().users.filter((u) => u.role !== 'student' && u.status === 'active').map((u) => u.name), permissions: req.user.role === 'admin' ? 'all' : db().settings.permissions.staff }));
router.get('/activity', (req, res) => res.json({ activity: db().activity.slice(0, 100) }));
router.get('/messages', (req, res) => res.json({ messages: db().messages }));
router.delete('/messages/:id', can('deleteRecords'), (req, res) => { const d = db(); d.messages = d.messages.filter((m) => m.id !== req.params.id); done(res, 200, { ok: true }); });

// ---------- students ----------
const studentSpec = {
  name: { label: 'Full name', required: true, maxLen: 80 },
  studentId: { label: 'Student ID', required: true, pattern: /^\d{4}-\d{4,6}$/, msg: 'Student ID should look like 2024-00123.' },
  email: { label: 'Email', email: true, maxLen: 120 },
  contact: { label: 'Contact number', pattern: /^(\+?63|0)9\d{2}[- ]?\d{3}[- ]?\d{4}$/, msg: 'Enter a valid mobile number, e.g. 0912-345-6789.' },
  course: { label: 'Course', required: true, enum: COURSES }, yearLevel: { label: 'Year level', required: true, enum: YEARS },
  birthdate: { label: 'Birthdate', date: true }, gender: { label: 'Gender', enum: ['Male', 'Female', 'Other'] },
  bloodType: { label: 'Blood type', enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
  address: { label: 'Address', maxLen: 200 }, emergencyContact: { label: 'Emergency contact', maxLen: 150 },
};
const studentRow = (u, p = profile(u.id) || {}) => {
  const d = db();
  return { id: u.id, name: u.name, studentId: u.studentId, email: u.email, status: u.status, photo: u.photo, ...p, userId: undefined,
    consultations: mine(d.consultations, u.id).length, allergies: mine(d.allergies, u.id).length, lastVisit: (mine(d.consultations, u.id).sort(byDateDesc)[0] || {}).date || '' };
};
const dupe = (email, sid, exceptId) => store.findConflict(email && U.norm(email), sid, exceptId); // MySQL (async)
const DUP_STUDENT = 'A user with that Student ID or email already exists.';

router.get('/students', ah(async (req, res) => res.json({ students: (await store.listUsers('student')).map((u) => studentRow(u)), courses: COURSES, years: YEARS })));

router.post('/students', can('manageStudents'), ah(async (req, res) => {
  const v = validate(req.body, studentSpec); if (v.error) return fail(res, 400, v.error);
  const s = v.data; if (await dupe(s.email, s.studentId)) return fail(res, 409, DUP_STUDENT);
  const temp = U.tempPassword(); const user = { id: store.newUserId(), role: 'student', name: s.name, studentId: s.studentId, email: (s.email || '').toLowerCase(), passwordHash: bcrypt.hashSync(temp, 10), status: 'active', photo: '' };
  const p = profileFields(s);
  try { await store.createUser(user, p); }
  catch (e) {
    if (store.isDuplicate(e)) return fail(res, 409, DUP_STUDENT);
    console.error('Could not save the new student:', e.message); return fail(res, 503, 'The student could not be saved. Please try again.');
  }
  store.log(req.user.name, 'Added student', s.studentId); store.persist(); // activity log only (db.json)
  res.status(201).json({ student: studentRow(user, { ...BLANK_PROFILE, ...p }), tempPassword: temp });
}));

router.put('/students/:uid', can('manageStudents'), ah(async (req, res) => {
  const found = studentUser(req.params.uid); if (!found) return fail(res, 404, 'Student not found.');
  const v = validate(req.body, studentSpec); if (v.error) return fail(res, 400, v.error);
  const s = v.data; if (await dupe(s.email, s.studentId, found.id)) return fail(res, 409, 'Another user already has that Student ID or email.');
  const u = { ...(await store.getUserById(found.id)), name: s.name, studentId: s.studentId, email: s.email.toLowerCase() };
  const p = profileFields(s);
  try { await store.updateUser(u.id, { name: u.name, studentId: u.studentId, email: u.email }, p); }
  catch (e) { if (store.isDuplicate(e)) return fail(res, 409, 'Another user already has that Student ID or email.'); throw e; }
  done(res, 200, { student: studentRow(u, { ...BLANK_PROFILE, ...p }) }, req.user.name, 'Updated student', s.studentId);
}));

// Permanently delete a student and everything linked to them (needs the "Delete records" permission).
router.delete('/students/:uid', can('deleteRecords'), ah(async (req, res) => {
  const u = studentUser(req.params.uid); if (!u) return fail(res, 404, 'Student not found.');
  const d = db(); const uid = u.id;
  await store.deleteUser(uid); // MySQL: removes the account, student profile, sessions and reset tokens
  d.documents.filter((x) => x.userId === uid && x.file).forEach((x) => fs.rmSync(path.join(UPLOADS, path.basename(x.file)), { force: true }));
  ['healthRecords', 'medicalHistory', 'allergies', 'immunizations', 'vitalSigns', 'documents', 'consultations', 'appointments', 'prescriptions', 'alerts', 'notifications']
    .forEach((c) => { d[c] = d[c].filter((x) => x.userId !== uid); });
  done(res, 200, { ok: true }, req.user.name, 'Deleted student', `${u.name} (${u.studentId})`);
}));

router.get('/students/:uid/record', ah(async (req, res) => {
  if (!studentUser(req.params.uid)) return fail(res, 404, 'Student not found.');
  const u = await store.getUserById(req.params.uid); if (!u) return fail(res, 404, 'Student not found.');
  const d = db(); const uid = u.id;
  res.json({
    student: studentRow(u), summary: d.healthRecords.find((r) => r.userId === uid) || { general: '', lastPhysical: '', notes: '' },
    history: mine(d.medicalHistory, uid), allergies: mine(d.allergies, uid), immunizations: mine(d.immunizations, uid),
    vitals: mine(d.vitalSigns, uid).sort(byDateDesc), documents: mine(d.documents, uid).sort(byDateDesc).map(({ file, ...x }) => ({ ...x, hasFile: !!file })),
    consultations: mine(d.consultations, uid).sort(byDateDesc), prescriptions: mine(d.prescriptions, uid).sort(byDateDesc),
    appointments: mine(d.appointments, uid).sort(byDateDesc).map((a) => ({ ...a, effStatus: U.effStatus(a) })),
  });
}));

router.put('/students/:uid/summary', can('manageStudents'), (req, res) => {
  const u = studentUser(req.params.uid); if (!u) return fail(res, 404, 'Student not found.');
  const v = validate(req.body, { general: { label: 'General health summary', maxLen: 1000 }, lastPhysical: { label: 'Last physical examination', date: true }, notes: { label: 'Important health notes', maxLen: 1000 } });
  if (v.error) return fail(res, 400, v.error);
  let r = db().healthRecords.find((x) => x.userId === u.id); if (!r) { r = { userId: u.id }; db().healthRecords.push(r); }
  Object.assign(r, v.data);
  done(res, 200, { summary: r }, req.user.name, 'Updated medical summary', u.name);
});

// Sub-records of a health record: one table per kind, same four routes for each.
const KINDS = {
  history: { coll: 'medicalHistory', prefix: 'mh', label: 'medical history', spec: { condition: { label: 'Condition', required: true, maxLen: 120 }, type: { label: 'Type', required: true, enum: ['Illness', 'Condition', 'Hospitalization', 'Other'] }, date: { label: 'Date', date: true }, note: { label: 'Notes', maxLen: 300 } } },
  allergies: { coll: 'allergies', prefix: 'al', label: 'allergy', spec: { name: { label: 'Allergy name', required: true, maxLen: 80 }, reaction: { label: 'Reaction', required: true, maxLen: 120 }, severity: { label: 'Severity', required: true, enum: ['Mild', 'Moderate', 'Severe'] } } },
  immunizations: { coll: 'immunizations', prefix: 'im', label: 'immunization', spec: { vaccine: { label: 'Vaccine', required: true, maxLen: 100 }, date: { label: 'Date administered', required: true, date: true }, status: { label: 'Status', required: true, enum: ['Completed', 'Ongoing', 'Due', 'Overdue'] } } },
  vitals: { coll: 'vitalSigns', prefix: 'v', label: 'vital signs', spec: { date: { label: 'Date recorded', required: true, date: true }, bp: { label: 'Blood pressure', required: true, pattern: /^\d{2,3}\/\d{2,3}$/, msg: 'Blood pressure should look like 120/80.' }, heartRate: { label: 'Heart rate', required: true, num: true, min: 20, max: 250 }, temp: { label: 'Temperature', required: true, num: true, min: 30, max: 45 }, weight: { label: 'Weight (kg)', required: true, num: true, min: 2, max: 400 }, height: { label: 'Height (cm)', required: true, num: true, min: 30, max: 260 } } },
};
Object.entries(KINDS).forEach(([kind, K]) => {
  router.post(`/students/:uid/${kind}`, can('manageStudents'), (req, res) => {
    const u = studentUser(req.params.uid); if (!u) return fail(res, 404, 'Student not found.');
    const v = validate(req.body, K.spec); if (v.error) return fail(res, 400, v.error);
    const row = { id: store.newId(K.prefix), userId: u.id, ...v.data, ...(kind === 'vitals' ? { recordedBy: req.user.name } : {}) };
    db()[K.coll].push(row); done(res, 201, { item: row }, req.user.name, `Added ${K.label}`, u.name);
  });
  router.put(`/students/:uid/${kind}/:id`, can('manageStudents'), (req, res) => {
    const row = db()[K.coll].find((x) => x.id === req.params.id && x.userId === req.params.uid); if (!row) return fail(res, 404, 'Record not found.');
    const v = validate(req.body, K.spec); if (v.error) return fail(res, 400, v.error);
    Object.assign(row, v.data); done(res, 200, { item: row }, req.user.name, `Updated ${K.label}`, nameOf(row.userId));
  });
  router.delete(`/students/:uid/${kind}/:id`, can('deleteRecords'), (req, res) => {
    const d = db(); const row = d[K.coll].find((x) => x.id === req.params.id && x.userId === req.params.uid); if (!row) return fail(res, 404, 'Record not found.');
    d[K.coll] = d[K.coll].filter((x) => x !== row); done(res, 200, { ok: true }, req.user.name, `Deleted ${K.label}`, nameOf(row.userId));
  });
});

// Document upload: base64 in JSON, type-checked by file signature, stored outside the web root.
const SIGS = { 'application/pdf': (b) => b.slice(0, 4).toString() === '%PDF', 'image/png': (b) => b.slice(0, 4).toString('hex') === '89504e47', 'image/jpeg': (b) => b.slice(0, 2).toString('hex') === 'ffd8' };
router.post('/students/:uid/documents', can('manageStudents'), (req, res) => {
  const u = studentUser(req.params.uid); if (!u) return fail(res, 404, 'Student not found.');
  const v = validate(req.body, { name: { label: 'Document name', required: true, maxLen: 120 }, category: { label: 'Category', required: true, enum: ['Medical Certificate', 'Laboratory Result', 'Other'] }, date: { label: 'Date', required: true, date: true }, fileName: { label: 'File', required: true, maxLen: 120 }, mime: { label: 'File type', required: true, enum: Object.keys(SIGS) } });
  if (v.error) return fail(res, 400, v.error);
  const buf = Buffer.from(String(req.body.data || ''), 'base64');
  if (!buf.length) return fail(res, 400, 'Choose a file to upload.');
  if (buf.length > 2.5 * 1024 * 1024) return fail(res, 400, 'File is too large. The limit is 2.5 MB.');
  if (!SIGS[v.data.mime](buf)) return fail(res, 400, 'The file contents do not match its type. Upload a PDF, PNG or JPEG.');
  const id = store.newId('d'); const file = id + { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' }[v.data.mime];
  fs.mkdirSync(UPLOADS, { recursive: true }); fs.writeFileSync(path.join(UPLOADS, file), buf);
  const row = { id, userId: u.id, name: v.data.name, category: v.data.category, date: v.data.date, file, fileName: v.data.fileName, mime: v.data.mime, size: buf.length, uploadedBy: req.user.name };
  db().documents.push(row); store.notify(u.id, 'New health document', `${v.data.name} was added to your record.`, '#record');
  const { file: _f, ...pub } = row; done(res, 201, { item: { ...pub, hasFile: true } }, req.user.name, 'Uploaded document', u.name);
});
router.delete('/students/:uid/documents/:id', can('deleteRecords'), (req, res) => {
  const d = db(); const row = d.documents.find((x) => x.id === req.params.id && x.userId === req.params.uid); if (!row) return fail(res, 404, 'Document not found.');
  if (row.file) fs.rmSync(path.join(UPLOADS, path.basename(row.file)), { force: true });
  d.documents = d.documents.filter((x) => x !== row); done(res, 200, { ok: true }, req.user.name, 'Deleted document', nameOf(row.userId));
});

// ---------- consultations ----------
const consSpec = {
  userId: { label: 'Student', required: true }, date: { label: 'Date', required: true, date: true }, complaint: { label: 'Chief complaint', required: true, maxLen: 200 },
  diagnosis: { label: 'Diagnosis', maxLen: 200 }, treatment: { label: 'Treatment', maxLen: 400 }, notes: { label: 'Notes', maxLen: 1000 },
  staffName: { label: 'Doctor / staff', required: true, maxLen: 80 }, status: { label: 'Status', required: true, enum: ['ongoing', 'follow-up', 'completed'] },
};
const consRow = (c) => ({ ...c, student: nameOf(c.userId), studentId: (studentUser(c.userId) || {}).studentId || '' });
router.get('/consultations', (req, res) => res.json({ consultations: db().consultations.map(consRow).sort(byDateDesc) }));
router.post('/consultations', can('manageConsultations'), (req, res) => {
  const v = validate(req.body, consSpec); if (v.error) return fail(res, 400, v.error);
  if (!studentUser(v.data.userId)) return fail(res, 400, 'Choose a valid student.');
  const row = { id: store.newId('c'), ...v.data }; db().consultations.push(row);
  store.notify(row.userId, 'Consultation recorded', `A consultation on ${row.date} was added to your history.`, '#consultations');
  done(res, 201, { consultation: consRow(row) }, req.user.name, 'Added consultation', `${nameOf(row.userId)} — ${row.complaint}`);
});
router.put('/consultations/:id', can('manageConsultations'), (req, res) => {
  const row = db().consultations.find((c) => c.id === req.params.id); if (!row) return fail(res, 404, 'Consultation not found.');
  const v = validate(req.body, consSpec); if (v.error) return fail(res, 400, v.error);
  Object.assign(row, v.data); done(res, 200, { consultation: consRow(row) }, req.user.name, 'Updated consultation', `${nameOf(row.userId)} — ${row.complaint}`);
});
router.delete('/consultations/:id', can('deleteRecords'), (req, res) => {
  const d = db(); const row = d.consultations.find((c) => c.id === req.params.id); if (!row) return fail(res, 404, 'Consultation not found.');
  d.consultations = d.consultations.filter((c) => c !== row); done(res, 200, { ok: true }, req.user.name, 'Deleted consultation', nameOf(row.userId));
});

// ---------- appointments ----------
const apptRow = (a) => ({ ...a, student: nameOf(a.userId), studentId: (studentUser(a.userId) || {}).studentId || '', effStatus: U.effStatus(a) });
router.get('/appointments', (req, res) => res.json({ appointments: db().appointments.map(apptRow).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)) }));
router.get('/slots', (req, res) => { const date = String(req.query.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Choose a valid date.'); res.json({ slots: U.slotStatus(date, req.query.except) }); });
router.post('/appointments', can('manageAppointments'), (req, res) => {
  const v = validate(req.body, { userId: { label: 'Student', required: true }, date: { required: true, date: true, label: 'Date' }, time: { required: true, time: true, label: 'Time' }, purpose: { label: 'Purpose', required: true, maxLen: 80 }, notes: { label: 'Notes', maxLen: 300 } });
  if (v.error) return fail(res, 400, v.error); if (!studentUser(v.data.userId)) return fail(res, 400, 'Choose a valid student.');
  const err = U.checkSlot(v.data.date, v.data.time); if (err) return fail(res, 409, err);
  const row = { id: store.newId('a'), ...v.data, status: 'approved', staffName: req.user.name, remarks: 'Booked by clinic staff', createdAt: new Date().toISOString() };
  db().appointments.push(row); store.notify(row.userId, 'Appointment scheduled', `The clinic booked you on ${row.date} at ${row.time}.`, '#appointments');
  done(res, 201, { appointment: apptRow(row) }, req.user.name, 'Booked appointment', nameOf(row.userId));
});
const NEXT = { approve: { from: ['pending'], to: 'approved' }, reject: { from: ['pending'], to: 'rejected' }, cancel: { from: ['pending', 'approved'], to: 'cancelled' }, complete: { from: ['approved'], to: 'completed' }, reschedule: { from: ['pending', 'approved'], to: 'approved' } };
router.post('/appointments/:id/:action', can('manageAppointments'), (req, res) => {
  const a = db().appointments.find((x) => x.id === req.params.id); const rule = NEXT[req.params.action];
  if (!a || !rule) return fail(res, 404, 'Appointment not found.');
  if (!rule.from.includes(a.status)) return fail(res, 400, `A ${a.status} appointment cannot be ${req.params.action}d.`);
  const remarks = U.clean((req.body || {}).remarks, 200);
  if (req.params.action === 'reschedule') {
    const v = validate(req.body, { date: { required: true, date: true, label: 'Date' }, time: { required: true, time: true, label: 'Time' } }); if (v.error) return fail(res, 400, v.error);
    const err = U.checkSlot(v.data.date, v.data.time, a.id); if (err) return fail(res, 409, err);
    Object.assign(a, v.data);
  }
  if (req.params.action === 'reject' && !remarks) return fail(res, 400, 'Please give a short reason for rejecting.');
  a.status = rule.to; a.staffName = req.user.name; if (remarks) a.remarks = remarks; else if (req.params.action === 'reschedule') a.remarks = 'Rescheduled by clinic';
  const wording = { approve: 'approved', reject: 'rejected', cancel: 'cancelled', complete: 'marked as completed', reschedule: `moved to ${a.date} at ${a.time}` }[req.params.action];
  if (U.settings().notifications.appointmentUpdates) store.notify(a.userId, `Appointment ${req.params.action === 'reschedule' ? 'rescheduled' : wording}`, `Your ${a.purpose} appointment on ${a.date} was ${wording}.${a.status === 'rejected' && remarks ? ' Reason: ' + remarks : ''}`, '#appointments');
  done(res, 200, { appointment: apptRow(a) }, req.user.name, `Appointment ${wording}`, `${nameOf(a.userId)} ${a.date} ${a.time}`);
});

// ---------- prescriptions & medicines ----------
const rxSpec = {
  userId: { label: 'Student', required: true }, date: { label: 'Date', required: true, date: true }, medicine: { label: 'Medicine', required: true, maxLen: 100 },
  dosage: { label: 'Dosage', required: true, maxLen: 80 }, frequency: { label: 'Frequency', required: true, maxLen: 80 }, duration: { label: 'Duration', required: true, maxLen: 60 },
  instructions: { label: 'Instructions', maxLen: 400 }, staffName: { label: 'Doctor / staff', required: true, maxLen: 80 }, status: { label: 'Status', required: true, enum: ['active', 'completed', 'cancelled'] },
};
const rxRow = (p) => ({ ...p, student: nameOf(p.userId), studentId: (studentUser(p.userId) || {}).studentId || '' });
function learnMedicine(name) { const d = db(); if (!d.medicines.some((m) => U.norm(m.name) === U.norm(name))) d.medicines.push({ id: store.newId('m'), name, form: '' }); }
router.get('/prescriptions', (req, res) => res.json({ prescriptions: db().prescriptions.map(rxRow).sort(byDateDesc), medicines: db().medicines }));
router.post('/prescriptions', can('managePrescriptions'), (req, res) => {
  const v = validate(req.body, rxSpec); if (v.error) return fail(res, 400, v.error); if (!studentUser(v.data.userId)) return fail(res, 400, 'Choose a valid student.');
  const row = { id: store.newId('p'), ...v.data }; db().prescriptions.push(row); learnMedicine(row.medicine);
  if (U.settings().notifications.prescriptionIssued) store.notify(row.userId, 'New prescription', `${row.medicine} — ${row.dosage}, ${row.frequency}.`, '#prescriptions');
  done(res, 201, { prescription: rxRow(row) }, req.user.name, 'Created prescription', `${nameOf(row.userId)} — ${row.medicine}`);
});
router.put('/prescriptions/:id', can('managePrescriptions'), (req, res) => {
  const row = db().prescriptions.find((p) => p.id === req.params.id); if (!row) return fail(res, 404, 'Prescription not found.');
  const v = validate(req.body, rxSpec); if (v.error) return fail(res, 400, v.error);
  Object.assign(row, v.data); learnMedicine(row.medicine); done(res, 200, { prescription: rxRow(row) }, req.user.name, 'Updated prescription', `${nameOf(row.userId)} — ${row.medicine}`);
});
router.delete('/prescriptions/:id', can('deleteRecords'), (req, res) => {
  const d = db(); const row = d.prescriptions.find((p) => p.id === req.params.id); if (!row) return fail(res, 404, 'Prescription not found.');
  d.prescriptions = d.prescriptions.filter((p) => p !== row); done(res, 200, { ok: true }, req.user.name, 'Deleted prescription', nameOf(row.userId));
});

// ---------- announcements & health alerts ----------
const annSpec = { title: { label: 'Title', required: true, maxLen: 120 }, body: { label: 'Description', required: true, maxLen: 800 }, date: { label: 'Date', required: true, date: true },
  category: { label: 'Category', required: true, enum: ['Clinic Schedule Update', 'Vaccination Program', 'Health Reminder', 'Clinic Closure', 'Medical Campaign', 'General'] }, status: { label: 'Status', required: true, enum: ['published', 'draft', 'archived'] } };
const alertSpec = { title: { label: 'Title', required: true, maxLen: 120 }, message: { label: 'Message', required: true, maxLen: 500 }, date: { label: 'Date', required: true, date: true },
  type: { label: 'Type', required: true, enum: ['notice', 'followup', 'health', 'appointment', 'prescription'] }, severity: { label: 'Severity', required: true, enum: ['info', 'warning', 'critical'] }, userId: { label: 'Audience' }, active: { label: 'Active' } };
router.get('/announcements', (req, res) => res.json({ announcements: [...db().announcements].sort(byDateDesc) }));
router.post('/announcements', can('manageAnnouncements'), (req, res) => {
  const v = validate(req.body, annSpec); if (v.error) return fail(res, 400, v.error);
  const row = { id: store.newId('n'), ...v.data }; db().announcements.push(row);
  if (row.status === 'published' && U.settings().notifications.newAnnouncements) accounts().users.filter((u) => u.role === 'student' && u.status === 'active').forEach((u) => store.notify(u.id, 'New announcement', row.title, '#announcements'));
  done(res, 201, { announcement: row }, req.user.name, 'Posted announcement', row.title);
});
router.put('/announcements/:id', can('manageAnnouncements'), (req, res) => {
  const row = db().announcements.find((n) => n.id === req.params.id); if (!row) return fail(res, 404, 'Announcement not found.');
  const v = validate(req.body, annSpec); if (v.error) return fail(res, 400, v.error); Object.assign(row, v.data); done(res, 200, { announcement: row }, req.user.name, 'Edited announcement', row.title);
});
router.delete('/announcements/:id', can('manageAnnouncements'), (req, res) => {
  const d = db(); const row = d.announcements.find((n) => n.id === req.params.id); if (!row) return fail(res, 404, 'Announcement not found.');
  d.announcements = d.announcements.filter((n) => n !== row); done(res, 200, { ok: true }, req.user.name, 'Deleted announcement', row.title);
});
const alertRow = (a) => ({ ...a, audience: a.userId ? nameOf(a.userId) : 'All students' });
router.get('/alerts', (req, res) => res.json({ alerts: db().alerts.map(alertRow).sort(byDateDesc) }));
function alertBody(req) { const v = validate(req.body, alertSpec); if (v.error) return v; const d = v.data; d.userId = d.userId || null; if (d.userId && !studentUser(d.userId)) return { error: 'Choose a valid student.' }; d.active = d.active !== false && d.active !== 'false'; return v; }
router.post('/alerts', can('manageAnnouncements'), (req, res) => {
  const v = alertBody(req); if (v.error) return fail(res, 400, v.error);
  const row = { id: store.newId('h'), ...v.data }; db().alerts.push(row);
  if (row.userId) store.notify(row.userId, row.title, row.message, '#alerts');
  done(res, 201, { alert: alertRow(row) }, req.user.name, 'Issued health alert', row.title);
});
router.put('/alerts/:id', can('manageAnnouncements'), (req, res) => {
  const row = db().alerts.find((a) => a.id === req.params.id); if (!row) return fail(res, 404, 'Alert not found.');
  const v = alertBody(req); if (v.error) return fail(res, 400, v.error); Object.assign(row, v.data); done(res, 200, { alert: alertRow(row) }, req.user.name, 'Edited health alert', row.title);
});
router.delete('/alerts/:id', can('manageAnnouncements'), (req, res) => {
  const d = db(); const row = d.alerts.find((a) => a.id === req.params.id); if (!row) return fail(res, 404, 'Alert not found.');
  d.alerts = d.alerts.filter((a) => a !== row); done(res, 200, { ok: true }, req.user.name, 'Deleted health alert', row.title);
});

// ---------- reports ----------
router.get('/reports', can('viewReports'), (req, res) => {
  const d = db(); const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '0000-01-01'; const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : '9999-12-31';
  const inR = (x) => x.date >= from && x.date <= to;
  const cons = d.consultations.filter(inR), appts = d.appointments.filter(inR), rx = d.prescriptions.filter(inR);
  const top = (list, fn, n = 8) => Object.entries(count(list.filter((x) => fn(x)), fn)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }));
  const keys = (list) => [...new Set(list.map((x) => month(x.date)))].sort();
  const months = [...new Set([...keys(cons), ...keys(appts), ...keys(rx)])].sort();
  const years = [...new Set(d.consultations.concat(d.appointments, d.prescriptions).map((x) => x.date.slice(0, 4)))].sort();
  const stu = accounts().users.filter((u) => u.role === 'student');
  res.json({
    range: { from, to },
    students: { total: stu.length, active: stu.filter((u) => u.status === 'active').length, byCourse: top(accounts().students, (s) => s.course, 12), byYear: top(accounts().students, (s) => s.yearLevel, 6), byGender: top(accounts().students, (s) => s.gender, 4) },
    consultations: { total: cons.length, byStatus: top(cons, (c) => c.status), commonComplaints: top(cons, (c) => c.complaint), commonDiagnoses: top(cons, (c) => c.diagnosis), byStaff: top(cons, (c) => c.staffName) },
    appointments: { total: appts.length, byStatus: top(appts, (a) => a.status), byPurpose: top(appts, (a) => a.purpose) },
    prescriptions: { total: rx.length, byStatus: top(rx, (p) => p.status), topMedicines: top(rx, (p) => p.medicine) },
    monthly: months.map((m) => ({ month: m, consultations: cons.filter((c) => month(c.date) === m).length, appointments: appts.filter((a) => month(a.date) === m).length, prescriptions: rx.filter((p) => month(p.date) === m).length })),
    yearly: years.map((y) => ({ year: y, consultations: d.consultations.filter((c) => c.date.startsWith(y)).length, appointments: d.appointments.filter((a) => a.date.startsWith(y)).length, prescriptions: d.prescriptions.filter((p) => p.date.startsWith(y)).length })),
    clinicActivity: d.activity.filter((a) => a.at.slice(0, 10) >= from && a.at.slice(0, 10) <= to).slice(0, 15),
  });
});

// ---------- user management (administrators) ----------
const ROLES = ['student', 'staff', 'admin'];
const userRow = (u) => ({ id: u.id, name: u.name, email: u.email, studentId: u.studentId, role: u.role, status: u.status, createdAt: u.createdAt });
router.get('/users', adminOnly, (req, res) => res.json({ users: accounts().users.map(userRow) }));
const USER_SPEC = { name: { label: 'Full name', required: true, maxLen: 80 }, email: { label: 'Email', required: true, email: true }, role: { label: 'Role', required: true, enum: ROLES }, studentId: { label: 'Student ID', pattern: /^\d{4}-\d{4,6}$/, msg: 'Student ID should look like 2024-00123.' } };
router.post('/users', adminOnly, ah(async (req, res) => {
  const v = validate(req.body, USER_SPEC);
  if (v.error) return fail(res, 400, v.error); const s = v.data;
  if (s.role === 'student' && !s.studentId) return fail(res, 400, 'Student ID is required for student accounts.');
  const exists = 'A user with that email or Student ID already exists.';
  if (await dupe(s.email, s.studentId)) return fail(res, 409, exists);
  const temp = U.tempPassword(); let user = { id: store.newUserId(), role: s.role, name: s.name, studentId: s.role === 'student' ? s.studentId : '', email: s.email.toLowerCase(), passwordHash: bcrypt.hashSync(temp, 10), status: 'active', photo: '' };
  try { user = await store.createUser(user, s.role === 'student' ? {} : null); }
  catch (e) {
    if (store.isDuplicate(e)) return fail(res, 409, exists);
    console.error('Could not save the new user:', e.message); return fail(res, 503, 'The user could not be saved. Please try again.');
  }
  store.log(req.user.name, 'Added user', `${user.name} (${user.role})`); store.persist(); // activity log only (db.json)
  res.status(201).json({ user: userRow(user), tempPassword: temp });
}));
function targetUser(req, res) { const u = accounts().users.find((x) => x.id === req.params.id); if (!u) { fail(res, 404, 'User not found.'); return null; } return u; }
const lastAdmin = (u) => u.role === 'admin' && accounts().users.filter((x) => x.role === 'admin' && x.status === 'active').length <= 1;
router.put('/users/:id', adminOnly, ah(async (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const v = validate(req.body, USER_SPEC);
  if (v.error) return fail(res, 400, v.error); const s = v.data;
  if (s.role !== u.role && (u.id === req.user.id || lastAdmin(u))) return fail(res, 400, 'You cannot remove the last administrator role (or change your own role).');
  if (s.role === 'student' && !s.studentId) return fail(res, 400, 'Student ID is required for student accounts.');
  if (await dupe(s.email, s.role === 'student' ? s.studentId : '', u.id)) return fail(res, 409, 'Another user already has that email or Student ID.');
  const fields = { name: s.name, email: s.email.toLowerCase(), role: s.role, studentId: s.role === 'student' ? s.studentId : '' };
  try { await store.updateUser(u.id, fields, s.role === 'student' && !profile(u.id) ? {} : null); } // a student always has a profile row
  catch (e) { if (store.isDuplicate(e)) return fail(res, 409, 'Another user already has that email or Student ID.'); throw e; }
  if (u.id !== req.user.id) await store.deleteUserSessions(u.id); // role change signs them out
  const updated = { ...u, ...fields };
  done(res, 200, { user: userRow(updated) }, req.user.name, 'Edited user', `${updated.name} (${updated.role})`);
}));
router.post('/users/:id/status', adminOnly, ah(async (req, res) => {
  const u = targetUser(req, res); if (!u) return; const status = (req.body || {}).status;
  if (!['active', 'disabled'].includes(status)) return fail(res, 400, 'Invalid status.');
  if (status === 'disabled' && (u.id === req.user.id || lastAdmin(u))) return fail(res, 400, 'You cannot disable your own account or the last administrator.');
  await store.updateUser(u.id, { status });
  if (status === 'disabled') await store.deleteUserSessions(u.id);
  done(res, 200, { user: userRow({ ...u, status }) }, req.user.name, status === 'disabled' ? 'Disabled user' : 'Activated user', u.name);
}));
router.post('/users/:id/reset-password', adminOnly, ah(async (req, res) => {
  const u = targetUser(req, res); if (!u) return; const temp = U.tempPassword();
  await store.updateUser(u.id, { passwordHash: bcrypt.hashSync(temp, 10) });
  await store.deleteUserSessions(u.id);
  done(res, 200, { tempPassword: temp }, req.user.name, 'Reset password', u.name);
}));

// ---------- settings ----------
router.get('/settings', (req, res) => res.json({ settings: db().settings }));
router.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {}; const s = db().settings;
  if (b.clinic) {
    const v = validate(b.clinic, { name: { label: 'Clinic name', required: true, maxLen: 100 }, systemName: { label: 'System name', required: true, maxLen: 150 }, address: { label: 'Address', required: true, maxLen: 200 }, email: { label: 'Email', required: true, email: true }, phone: { label: 'Phone', required: true, maxLen: 40 } });
    if (v.error) return fail(res, 400, v.error);
    const hours = Array.isArray(b.clinic.hours) ? b.clinic.hours.slice(0, 6).map((h) => ({ days: U.clean(h.days, 40), time: U.clean(h.time, 40) })).filter((h) => h.days && h.time) : s.clinic.hours;
    s.clinic = { ...v.data, hours };
  }
  if (b.notifications) for (const k of Object.keys(s.notifications)) if (k in b.notifications) s.notifications[k] = !!b.notifications[k];
  if (b.security) {
    const v = validate(b.security, { sessionHours: { label: 'Session length', required: true, num: true, min: 1, max: 24 }, idleMinutes: { label: 'Idle timeout', required: true, num: true, min: 5, max: 240 }, maxLoginAttempts: { label: 'Login attempts', required: true, num: true, min: 3, max: 10 }, minPasswordLength: { label: 'Minimum password length', required: true, num: true, min: 8, max: 32 } });
    if (v.error) return fail(res, 400, v.error); s.security = v.data;
  }
  if (b.general) {
    const v = validate(b.general, { maxAdvanceDays: { label: 'Booking window', required: true, num: true, min: 7, max: 180 }, allowRegistration: { label: 'Registration' } });
    if (v.error) return fail(res, 400, v.error); s.general = { ...s.general, maxAdvanceDays: v.data.maxAdvanceDays, allowRegistration: !!v.data.allowRegistration };
  }
  if (b.permissions && b.permissions.staff) for (const k of Object.keys(s.permissions.staff)) if (k in b.permissions.staff) s.permissions.staff[k] = !!b.permissions.staff[k];
  done(res, 200, { settings: s }, req.user.name, 'Updated settings');
});

module.exports = router;
