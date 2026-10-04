// Everything here is scoped to req.user — a student can only ever see their own data.
const express = require('express');
const store = require('../db');
const U = require('../lib/util');

const router = express.Router();
const { fail, ah } = U;
router.use(U.requireAuth(['student']));

const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '');
const mine = (list, uid) => list.filter((x) => x.userId === uid);
const withStatus = (a) => ({ ...a, effStatus: U.effStatus(a) });

router.get('/dashboard', ah(async (req, res) => {
  const db = store.get(); const uid = req.user.id; const today = store.isoDay(0);
  const profile = (await store.getProfile(uid)) || {}; // student profile comes from MySQL
  const appointments = mine(db.appointments, uid).sort(byDateDesc).map(withStatus);
  const upcoming = appointments.filter((a) => a.effStatus === 'upcoming').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const consultations = mine(db.consultations, uid).sort(byDateDesc);
  const prescriptions = mine(db.prescriptions, uid).sort(byDateDesc);
  const alerts = db.alerts.filter((a) => a.active && (a.userId === uid || a.userId === null)).sort(byDateDesc);
  const announcements = db.announcements.filter((a) => a.status === 'published').sort(byDateDesc);
  const record = {
    summary: db.healthRecords.find((r) => r.userId === uid) || { general: '', lastPhysical: '', notes: '' },
    history: mine(db.medicalHistory, uid), allergies: mine(db.allergies, uid), immunizations: mine(db.immunizations, uid),
    vitals: mine(db.vitalSigns, uid).sort(byDateDesc), documents: mine(db.documents, uid).sort(byDateDesc).map(({ file, ...d }) => ({ ...d, hasFile: !!file })),
  };
  res.json({
    student: { ...U.publicUser(req.user), ...profile, userId: undefined },
    stats: {
      totalConsultations: consultations.length, lastConsultation: consultations[0] ? consultations[0].date : null,
      upcomingAppointments: upcoming.length, nextAppointment: upcoming[0] ? { date: upcoming[0].date, time: upcoming[0].time } : null,
      prescriptions: prescriptions.filter((p) => p.status === 'active').length, totalPrescriptions: prescriptions.length, healthAlerts: alerts.length,
    },
    consultations, appointments, prescriptions, record, healthAlerts: alerts, announcements, today,
    clinic: db.settings.clinic,
  });
}));

router.get('/slots', (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Choose a valid date.');
  if (date < store.isoDay(0)) return res.json({ slots: [], note: 'That date has passed.' });
  const slots = U.slotStatus(date, req.query.except);
  res.json({ slots, note: slots.length ? '' : 'The clinic is closed on Sundays.' });
});

const apptSpec = {
  date: { label: 'Appointment date', required: true, date: true }, time: { label: 'Appointment time', required: true, time: true },
  purpose: { label: 'Purpose of visit', required: true, enum: ['Medical check-up', 'Follow-up check', 'Consultation', 'Medical certificate', 'Vaccination', 'Dental screening', 'Other'] },
  notes: { label: 'Notes', maxLen: 300 },
};

router.post('/appointments', U.limiter({ max: 30, windowMs: 3600e3, key: (r) => 'ap' + r.ip }), (req, res) => {
  const v = U.validate(req.body, apptSpec); if (v.error) return fail(res, 400, v.error);
  const { date, time, purpose, notes } = v.data; const db = store.get();
  const err = U.checkSlot(date, time); if (err) return fail(res, 409, err);
  if (db.appointments.some((a) => a.userId === req.user.id && a.date === date && U.ACTIVE.includes(a.status))) return fail(res, 409, 'You already have an appointment on that day.');
  const appt = { id: store.newId('a'), userId: req.user.id, date, time, purpose, notes, status: 'pending', staffName: '', remarks: '', createdAt: new Date().toISOString() };
  db.appointments.push(appt);
  store.notify('staff', 'New appointment request', `${req.user.name} requested ${purpose} on ${date} at ${time}.`, '#appointments');
  store.log(req.user.name, 'Booked appointment', `${date} ${time}`); store.save();
  res.status(201).json({ appointment: withStatus(appt) });
});

const ownOpen = (req) => store.get().appointments.find((x) => x.id === req.params.id && x.userId === req.user.id);
const canChange = (a) => a && U.ACTIVE.includes(a.status) && a.date >= store.isoDay(0);

router.post('/appointments/:id/cancel', (req, res) => {
  const a = ownOpen(req);
  if (!canChange(a)) return fail(res, 400, 'This appointment can no longer be cancelled.');
  a.status = 'cancelled'; a.remarks = 'Cancelled by student';
  store.notify('staff', 'Appointment cancelled', `${req.user.name} cancelled the ${a.date} ${a.time} appointment.`, '#appointments');
  store.log(req.user.name, 'Cancelled appointment', `${a.date} ${a.time}`); store.save();
  res.json({ appointment: withStatus(a) });
});

// Rescheduling sends the request back to staff for approval.
router.post('/appointments/:id/reschedule', (req, res) => {
  const a = ownOpen(req);
  if (!canChange(a)) return fail(res, 400, 'This appointment can no longer be rescheduled.');
  const v = U.validate(req.body, { date: apptSpec.date, time: apptSpec.time }); if (v.error) return fail(res, 400, v.error);
  const err = U.checkSlot(v.data.date, v.data.time, a.id); if (err) return fail(res, 409, err);
  if (store.get().appointments.some((x) => x.id !== a.id && x.userId === req.user.id && x.date === v.data.date && U.ACTIVE.includes(x.status))) return fail(res, 409, 'You already have an appointment on that day.');
  Object.assign(a, v.data, { status: 'pending', staffName: '', remarks: 'Rescheduled by student — awaiting approval' });
  store.notify('staff', 'Appointment rescheduled', `${req.user.name} moved an appointment to ${a.date} ${a.time}.`, '#appointments');
  store.log(req.user.name, 'Rescheduled appointment', `${a.date} ${a.time}`); store.save();
  res.json({ appointment: withStatus(a) });
});

// Students may delete their own appointments, except completed ones (those are part of the clinic's record).
router.delete('/appointments/:id', (req, res) => {
  const db = store.get(); const a = ownOpen(req);
  if (!a) return fail(res, 404, 'Appointment not found.');
  if (a.status === 'completed') return fail(res, 400, 'Completed appointments are part of your clinic record and cannot be deleted.');
  const wasLive = U.ACTIVE.includes(a.status);
  db.appointments = db.appointments.filter((x) => x !== a);
  if (wasLive) store.notify('staff', 'Appointment removed', `${req.user.name} deleted the ${a.date} ${a.time} appointment.`, '#appointments');
  store.log(req.user.name, 'Deleted appointment', `${a.date} ${a.time}`); store.save();
  res.json({ ok: true });
});

module.exports = router;
