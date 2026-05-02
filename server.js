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
    const cols = await mongoose.connection.db.listCollections().toArray();
    console.log('Mongo collections:', cols.map((c) => c.name));
  } catch (e) {
    console.error('Failed to list collections', e.message);
  }
});

const sessionSchema = new mongoose.Schema({}, { strict: false });
const collectionName = process.env.MONGO_COLLECTION || 'sessions';
console.log('Using collection:', collectionName);
const Session = mongoose.model('Session', sessionSchema, collectionName);

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
        ],
      };
    }

    const sessions = await Session.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to fetch sessions',
      details: err.message,
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('Server running on port', port);
});
