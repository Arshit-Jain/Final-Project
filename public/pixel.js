(function (window) {
    'use strict';

    // Configuration
    const CONFIG = {
        endpoint: '%VITE_API_URL%/api/events', // Will be replaced during build
        batchInterval: 2000, // 2 seconds
        maxQueueSize: 50,
        maxRetries: 3,
        retryDelay: 1000
    };

    class Pixel {
        constructor() {
            this.queue = [];
            this.sessionId = this.getSessionId();
            this.retryCount = 0;
            this.isFlushingß = false;
            this.init();
        }

        getSessionId() {
            let sid = sessionStorage.getItem('pixel_session_id');
            if (!sid) {
                sid = 'sess_' + this.generateId();
                sessionStorage.setItem('pixel_session_id', sid);
            }
            return sid;
        }

        generateId() {
            return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        }

        init() {
            // Track initial pageview
            this.track('pageview');

            // Track clicks with event delegation
            document.addEventListener('click', (e) => {
                this.handleClick(e);
            }, true);

            // Flush periodically
            this.flushInterval = setInterval(() => this.flush(), CONFIG.batchInterval);

            // Flush on unload
            window.addEventListener('beforeunload', () => this.flush(true));

            // Flush on visibility change (mobile Safari)
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.flush(true);
                }
            });
        }

        handleClick(e) {
            const target = e.target;
            const metadata = {
                target: target.tagName,
                id: target.id || null,
                class: target.className || null,
                text: target.innerText ? target.innerText.substring(0, 50) : null
            };

            // Track link clicks
            if (target.tagName === 'A') {
                metadata.href = target.href;
            }

            // Track button clicks
            if (target.tagName === 'BUTTON' || target.type === 'button') {
                metadata.type = target.type;
            }

            this.track('click', metadata);
        }

        track(eventType, metadata = {}) {
            // Prevent queue overflow
            if (this.queue.length >= CONFIG.maxQueueSize) {
                console.warn('Pixel queue full, flushing...');
                this.flush();
            }

            const event = {
                session_id: this.sessionId,
                event_type: eventType,
                url: window.location.href,
                referrer: document.referrer || null,
                timestamp: new Date().toISOString(),
                metadata: metadata
            };

            this.queue.push(event);

            if (process.env.NODE_ENV !== 'production') {
                console.log('📊 Event queued:', event);
            }
        }

        async flush(synchronous = false) {
            if (this.queue.length === 0 || this.isFlushing) {
                return;
            }

            this.isFlushing = true;
            const eventsToSend = [...this.queue];
            this.queue = [];

            try {
                const response = await fetch(CONFIG.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(eventsToSend),
                    keepalive: synchronous // Ensure completion on page unload
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                // Reset retry count on success
                this.retryCount = 0;

                if (process.env.NODE_ENV !== 'production') {
                    console.log('✅ Events sent successfully:', eventsToSend.length);
                }
            } catch (err) {
                console.error('❌ Failed to send events:', err);

                // Retry logic (only for non-synchronous flushes)
                if (!synchronous && this.retryCount < CONFIG.maxRetries) {
                    this.retryCount++;
                    console.log(`🔄 Retrying... (${this.retryCount}/${CONFIG.maxRetries})`);
                    
                    // Put events back in queue
                    this.queue = [...eventsToSend, ...this.queue];
                    
                    // Retry after delay
                    setTimeout(() => {
                        this.isFlushing = false;
                        this.flush();
                    }, CONFIG.retryDelay * this.retryCount);
                    return;
                }

                // If all retries fail or synchronous, store in localStorage for next session
                if (typeof localStorage !== 'undefined') {
                    try {
                        const failed = JSON.parse(localStorage.getItem('pixel_failed_events') || '[]');
                        failed.push(...eventsToSend);
                        localStorage.setItem('pixel_failed_events', JSON.stringify(failed.slice(-100))); // Keep last 100
                    } catch (e) {
                        console.error('Failed to store events in localStorage:', e);
                    }
                }
            } finally {
                this.isFlushing = false;
            }
        }

        // Recover failed events from previous session
        recoverFailedEvents() {
            if (typeof localStorage === 'undefined') return;

            try {
                const failed = JSON.parse(localStorage.getItem('pixel_failed_events') || '[]');
                if (failed.length > 0) {
                    console.log(`🔄 Recovering ${failed.length} failed events from previous session`);
                    this.queue.push(...failed);
                    localStorage.removeItem('pixel_failed_events');
                    this.flush();
                }
            } catch (e) {
                console.error('Failed to recover events from localStorage:', e);
            }
        }

        // Public API for custom tracking
        trackCustomEvent(eventName, metadata = {}) {
            this.track(eventName, metadata);
        }

        // Get current session ID
        getSession() {
            return this.sessionId;
        }

        // Destroy instance
        destroy() {
            this.flush(true);
            clearInterval(this.flushInterval);
        }
    }

    // Initialize and expose to window
    if (!window.gravity) {
        window.gravity = new Pixel();
        
        // Recover any failed events from previous session
        window.gravity.recoverFailedEvents();

        // Log initialization in dev mode
        if (process.env.NODE_ENV !== 'production') {
            console.log('🚀 Pixel tracking initialized');
            console.log('📍 Session ID:', window.gravity.getSession());
        }
    }

})(window);