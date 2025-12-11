const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// CORS configuration - ALLOW ALL ORIGINS for tracking
app.use(cors({
    origin: '*', // Allow all origins for the pixel tracker
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
    next();
});

// Compression for production
if (NODE_ENV === 'production') {
    const compression = require('compression');
    app.use(compression());
}

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 500, // Increased for tracking
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: NODE_ENV
    });
});

app.get('/pixel.js', (req, res) => {
    const pixelPath = path.join(__dirname, 'public', 'pixel.js');
    
    if (fs.existsSync(pixelPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.sendFile(pixelPath);
    } else {
        console.error('pixel.js not found at:', pixelPath);
        res.status(404).json({ 
            error: 'Pixel script not found',
            message: 'Please ensure pixel.js exists in the public directory'
        });
    }
});

// Database health check
app.get('/health/db', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.status(200).json({ status: 'ok', database: 'connected' });
    } catch (err) {
        console.error('Database health check failed:', err);
        res.status(503).json({ status: 'error', database: 'disconnected' });
    }
});

// Initialize Database Schema
const initDb = async () => {
    try {
        const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await db.query(schemaSql);
        console.log('✅ Database schema initialized');
    } catch (err) {
        console.error('❌ Error initializing database schema:', err);
        if (NODE_ENV === 'production') {
            process.exit(1);
        }
    }
};

initDb();

// Events ingestion endpoint
app.post('/api/events', async (req, res) => {
    const events = req.body;
    const userAgent = req.headers['user-agent'];

    if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'Invalid payload, expected array of events' });
    }

    if (events.length === 0) {
        return res.status(400).json({ error: 'Empty events array' });
    }

    if (events.length > 100) {
        return res.status(400).json({ error: 'Too many events in batch (max 100)' });
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        for (const event of events) {
            const { session_id, event_type, url, referrer, timestamp, metadata } = event;

            if (!session_id || !event_type || !url) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: 'Missing required fields: session_id, event_type, url'
                });
            }

            // Insert event
            await client.query(
                `INSERT INTO events (session_id, event_type, url, referrer, timestamp, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [session_id, event_type, url, referrer || null, timestamp, metadata || {}]
            );

            // Update session
            const isPageview = event_type === 'pageview' ? 1 : 0;
            await client.query(`
                INSERT INTO sessions (session_id, start_time, page_views, user_agent)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (session_id) DO UPDATE SET
                    end_time = EXCLUDED.start_time,
                    page_views = sessions.page_views + EXCLUDED.page_views,
                    user_agent = COALESCE(sessions.user_agent, EXCLUDED.user_agent)
            `, [session_id, timestamp, isPageview, userAgent]);
        }

        await client.query('COMMIT');
        
        console.log(`✅ Ingested ${events.length} events from session ${events[0].session_id}`);
        
        res.status(200).json({
            message: 'Events ingested successfully',
            count: events.length
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error ingesting events:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Analytics stats endpoint
app.get('/api/stats', async (req, res) => {
    try {
        const [
            totalSessionsResult,
            totalEventsResult,
            clickTargetsResult,
            avgDurationResult,
            topPagesResult
        ] = await Promise.all([
            db.query('SELECT COUNT(*) as count FROM sessions'),
            db.query('SELECT COUNT(*) as count FROM events'),
            db.query(`
                SELECT metadata->>'target' as target, COUNT(*) as count 
                FROM events 
                WHERE event_type = 'click' AND metadata->>'target' IS NOT NULL
                GROUP BY target 
                ORDER BY count DESC 
                LIMIT 5
            `),
            db.query(`
                SELECT AVG(EXTRACT(EPOCH FROM (end_time - start_time))) as avg_duration
                FROM sessions
                WHERE end_time IS NOT NULL AND start_time IS NOT NULL
                    AND end_time > start_time
            `),
            db.query(`
                SELECT url, COUNT(*) as count
                FROM events
                WHERE event_type = 'pageview'
                GROUP BY url
                ORDER BY count DESC
                LIMIT 5
            `)
        ]);

        res.json({
            total_sessions: parseInt(totalSessionsResult.rows[0].count),
            total_events: parseInt(totalEventsResult.rows[0].count),
            top_click_targets: clickTargetsResult.rows,
            top_pages: topPagesResult.rows,
            avg_session_duration: parseFloat(avgDurationResult.rows[0].avg_duration || 0)
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all sessions with summary
app.get('/api/sessions', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                s.session_id,
                s.start_time,
                s.end_time,
                s.page_views,
                s.user_agent,
                EXTRACT(EPOCH FROM (COALESCE(s.end_time, s.start_time) - s.start_time)) as duration,
                COUNT(CASE WHEN e.event_type = 'click' THEN 1 END) as total_clicks
            FROM sessions s
            LEFT JOIN events e ON s.session_id = e.session_id
            GROUP BY s.session_id, s.start_time, s.end_time, s.page_views, s.user_agent
            ORDER BY s.start_time DESC
            LIMIT 50
        `);

        res.json({
            sessions: result.rows.map(row => ({
                ...row,
                duration: parseFloat(row.duration) || 0,
                total_clicks: parseInt(row.total_clicks) || 0
            }))
        });
    } catch (err) {
        console.error('Error fetching sessions:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get detailed session information
app.get('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        // Get session info
        const sessionResult = await db.query(
            `SELECT 
                session_id,
                start_time,
                end_time,
                page_views,
                user_agent,
                EXTRACT(EPOCH FROM (COALESCE(end_time, start_time) - start_time)) as duration
            FROM sessions
            WHERE session_id = $1`,
            [sessionId]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const session = sessionResult.rows[0];

        // Get all events for this session
        const eventsResult = await db.query(
            `SELECT 
                event_type,
                url,
                referrer,
                timestamp,
                metadata
            FROM events
            WHERE session_id = $1
            ORDER BY timestamp ASC`,
            [sessionId]
        );

        // Get pages with time-on-page calculation
        const pagesResult = await db.query(`
            WITH page_visits AS (
                SELECT 
                    url,
                    timestamp,
                    LEAD(timestamp) OVER (ORDER BY timestamp) as next_timestamp
                FROM events
                WHERE session_id = $1 AND event_type = 'pageview'
            )
            SELECT 
                url,
                MIN(timestamp) as first_visit,
                COUNT(*) as view_count,
                AVG(EXTRACT(EPOCH FROM (next_timestamp - timestamp))) as time_on_page
            FROM page_visits
            GROUP BY url
            ORDER BY first_visit ASC
        `, [sessionId]);

        // Get click events
        const clicksResult = await db.query(
            `SELECT 
                timestamp,
                url,
                metadata
            FROM events
            WHERE session_id = $1 AND event_type = 'click'
            ORDER BY timestamp ASC`,
            [sessionId]
        );

        res.json({
            ...session,
            duration: parseFloat(session.duration) || 0,
            events: eventsResult.rows,
            pages: pagesResult.rows.map(row => ({
                ...row,
                time_on_page: parseFloat(row.time_on_page) || 0
            })),
            clicks: clicksResult.rows
        });
    } catch (err) {
        console.error('Error fetching session details:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        error: NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await db.pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await db.pool.end();
    process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
    console.log('🚀 Server running on port', PORT);
    console.log('📊 Environment:', NODE_ENV);
    console.log('🌐 CORS: Allowing all origins for tracking');
    console.log('💡 Visit http://localhost:5173 for dashboard');
});

// Handle server errors
server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
});

module.exports = app;