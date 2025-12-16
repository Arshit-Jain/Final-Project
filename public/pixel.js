// ==UserScript==
// @name         localhost all
// @namespace    http://tampermonkey.net/
// @version      2025-12-11-v2
// @description  Universal pixel tracker with persistent sessions
// @author       You
// @match        *://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=onrender.com
// @grant        GM_setValue
// @grant        GM_getValue
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
        debug: true, // Set to false to reduce console noise
        sessionTimeout: 30 * 60 * 1000 // 30 minutes of inactivity = new session
    };

    class Pixel {
        constructor() {
            this.queue = [];
            this.sessionId = this.getOrCreateSession();
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

        getOrCreateSession() {
            try {
                // Try to use Greasemonkey storage (persists across all domains!)
                if (typeof GM_getValue !== 'undefined') {
                    let sessionData = GM_getValue('pixel_session_data', null);

                    if (sessionData) {
                        sessionData = JSON.parse(sessionData);
                        const lastActivity = sessionData.lastActivity || 0;
                        const now = Date.now();

                        // Check if session is still valid (within timeout window)
                        if (now - lastActivity < CONFIG.sessionTimeout) {
                            // Update last activity time
                            sessionData.lastActivity = now;
                            GM_setValue('pixel_session_data', JSON.stringify(sessionData));
                            this.log('♻️ Reusing existing session', { sessionId: sessionData.sessionId });
                            return sessionData.sessionId;
                        } else {
                            this.log('⏱️ Session expired, creating new one');
                        }
                    }

                    // Create new session
                    const newSessionId = 'sess_' + this.generateId();
                    const newSessionData = {
                        sessionId: newSessionId,
                        created: Date.now(),
                        lastActivity: Date.now()
                    };
                    GM_setValue('pixel_session_data', JSON.stringify(newSessionData));
                    this.log('🆕 Created new session', { sessionId: newSessionId });
                    return newSessionId;
                }

                // Fallback to localStorage (domain-specific, but better than sessionStorage)
                let sessionData = localStorage.getItem('pixel_session_data');

                if (sessionData) {
                    sessionData = JSON.parse(sessionData);
                    const lastActivity = sessionData.lastActivity || 0;
                    const now = Date.now();

                    if (now - lastActivity < CONFIG.sessionTimeout) {
                        sessionData.lastActivity = now;
                        localStorage.setItem('pixel_session_data', JSON.stringify(sessionData));
                        this.log('♻️ Reusing existing session (localStorage)', { sessionId: sessionData.sessionId });
                        return sessionData.sessionId;
                    }
                }

                // Create new session in localStorage
                const newSessionId = 'sess_' + this.generateId();
                const newSessionData = {
                    sessionId: newSessionId,
                    created: Date.now(),
                    lastActivity: Date.now()
                };
                localStorage.setItem('pixel_session_data', JSON.stringify(newSessionData));
                this.log('🆕 Created new session (localStorage)', { sessionId: newSessionId });
                return newSessionId;

            } catch (e) {
                this.log('⚠️ Storage not available, using in-memory session', 'warn');
                // Final fallback: in-memory only (will be lost on page reload)
                if (!this._fallbackSessionId) {
                    this._fallbackSessionId = 'sess_' + this.generateId();
                }
                return this._fallbackSessionId;
            }
        }

        updateSessionActivity() {
            try {
                if (typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined') {
                    let sessionData = GM_getValue('pixel_session_data', null);
                    if (sessionData) {
                        sessionData = JSON.parse(sessionData);
                        sessionData.lastActivity = Date.now();
                        GM_setValue('pixel_session_data', JSON.stringify(sessionData));
                    }
                } else {
                    let sessionData = localStorage.getItem('pixel_session_data');
                    if (sessionData) {
                        sessionData = JSON.parse(sessionData);
                        sessionData.lastActivity = Date.now();
                        localStorage.setItem('pixel_session_data', JSON.stringify(sessionData));
                    }
                }
            } catch (e) {
                // Silently fail
            }
        }

        generateId() {
            return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        }

        init() {
            this.log('🚀 Initializing pixel tracker...', {
                sessionId: this.sessionId,
                url: window.location.href,
                storage: typeof GM_getValue !== 'undefined' ? 'GM_storage (cross-domain)' : 'localStorage (domain-specific)'
            });

            // Track initial pageview
            this.track('pageview');

            // Track clicks with event delegation
            document.addEventListener('click', (e) => {
                this.handleClick(e);
            }, true);

            // Update session activity periodically
            setInterval(() => this.updateSessionActivity(), 60000); // Every minute

            // Flush periodically
            this.flushInterval = setInterval(() => this.flush(), CONFIG.batchInterval);

            // Flush on unload
            window.addEventListener('beforeunload', () => {
                this.updateSessionActivity();
                this.flush(true);
            });

            // Flush on visibility change (mobile Safari)
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.updateSessionActivity();
                    this.flush(true);
                }
            });

            // Track navigation (for SPAs)
            let lastUrl = location.href;
            new MutationObserver(() => {
                const currentUrl = location.href;
                if (currentUrl !== lastUrl) {
                    lastUrl = currentUrl;
                    this.track('pageview');
                }
            }).observe(document, { subtree: true, childList: true });

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
                this.updateSessionActivity();
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
                // Use standard fetch API
                const response = await fetch(CONFIG.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(eventsToSend),
                    keepalive: synchronous, // Important for beforeunload
                    mode: 'cors', // Explicit CORS mode
                    credentials: 'omit' // Don't send cookies
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                const result = await response.json();
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

                // If all retries fail or synchronous, store for next session
                this.storeFailedEvents(eventsToSend);
            } finally {
                this.isFlushing = false;
            }
        }

        storeFailedEvents(events) {
            try {
                if (typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined') {
                    const failed = JSON.parse(GM_getValue('pixel_failed_events', '[]'));
                    failed.push(...events);
                    GM_setValue('pixel_failed_events', JSON.stringify(failed.slice(-100)));
                    this.log('💾 Events stored in GM_storage for retry');
                } else if (typeof localStorage !== 'undefined') {
                    const failed = JSON.parse(localStorage.getItem('pixel_failed_events') || '[]');
                    failed.push(...events);
                    localStorage.setItem('pixel_failed_events', JSON.stringify(failed.slice(-100)));
                    this.log('💾 Events stored in localStorage for retry');
                }
            } catch (e) {
                this.log(`Failed to store events: ${e.message}`, 'error');
            }
        }

        recoverFailedEvents() {
            try {
                let failed = [];

                if (typeof GM_getValue !== 'undefined') {
                    failed = JSON.parse(GM_getValue('pixel_failed_events', '[]'));
                    if (failed.length > 0 && typeof GM_setValue !== 'undefined') {
                        GM_setValue('pixel_failed_events', '[]'); // Clear after recovery
                    }
                } else if (typeof localStorage !== 'undefined') {
                    failed = JSON.parse(localStorage.getItem('pixel_failed_events') || '[]');
                    if (failed.length > 0) {
                        localStorage.removeItem('pixel_failed_events');
                    }
                }

                if (failed.length > 0) {
                    this.log(`🔄 Recovering ${failed.length} failed events from previous session`);
                    this.queue.push(...failed);
                    setTimeout(() => this.flush(), 1000);
                }
            } catch (e) {
                this.log(`Failed to recover events: ${e.message}`, 'error');
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
            this.updateSessionActivity();
        }

        getSession() {
            return this.sessionId;
        }

        destroy() {
            this.updateSessionActivity();
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
    