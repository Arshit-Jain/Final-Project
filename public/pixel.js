// ==UserScript==
// @name         Universal Analytics Pixel Tracker
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Track page views and clicks on ANY website
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Configuration - UPDATE THIS WITH YOUR SERVER URL
    const CONFIG = {
        endpoint: 'http://localhost:3000/api/events',
        batchInterval: 2000, // 2 seconds
        maxQueueSize: 50,
        maxRetries: 3,
        retryDelay: 1000,
        debug: true // Set to false to reduce console noise
    };

    class Pixel {
        constructor() {
            this.queue = [];
            this.sessionId = this.getSessionId();
            this.retryCount = 0;
            this.isFlushing = false;
            this.flushInterval = null;
            
            // Wait for DOM to be ready before initializing
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.init());
            } else {
                this.init();
            }
        }

        getSessionId() {
            try {
                let sid = sessionStorage.getItem('pixel_session_id');
                if (!sid) {
                    sid = 'sess_' + this.generateId();
                    sessionStorage.setItem('pixel_session_id', sid);
                }
                return sid;
            } catch (e) {
                // Fallback if sessionStorage is not available
                return 'sess_' + this.generateId();
            }
        }

        generateId() {
            return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        }

        init() {
            this.log('🚀 Initializing pixel tracker...', { 
                sessionId: this.sessionId,
                url: window.location.href 
            });

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

            // Recover failed events from previous session
            this.recoverFailedEvents();

            this.log('✅ Pixel tracker initialized successfully');
        }

        handleClick(e) {
            try {
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
            } catch (err) {
                this.log(`Error handling click: ${err.message}`, 'error');
            }
        }

        track(eventType, metadata = {}) {
            try {
                // Prevent queue overflow
                if (this.queue.length >= CONFIG.maxQueueSize) {
                    this.log('⚠️ Queue full, flushing...', 'warn');
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
                this.log(`📊 Event queued: ${eventType}`, event);
            } catch (err) {
                this.log(`Error tracking event: ${err.message}`, 'error');
            }
        }

        async flush(synchronous = false) {
            if (this.queue.length === 0 || this.isFlushing) {
                return;
            }

            this.isFlushing = true;
            const eventsToSend = [...this.queue];
            this.queue = [];

            this.log(`📤 Flushing ${eventsToSend.length} events...`);

            try {
                const response = await fetch(CONFIG.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(eventsToSend),
                    keepalive: synchronous
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                const result = await response.json();
                
                // Reset retry count on success
                this.retryCount = 0;
                this.log(`✅ ${eventsToSend.length} events sent successfully`, result);
            } catch (err) {
                this.log(`❌ Failed to send events: ${err.message}`, 'error');

                // Retry logic (only for non-synchronous flushes)
                if (!synchronous && this.retryCount < CONFIG.maxRetries) {
                    this.retryCount++;
                    this.log(`🔄 Retrying... (${this.retryCount}/${CONFIG.maxRetries})`);
                    
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
                        localStorage.setItem('pixel_failed_events', JSON.stringify(failed.slice(-100)));
                        this.log('💾 Events stored in localStorage for retry');
                    } catch (e) {
                        this.log(`Failed to store events in localStorage: ${e.message}`, 'error');
                    }
                }
            } finally {
                this.isFlushing = false;
            }
        }

        recoverFailedEvents() {
            if (typeof localStorage === 'undefined') return;

            try {
                const failed = JSON.parse(localStorage.getItem('pixel_failed_events') || '[]');
                if (failed.length > 0) {
                    this.log(`🔄 Recovering ${failed.length} failed events from previous session`);
                    this.queue.push(...failed);
                    localStorage.removeItem('pixel_failed_events');
                    setTimeout(() => this.flush(), 1000);
                }
            } catch (e) {
                this.log(`Failed to recover events from localStorage: ${e.message}`, 'error');
            }
        }

        log(message, data = null, level = 'info') {
            if (!CONFIG.debug) return;

            const prefix = '📊 [Pixel Tracker]';
            const output = data ? [prefix, message, data] : [prefix, message];
            
            if (level === 'error') {
                console.error(...output);
            } else if (level === 'warn') {
                console.warn(...output);
            } else {
                console.log(...output);
            }
        }

        trackCustomEvent(eventName, metadata = {}) {
            this.track(eventName, metadata);
        }

        getSession() {
            return this.sessionId;
        }

        destroy() {
            this.flush(true);
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
            }
        }
    }

    // Initialize tracker
    try {
        if (!window.pixelTracker) {
            window.pixelTracker = new Pixel();
            
            // Expose a global API
            window.gravity = {
                track: (eventName, metadata) => window.pixelTracker.trackCustomEvent(eventName, metadata),
                getSession: () => window.pixelTracker.getSession()
            };
            
            console.log('🎯 Pixel Tracker loaded successfully!');
            console.log('📍 Session ID:', window.pixelTracker.getSession());
            console.log('🌐 Tracking URL:', window.location.href);
        }
    } catch (error) {
        console.error('❌ Failed to initialize Pixel Tracker:', error);
    }

})();