/**
 * Stroke CRM — Render Express Backend
 * 
 * A persistent Express server that replaces the Vercel serverless setup.
 * Serves the frontend static files and all API routes.
 * 
 * On Render free tier, Apps Script pings /api/cron/process every minute
 * to keep the server awake AND trigger queue processing.
 */

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { processEmailQueue } = require('./cron/process');
const { runCleanup } = require('./cron/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
const cors = require('cors');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ──
const authRoutes = require('./routes/auth');
const campaignRoutes = require('./routes/campaigns');
const userRoutes = require('./routes/users');

app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/users', userRoutes);

// ── Cron: Process email queue (GET endpoint for Apps Script to ping) ──
app.get('/api/cron/process', async (req, res) => {
  // Optional: Verify auth token
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const result = await processEmailQueue();
    global.lastCronRun = {
      timestamp: new Date().toISOString(),
      status: 'success',
      result
    };
    res.status(200).json(result);
  } catch (err) {
    console.error('Cron process error:', err);
    global.lastCronRun = {
      timestamp: new Date().toISOString(),
      status: 'error',
      error: err.message
    };
    res.status(500).send('Cron processing failed');
  }
});

// ── Cron: Cleanup old records ──
app.get('/api/cron/cleanup', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const result = await runCleanup();
    res.status(200).json(result);
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).send('Cleanup processing failed');
  }
});

// ── Serve frontend static files from the project root ──
// The frontend files (index.html, script.js, style.css, config.js) live in the parent directory
const frontendDir = path.join(__dirname, '..');
app.use(express.static(frontendDir, {
  // Don't serve the api/ or render-server/ directories as static files
  setHeaders: (res, filePath) => {
    // Set proper content types
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));

// ── Fallback: serve index.html for root and any unmatched routes ──
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// ── Internal scheduled jobs (Disabled to prevent concurrent execution with Apps Script) ──
// We rely solely on the external Apps Script cron trigger to avoid overlapping executions and duplicate emails.
// cron.schedule('* * * * *', async () => {
//   console.log(`[${new Date().toISOString()}] Internal cron: processing email queue...`);
//   try {
//     const result = await processEmailQueue();
//     if (result.processed > 0) {
//       console.log(`[${new Date().toISOString()}] Processed ${result.processed} emails (${result.success} sent, ${result.failed} failed)`);
//     }
//   } catch (err) {
//     console.error('Internal cron error:', err.message);
//   }
// });

// Cleanup old records daily at 3:00 AM UTC
cron.schedule('0 3 * * *', async () => {
  console.log(`[${new Date().toISOString()}] Internal cron: running cleanup...`);
  try {
    await runCleanup();
  } catch (err) {
    console.error('Internal cleanup cron error:', err.message);
  }
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`\n🚀 Stroke CRM server running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api`);
  console.log(`   Cron:     External Apps Script trigger active (Internal cleanup at 3 AM daily)\n`);
});
