import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
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

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log('Connected to MongoDB'))
  .catch((e) => {
    console.error('Mongo connection error', e.message);
  });

mongoose.connection.on('connected', async () => {
  try {
    const dbs = await mongoose.connection.db.admin().listDatabases();
    console.log('Mongo databases:', dbs.databases.map((d) => d.name));
  } catch (e) {
    console.error('Failed to list databases', e.message);
  }

  try {
    const cols = await mongoose.connection.db.listCollections().toArray();
    console.log('Mongo collections:', cols.map((c) => c.name));
  } catch (e) {
    console.error('Failed to list collections', e.message);
  }
});

const collectionName = process.env.MONGO_COLLECTION || 'sessions';
console.log('Using collection:', collectionName);

const chunkCollectionName = process.env.CHUNK_COLLECTION || 'transcriptchunks';

const sessionSchema = new mongoose.Schema({}, { strict: false });
const Session = mongoose.model('Session', sessionSchema, collectionName);

function toObjectId(id) {
  if (!id) return null;

  if (id instanceof mongoose.Types.ObjectId) return id;

  let s = id;
  if (typeof id === 'object') {
    if (id._id) s = id._id;
    if (id.$oid) s = id.$oid;
  }
  s = s.toString();

  return /^[0-9a-fA-F]{24}$/.test(s) ? new mongoose.Types.ObjectId(s) : null;
}

function normalizeTimestamp(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'number') return ts;
  return ts.toString();
}

// Debug: list collections with counts
app.get('/api/debug/collections', async (_req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const cols = await db.listCollections().toArray();

    const counts = await Promise.all(
      cols.map(async (c) => ({
        name: c.name,
        count: await db.collection(c.name).estimatedDocumentCount(),
      }))
    );

    res.json(counts);
  } catch (e) {
    console.error('Debug collections error', e);
    res.status(500).json({ error: e.message });
  }
});

// Debug: sample doc from collection
app.get('/api/debug/sample', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ error: 'DB not ready' });

    const col = req.query.col?.toString() || collectionName;
    const doc = await db.collection(col).findOne({});
    if (!doc) return res.status(404).json({ error: 'No document found' });
    res.json({ collection: col, sample: doc });
  } catch (e) {
    console.error('Debug sample error', e);
    res.status(500).json({ error: e.message });
  }
});

// API: list sessions (latest first)
app.get('/api/sessions', async (req, res) => {
  try {
    const { limit = 50, q } = req.query;
    let query = {};
    if (q) {
      const regex = new RegExp(q, 'i');
      query = {
        $or: [
          { sessionId: regex },
          { text: regex },
          { transcript: regex },
          { message: regex },
          { title: regex },
          { runningSummary: regex },
        ],
      };
    }

    const sessions = await Session.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to fetch sessions',
      details: err.message,
    });
  }
});

// API: get chunked transcript for a session
app.get('/api/sessions/:id/chunks', async (req, res) => {
  try {
    const session = await Session.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ error: 'DB not ready' });

    let chunks = [];

    const rawIds =
      session.chunkIds ||
      session.chunksIds ||
      session.chunkIDs ||
      session.chunkIDs ||
      session.chunks ||
      session.chunk_ids;

    if (Array.isArray(rawIds) && rawIds.length) {
      const ids = rawIds.map(toObjectId).filter(Boolean);
      if (ids.length) {
        chunks = await db
          .collection(chunkCollectionName)
          .find({ _id: { $in: ids } })
          .toArray();
      }
    } else if (Array.isArray(session.chunks)) {
      chunks = session.chunks;
    }

    const normalized = chunks
      .map((c, idx) => ({
        idx,
        chunkIndex: c.chunkIndex ?? c.idx ?? c.segmentIndex ?? idx,
        classification: c.classification ?? c.class ?? c.chunkType ?? c.type ?? null,
        text: c.text ?? c.message ?? c.transcript ?? c.content ?? '',
        startTime: normalizeTimestamp(
          c.startTime ??
            c.start ??
            c.tsStart ??
            c.begin ??
            c.timestamp ??
            c.ts ??
            c.createdAt ??
            c.time
        ),
        endTime: normalizeTimestamp(
          c.endTime ??
            c.end ??
            c.tsEnd ??
            c.finish ??
            c.completedAt ??
            c.endTime ??
            c.updatedAt
        ),
        speaker:
          c.speakerName ??
          c.speaker ??
          c.speaker_id ??
          c.speakerId ??
          c.speakerLabel ??
          c.role ??
          c.user ??
          c.userName ??
          c.name ??
          null,
      }))
      .sort((a, b) => {
        const at = new Date(a.startTime ?? 0).getTime() || 0;
        const bt = new Date(b.startTime ?? 0).getTime() || 0;
        if (at !== bt) return at - bt;
        return (a.chunkIndex ?? a.idx) - (b.chunkIndex ?? b.idx);
      });

    res.json({
      chunks: normalized,
      meta: {
        chunkCollection: chunkCollectionName,
        rawCount: chunks.length,
      },
    });
  } catch (err) {
    console.error('Chunk fetch error', err);
    res.status(500).json({ error: 'Failed to fetch chunks', details: err.message });
  }
});

// API: get single session by id
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const s = await Session.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
