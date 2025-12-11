const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// Pool configuration with optimized settings
const poolConfig = {
    connectionString: process.env.DATABASE_URL,

    // Connection pool settings
    max: parseInt(process.env.DB_POOL_MAX) || (isProduction ? 20 : 5),
    min: parseInt(process.env.DB_POOL_MIN) || (isProduction ? 2 : 1),

    // Timeout settings (reduced for faster feedback)
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 3000, // Reduced to 3s

    // Query timeout to prevent hanging
    query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 10000,
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 15000,

    // Keep connections alive
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,

    // Production SSL configuration
    ...(isProduction && {
        ssl: {
            rejectUnauthorized: false
        }
    })
};

// Create pool
const pool = new Pool(poolConfig);

// Track connection state
let isConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 3;

// Connection event handlers
pool.on('connect', (client) => {
    isConnected = true;
    connectionAttempts = 0;
    if (isDevelopment) {
        console.log('📦 Database connection established');
    }
});

pool.on('acquire', (client) => {
    if (process.env.DEBUG_DB === 'true') {
        console.log('🔓 Client acquired from pool');
    }
});

pool.on('remove', (client) => {
    if (process.env.DEBUG_DB === 'true') {
        console.log('🔒 Client removed from pool');
    }
});

pool.on('error', (err, client) => {
    isConnected = false;

    // Filter out common non-critical errors
    const ignoreCodes = ['XX000', '57P01', '57P03', 'ECONNRESET'];
    if (!ignoreCodes.includes(err.code)) {
        console.error('❌ Unexpected database error:', err.message);

        if (isProduction && process.env.SENTRY_DSN) {
            // Example: Sentry.captureException(err);
        }
    }
});

// Query helper with error handling and retry logic
const query = async (text, params, retries = 0) => {
    const start = Date.now();

    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;

        // Log slow queries (over 1 second)
        if (duration > 1000) {
            console.warn(`⚠️ Slow query (${duration}ms):`, text.substring(0, 100));
        }

        // Debug mode: log all queries
        if (process.env.DEBUG_DB === 'true') {
            console.log(`✓ Query executed in ${duration}ms`);
        }

        return res;
    } catch (err) {
        const duration = Date.now() - start;
        console.error(`❌ Query failed after ${duration}ms:`, err.message);

        // Retry logic for transient errors
        const retryableCodes = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', '57P03'];
        if (retries < MAX_RETRY_ATTEMPTS && retryableCodes.includes(err.code)) {
            console.log(`🔄 Retrying query (attempt ${retries + 1}/${MAX_RETRY_ATTEMPTS})...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
            return query(text, params, retries + 1);
        }

        throw err;
    }
};

// Fast health check with timeout
const healthCheck = async (timeoutMs = 2000) => {
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), timeoutMs)
    );

    try {
        await Promise.race([
            pool.query('SELECT 1 as health'),
            timeoutPromise
        ]);

        isConnected = true;
        return {
            healthy: true,
            message: 'Database connection OK',
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        isConnected = false;
        return {
            healthy: false,
            message: err.message,
            timestamp: new Date().toISOString()
        };
    }
};

// Get connection status
const getStatus = () => ({
    isConnected,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
});

// Initialize database schema (optimized)
const initializeSchema = async () => {
    const fs = require('fs');
    const path = require('path');

    try {
        console.log('🔄 Initializing database schema...');

        // Check if schema file exists
        const schemaPath = path.join(__dirname, 'schema.sql');
        if (!fs.existsSync(schemaPath)) {
            throw new Error('schema.sql not found');
        }

        // Read and execute schema with timeout
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Schema initialization timeout')), 10000)
        );

        await Promise.race([
            query(schemaSql),
            timeoutPromise
        ]);

        console.log('✅ Database schema initialized successfully');
        return { success: true };
    } catch (err) {
        console.error('❌ Schema initialization error:', err.message);

        if (isProduction) {
            throw err; // Fail hard in production
        }

        return { success: false, error: err.message };
    }
};

// Test connection on module load (non-blocking)
(async () => {
    try {
        const result = await healthCheck(3000);
        if (result.healthy) {
            console.log('✅ Initial database connection successful');
        } else {
            console.warn('⚠️ Database connection check failed:', result.message);
            if (!isProduction) {
                console.log('💡 Server will start anyway (dev mode)');
            }
        }
    } catch (err) {
        console.error('❌ Database connection test failed:', err.message);
        if (!isProduction) {
            console.log('💡 Server will start anyway (dev mode)');
        }
    }
})();

// Graceful shutdown
const shutdown = async () => {
    console.log('🔄 Closing database pool...');
    try {
        await pool.end();
        console.log('✅ Database pool closed successfully');
    } catch (err) {
        console.error('❌ Error closing database pool:', err);
    }
};

// Export all functions
module.exports = {
    query,
    pool,
    healthCheck,
    getStatus,
    initializeSchema,
    shutdown,
    isConnected: () => isConnected
};