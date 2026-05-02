import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Missing MONGODB_URI env var');
}

mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }).catch((e) => {
  console.error('Mongo connection error', e.message);
});

const sessionSchema = new mongoose.Schema({}, { strict: false });
const Session = mongoose.model('Session', sessionSchema);

// API: list sessions (latest first)
app.get('/api/sessions', async (req, res) => {
  try {
    const { limit = 50, q } = req.query;
    let query = {};

    // If you have a sessionId field, you can search it.
    // If not, search "text" or "transcript" fields.
    if (q) {
      const regex = new RegExp(q, 'i');
      query = {
        $or: [
          { sessionId: regex },
          { text: regex },
          { transcript: regex },
          { message: regex },
        ],
      };
    }

    const sessions = await Session.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions', details: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 5001;
app.listen(port, () => {
  console.log('Server running on port', port);
});
