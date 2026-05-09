import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// REQUIRED behind Railway/reverse proxies for secure cookies to work
// (otherwise login appears to succeed but authGuard will send you back to /login)
app.set('trust proxy', 1);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

let uri = process.env.MONGODB_URI;
const defaultDb = process.env.MONGO_DB;
if (!uri) {
  console.error('Missing MONGODB_URI env var');
} else if (defaultDb && !uri.includes(`/${defaultDb}`)) {
  const [base, qs] = uri.split('?', 2);
  uri = `${base.replace(/\/$/, '')}/${defaultDb}${qs ? `?${qs}` : ''}`;
  console.log('Using DB:', defaultDb);
}

const authEnabled = !!(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.SESSION_SECRET
);

if (authEnabled) {
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({ mongoUrl: uri }),
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      },
    })
  );

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          `http://localhost:${process.env.PORT || 8080}/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        const email = profile.emails?.[0]?.value;

        const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN;
        if (allowedDomain && email && !email.endsWith(`@${allowedDomain}`)) {
          return done(null, false, { message: 'Email domain not allowed' });
        }

        const user = {
          id: profile.id,
          displayName: profile.displayName,
          email,
          photo: profile.photos?.[0]?.value,
        };

        return done(null, user);
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));

  app.use(passport.initialize());
  // Standard session middleware (more widely used than authenticate('session'))
  app.use(passport.session());

  console.log('Google OAuth enabled; login required');
} else {
  console.log('Google OAuth not enabled (missing env vars). Webview remains public.');
}

function authGuard(req, res, next) {
  if (!authEnabled) return next();
  const p = req.path;
  if (p === '/login' || p.startsWith('/auth/') || p === '/logout') return next();
  if (req.user) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.send(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Login</title>
      <style>
        body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;background:#0b1220;color:#fff}
        .card{width:min(460px,92vw);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px}
        a.btn{display:block;margin-top:18px;padding:12px 14px;border-radius:12px;background:#fff;color:#000;text-decoration:none;font-weight:600;text-align:center}
        small{opacity:.85}
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 8px 0">Transcription Webview</h2>
        <div style="opacity:.9">Please sign in with Google to view transcripts.</div>
        <a class="btn" href="/auth/google">Sign in with Google</a>
        <small>Need help? Ask Karim to add your Google account.</small>
      </div>
    </body>
  </html>`);
});

app.get(
  '/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // Google sees callbackURL as absolute; we can redirect to app root.
    res.redirect('/');
  }
);

app.get('/logout', (req, res, next) => {
  const destroy = () => {
    if (!req.session) return res.redirect('/login');
    req.session.destroy(() => res.redirect('/login'));
  };

  // passport <0.7 uses req.logout(fn)
  if (typeof req.logout === 'function') {
    req.logout((err) => {
      if (err) return next(err);
      destroy();
    });
    return;
  }

  destroy();
});

app.get('/me', authGuard, (req, res) => {
  res.json({ user: req.user || null });
});

// Require login for everything after this point
app.use(authGuard);

mongoose.connection.on('connected', async () => {
  try {
    if (!mongoose.connection.db) return;
    const admin = mongoose.connection.db.admin();
    const dbs = await admin.listDatabases();
    console.log('Mongo databases:', dbs.databases.map((d) => d.name));

    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Mongo collections:', collections.map((c) => c.name));
  } catch (err) {
    console.error('Error listing Mongo metadata', err?.message);
  }
});

// --- Session model
const sessionCollectionName = process.env.MONGO_COLLECTION || 'conversations';
const Session = mongoose.model(
  'Session',
  new mongoose.Schema({}, { strict: false }),
  sessionCollectionName
);

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log('Connected to MongoDB'))
  .catch((e) => console.error('Mongo connection error', e.message));

function getSessionSearchFilter(q) {
  if (!q) return {};
  const re = new RegExp(q, 'i');
  return {
    $or: [
      { title: re },
      { userId: re },
      { userName: re },
      { email: re },
      { text: re },
      { transcript: re },
      { runningSummary: re },
      { aiSummary: re },
    ],
  };
}

app.get('/api/sessions', authGuard, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '200'), 10), 1000);

    const filter = getSessionSearchFilter(q);

    // Prefer most recent first
    const sessions = await Session.find(filter)
      .sort({ date: -1, startTime: -1, createdAt: -1, updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('Error in /api/sessions', err?.message);
    res.status(500).json({ error: 'Server error' });
  }
});

function normalizeTime(t) {
  if (typeof t === 'number') return t;
  // ISO timestamp with time-of-day, return epoch seconds
  if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) {
    return new Date(t).getTime() / 1000;
  }
  return null;
}

function normalizeChunk(raw, idx) {
  const chunk = { ...raw };
  chunk.idx = typeof raw.chunkIndex === 'number' ? raw.chunkIndex : idx;
  chunk.startTime = normalizeTime(raw.startTime);
  chunk.endTime = normalizeTime(raw.endTime);
  chunk.speaker = raw.speaker || raw.speakerId || null;
  chunk.text = raw.text || raw.transcript || raw.content || '';
  chunk.classification = raw.classification || null;
  return chunk;
}

function safeObjectId(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
}

app.get('/api/sessions/:id/chunks', authGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const chunkCollectionName = process.env.CHUNK_COLLECTION || 'transcriptchunks';

    // Try to get the session doc first because it may contain chunkIds
    const session = await Session.findById(id).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let chunkIds = session.chunkIds || session.chunks || session.transcriptChunks || [];

    // Ensure chunkIds is array
    if (!Array.isArray(chunkIds)) chunkIds = [chunkIds];

    // Convert strings to ObjectIds if possible
    const normalizedIds = chunkIds
      .map((cid) => (cid && cid.toHexString ? cid : cid))
      .map((cid) => safeObjectId(cid))
      .filter(Boolean);

    const chunkCollection = mongoose.connection.db.collection(chunkCollectionName);

    let chunkDocs = [];
    if (normalizedIds.length > 0) {
      chunkDocs = await chunkCollection.find({ _id: { $in: normalizedIds } }).toArray();
    } else {
      // fallback: find by conversation/session id
      const bySession = await chunkCollection
        .find({ conversationId: id })
        .sort({ startTime: 1, chunkIndex: 1, _id: 1 })
        .limit(800)
        .toArray();
      chunkDocs = bySession;
    }

    const chunks = chunkDocs.map((c, i) => normalizeChunk(c, i));
    chunks.sort((a, b) => {
      if (a.startTime != null && b.startTime != null) {
        if (a.startTime !== b.startTime) return a.startTime - b.startTime;
      }
      return (a.idx || 0) - (b.idx || 0);
    });

    res.json({
      meta: {
        chunkCollection: chunkCollectionName,
        count: chunks.length,
      },
      chunks,
    });
  } catch (err) {
    console.error('Error in /api/sessions/:id/chunks', err?.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/debug/collections', authGuard, async (_req, res) => {
  try {
    if (!mongoose.connection.db) return res.json({ collections: [] });
    const cols = await mongoose.connection.db.listCollections().toArray();

    const collections = await Promise.all(
      cols.map(async (c) => {
        const count = await mongoose.connection.db.collection(c.name).countDocuments();
        return { name: c.name, count };
      })
    );

    res.json({ collections });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Error listing collections' });
  }
});

app.get('/api/debug/sample', authGuard, async (req, res) => {
  try {
    const colName = String(req.query.col || sessionCollectionName);
    if (!mongoose.connection.db) return res.status(500).json({ error: 'No DB connection' });

    const doc = await mongoose.connection.db.collection(colName).findOne({}, { sort: { _id: -1 } });
    res.json({ collection: colName, sample: doc });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Error getting sample' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Transcription webview listening on port ${port}`);
});
