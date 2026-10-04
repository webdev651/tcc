const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const store = require('./db');
const U = require('./lib/util');

const PORT = process.env.PORT || 3000;
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Allow the Netlify frontend to communicate with the Render backend
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  'https://tcc-clinic-system.netlify.app';

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === FRONTEND_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );

  if (U.IS_PROD) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains'
    );
  }

  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
});

app.use(express.json({ limit: '4mb' }));

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/student', require('./routes/student'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/public', require('./routes/public'));

app.use('/api', (req, res) => {
  U.fail(res, 404, 'Not found.');
});

// Error handling
const DB_DOWN = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
]);
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return U.fail(res, 413, 'That upload is too large.');
  }

  if (err.type === 'entity.parse.failed') {
    return U.fail(res, 400, 'Malformed request.');
  }

  console.error(err);

  // MySQL unreachable / dropped: say so instead of a generic 500 (the pool reconnects on its own).
  if (DB_DOWN.has(err.code) && req.path.startsWith('/api')) {
    return U.fail(res, 503, 'The database is temporarily unavailable. Please try again in a moment.');
  }

  if (req.path.startsWith('/api')) {
    return U.fail(res, 500, 'Something went wrong on the server.');
  }

  res.status(500).type('text').send('Something went wrong on the server.');
});

// Static site
app.use(
  express.static(path.join(__dirname, '..', 'frontend'), {
    setHeaders(res, file) {
      res.setHeader(
        'Cache-Control',
        /\.(png|svg|ico|jpg|jpeg|webp)$/i.test(file)
          ? 'public, max-age=86400'
          : 'no-cache'
      );
    },
  })
);

app.use((req, res) => {
  res.status(404).type('text').send('Page not found.');
});

process.on('unhandledRejection', (e) => {
  console.error('Unhandled rejection:', e);
});

process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
});

async function startupChecks() {
  fs.mkdirSync(require('./routes/public').UPLOADS, {
    recursive: true,
  });

  const warn = [];

  if (U.SECRET_SOURCE() === 'memory') {
    warn.push(
      'The login secret could not be saved, so everyone will be logged out on every restart. Make sure the data folder is writable.'
    );
  }

  const admin = await store.getUserById('u_admin1');

  if (
    admin &&
    bcrypt.compareSync('Admin1234', admin.passwordHash)
  ) {
    warn.push(
      'The administrator is still using the default password (Admin1234). Log in and change it now.'
    );
  }

  if (
    (await store.listUsers('staff')).some((u) =>
      bcrypt.compareSync('Staff1234', u.passwordHash)
    )
  ) {
    warn.push(
      'A staff account still uses the default password (Staff1234). Change it in User Management.'
    );
  }

  if (Object.keys(store._legacy()).length) {
    warn.push(
      'backend/data/db.json still contains old account data. It is NOT used any more. Run "npm run migrate-json" once to copy those accounts into MySQL and remove them from the file.'
    );
  }

  warn.forEach((w) => {
    console.warn('WARNING: ' + w);
  });
}

// Start server (accounts are in MySQL, so connect first and refuse to start if it is unreachable)
async function start() {
  try {
    await store.init();
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    const HOST_URL =
      process.env.RENDER_EXTERNAL_URL ||
      `http://localhost:${PORT}`;

    console.log(
      `TCC Clinic running at ${HOST_URL}${
        U.IS_PROD ? ' (production)' : ''
      }`
    );

    startupChecks().catch((e) => {
      console.error('Startup checks failed:', e.message);
    });
  });
}

start();
