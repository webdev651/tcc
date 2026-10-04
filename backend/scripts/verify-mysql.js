// End-to-end check that accounts live in MySQL only. Start the server first (npm start), then in another terminal:
//
//   npm run verify-mysql                      full check; the test accounts are deleted again at the end
//   npm run verify-mysql -- --keep            leave the test student in MySQL so you can restart the server...
//   npm run verify-mysql -- --check-persist   ...and then confirm that student can still log in afterwards (then deletes it)
//
// Env: BASE_URL (default http://localhost:3000), VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD (default admin@tcc.edu.ph / Admin1234).
const fs = require('fs');
const store = require('../db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = { identifier: process.env.VERIFY_ADMIN_EMAIL || 'admin@tcc.edu.ph', password: process.env.VERIFY_ADMIN_PASSWORD || 'Admin1234' };
const T = { name: 'Verify Student', studentId: '1999-00001', email: 'verify.student@tcc.edu.ph', password: 'Verify1234', contact: '0912-345-6789', course: 'BSIT', yearLevel: '1st Year' };
const STAFF_EMAIL = 'verify.staff@tcc.edu.ph';
const args = process.argv.slice(2);
let failures = 0;

const check = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra ? ' - ' + extra : ''}`); return ok; };
async function api(method, url, body, token) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const jsonText = () => (fs.existsSync(store.FILE) ? fs.readFileSync(store.FILE, 'utf8') : '');
async function removeIfExists(email) { const u = await store.findUser(email); if (u) await store.deleteUser(u.id); }

async function main() {
  await store.init();
  const login = (id, pw, role) => api('POST', '/api/auth/login', { identifier: id, password: pw, role });

  if (args.includes('--check-persist')) {
    const r = await login(T.email, T.password, 'student');
    check('7. After a restart the registered user is still in MySQL and can log in', r.status === 200 && !!(await store.findUser(T.email)), 'HTTP ' + r.status);
    await removeIfExists(T.email);
    return;
  }

  await removeIfExists(T.email); await removeIfExists(STAFF_EMAIL);
  const health = await api('GET', '/healthz');
  if (!check('server is reachable at ' + BASE, health.status === 200)) return;

  // 1-2, 10: registration goes to MySQL and nowhere in db.json
  const reg = await api('POST', '/api/auth/register', { ...T, confirmPassword: T.password, consent: true });
  check('registration succeeds (HTTP 201)', reg.status === 201, JSON.stringify(reg.json));
  const row = await store.findUser(T.email);
  check('1. New user is saved in MySQL', !!row && row.studentId === T.studentId && row.passwordHash.startsWith('$2'));
  const text = jsonText();
  check('2. New user is NOT in db.json', !text.includes(T.email) && !text.includes(T.studentId) && !(row && text.includes(row.id)));
  const parsed = text ? JSON.parse(text) : {};
  check('10. db.json holds no account data (no users/students/sessions/resetTokens)', !['users', 'students', 'sessions', 'resetTokens'].some((k) => k in parsed));

  // 3: login verifies against MySQL
  const bad = await login(T.email, 'WrongPass1', 'student');
  const good = await login(T.studentId, T.password, 'student');
  check('3. Login uses the MySQL account (wrong password refused, right password accepted, by Student ID)', bad.status === 401 && good.status === 200 && !!good.json.token, `${bad.status}/${good.status}`);
  const token = good.json && good.json.token;
  check('   session row is stored in MySQL', !!row && !!token && (await store.getSession(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).jti)) !== null);

  // 4: profile read from MySQL
  const me = await api('GET', '/api/auth/me', null, token);
  check('4. Profile is read from MySQL', me.status === 200 && me.json.user.email === T.email && me.json.user.profile && me.json.user.profile.course === 'BSIT' && me.json.user.profile.contact === T.contact);

  // 5: profile update persists in MySQL
  const upd = await api('PUT', '/api/auth/profile', { name: 'Verify Student Updated', email: T.email, contact: '0917-111-2222', course: 'BSCS', yearLevel: '2nd Year' }, token);
  const after = await store.getUserById(row.id); const prof = await store.getProfile(row.id);
  check('5. Profile update is saved to MySQL', upd.status === 200 && after.name === 'Verify Student Updated' && prof.contact === '0917-111-2222' && prof.course === 'BSCS' && prof.yearLevel === '2nd Year', 'HTTP ' + upd.status);

  // 6: admin user management reads/writes MySQL
  const adm = await login(ADMIN.identifier, ADMIN.password, 'staff');
  if (check('   admin login works (set VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD if you changed the default)', adm.status === 200, 'HTTP ' + adm.status)) {
    const at = adm.json.token;
    const list = await api('GET', '/api/staff/users', null, at);
    check('6a. Admin user list comes from MySQL', list.status === 200 && list.json.users.some((u) => u.id === row.id) && list.json.users.length === (await store.listUsers()).length);
    const made = await api('POST', '/api/staff/users', { name: 'Verify Staff', email: STAFF_EMAIL, role: 'staff' }, at);
    const staffRow = await store.findUser(STAFF_EMAIL);
    check('6b. Admin-created user is inserted into MySQL (and not db.json)', made.status === 201 && !!staffRow && !jsonText().includes(STAFF_EMAIL), 'HTTP ' + made.status);
    const dis = await api('POST', `/api/staff/users/${row.id}/status`, { status: 'disabled' }, at);
    check('6c. Disabling a user updates MySQL and blocks login', dis.status === 200 && (await store.getUserById(row.id)).status === 'disabled' && (await login(T.email, T.password, 'student')).status === 403);
    await api('POST', `/api/staff/users/${row.id}/status`, { status: 'active' }, at);
    check('6d. Re-activating updates MySQL', (await store.getUserById(row.id)).status === 'active' && (await login(T.email, T.password, 'student')).status === 200);

    // 9: existing routes still answer
    const routes = [['GET', '/api/public/info'], ['GET', '/api/staff/dashboard', at], ['GET', '/api/staff/students', at], ['GET', '/api/staff/consultations', at], ['GET', '/api/staff/appointments', at], ['GET', '/api/staff/reports', at], ['GET', '/api/staff/settings', at]];
    const st = [];
    for (const [m, u, t] of routes) st.push((await api(m, u, null, t)).status);
    const sdash = await api('GET', '/api/student/dashboard', null, (await login(T.email, T.password, 'student')).json.token);
    st.push(sdash.status);
    check('9. Existing API routes still respond (' + st.join(', ') + ')', st.every((x) => x === 200));

    if (staffRow) await store.deleteUser(staffRow.id);
    if (!args.includes('--keep')) await api('DELETE', `/api/staff/students/${row.id}`, null, at);
  }
  if (args.includes('--keep')) console.log('\nTest student kept. Restart the server, then run: npm run verify-mysql -- --check-persist');
  else { await removeIfExists(T.email); check('   test accounts cleaned up', !(await store.findUser(T.email)) && !(await store.findUser(STAFF_EMAIL))); console.log('\n7. (restart check) run with --keep, restart the server, then run with --check-persist.'); }
}

main().catch((e) => { console.error('ERROR: ' + e.message); failures++; }).finally(async () => { await store.close(); console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.'); process.exitCode = failures ? 1 : 0; });
