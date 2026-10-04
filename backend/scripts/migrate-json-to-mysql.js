// One-time migration: copy the accounts stored in an old db.json into MySQL, then remove them from the file.
//
//   npm run migrate-json                          (uses data/db.json)
//   npm run migrate-json -- path/to/other.json    (e.g. data/db.v1-backup.json)
//   npm run migrate-json -- --keep-json           (copy only; leave the JSON file untouched)
//
// Safe to run again: an account that already exists in MySQL (same id) is updated from the JSON copy, a new one is inserted.
// An account whose e-mail or Student ID is already used by a DIFFERENT MySQL account is skipped and reported,
// and in that case nothing is removed from the JSON file.
const fs = require('fs');
const path = require('path');
const store = require('../db');

const args = process.argv.slice(2);
const keepJson = args.includes('--keep-json');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || store.FILE);
const ACCOUNT_KEYS = ['users', 'students', 'sessions', 'resetTokens']; // sessions/reset tokens are not migrated (people simply log in again)

async function main() {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = Array.isArray(raw.users) ? raw.users : [];
  const students = Array.isArray(raw.students) ? raw.students : [];
  if (!users.length) { console.log('No accounts in ' + file + ' - nothing to migrate.'); return; }

  await store.init();
  let added = 0, updated = 0; const skipped = [];
  for (const u of users) {
    const label = `${u.name || '?'} <${u.email || u.studentId || u.id}>`;
    try {
      if (!u.id || !['student', 'staff', 'admin'].includes(u.role) || !u.name || !u.passwordHash) throw new Error('missing id, role, name or passwordHash');
      const user = { ...u, email: String(u.email || '').toLowerCase(), studentId: u.studentId || '', status: u.status === 'disabled' ? 'disabled' : 'active', photo: u.photo || '' };
      const p = students.find((x) => x.userId === u.id);
      const profile = u.role === 'student' ? (p ? (({ userId, ...rest }) => rest)(p) : {}) : null;
      if (await store.getUserById(u.id)) {
        if (await store.findConflict(user.email, user.studentId, u.id)) throw new Error('e-mail or Student ID already used by another MySQL account');
        await store.updateUser(u.id, { name: user.name, email: user.email, studentId: user.studentId, role: user.role, status: user.status, passwordHash: user.passwordHash, photo: user.photo }, profile);
        updated++;
      } else {
        await store.createUser(user, profile);
        added++;
      }
    } catch (e) { skipped.push(`${label}: ${store.isDuplicate(e) ? 'duplicate e-mail, Student ID or id' : e.message}`); }
  }
  console.log(`Migrated ${added} new and ${updated} existing account(s) into MySQL.`);
  if (skipped.length) { console.log(`Skipped ${skipped.length}:`); skipped.forEach((x) => console.log('  - ' + x)); }

  // Check MySQL really has every account before touching the file.
  const inDb = new Set((await store.listUsers()).map((u) => u.id));
  const missing = users.filter((u) => !inDb.has(u.id));
  if (missing.length || skipped.length) { console.log('The JSON file was NOT changed because not every account could be migrated. Fix the items above and run this again.'); process.exitCode = 1; return; }
  if (keepJson) { console.log('--keep-json: ' + file + ' left as it is (the app ignores the account data in it).'); return; }

  ACCOUNT_KEYS.forEach((k) => delete raw[k]);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2)); fs.renameSync(tmp, file);
  console.log('Removed the account data from ' + file + '. Accounts now live only in MySQL.');
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; }).finally(() => store.close());
