// npm run reset-db     -> blank clinic: wipes db.json AND deletes every MySQL account, then recreates the admin/staff logins
// npm run demo-data    -> same, but also loads the sample students and records (demo login 2024-00123 / Student123)
const store = require('../db');
const demo = process.argv.includes('--demo');

store.reset({ demo })
  .then(() => console.log(demo ? 'Demo data loaded (accounts are in MySQL).' : 'Database reset to blank (admin and staff logins only).'))
  .catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; })
  .finally(() => store.close());
