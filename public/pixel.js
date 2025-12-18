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

    // Configuration
    const CONFIG = {
        endpoint: 'https://final-project-jnv8.onrender.com/api/events',
        batchInterval: 2000,
        maxQueueSize: 50,
        maxRetries: 3,
        retryDelay: 1000,
        debug: true,
        sessionTimeout: 30 * 60 * 1000 // 30 minutes
    };

    class Pixel {
        constructor() {
            this.queue = [];
            this.sessionId = this.getOrCreateSession();
            this.retryCount = 0;
            this.isFlushing = false;
            this.flushInterval = null;

            // Wait for DOM
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.init());
            } else {
                this.init();
            }
        }

        getOrCreateSession() {
            const STORAGE_KEY = 'pixel_session_data';
            
            try {
                // Try localStorage
                const stored = localStorage.getItem(STORAGE_KEY);
                
                if (stored) {
                    try {
                        const sessionData = JSON.parse(stored);
                        const now = Date.now();
                        const lastActivity = sessionData.lastActivity || 0;

                        // Check if session is still valid
                        if (now - lastActivity < CONFIG.sessionTimeout) {
                            // Update activity timestamp
                            sessionData.lastActivity = now;
                            localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));
                            
                            this.log('♻️ Reusing existing session', { 
                                sessionId: sessionData.sessionId,
                                age: Math.floor((now - sessionData.created) / 1000) + 's'
                            });
                            return sessionData.sessionId;
                        } else {
                            this.log('⏱️ Session expired, creating new one');
                        }
                    } catch (parseError) {
                        this.log('⚠️ Invalid session data, creating new session', 'warn');
                    }
                }

                // Create new session
                const newSessionId = 'sess_' + this.generateId();
                const newSessionData = {
                    sessionId: newSessionId,
                    created: Date.now(),
                    lastActivity: Date.now()
                };
                
                localStorage.setItem(STORAGE_KEY, JSON.stringify(newSessionData));
                this.log('🆕 Created new session', { sessionId: newSessionId });
                return newSessionId;

            } catch (storageError) {
                this.log('⚠️ localStorage not available, using in-memory session', 'warn');
                
                // Fallback to in-memory session
                if (!window._pixelSessionId) {
                    window._pixelSessionId = 'sess_' + this.generateId();
                }
                return window._pixelSessionId;
            }
        }

        updateSessionActivity() {
            const STORAGE_KEY = 'pixel_session_data';
            
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    const sessionData = JSON.parse(stored);
                    sessionData.lastActivity = Date.now();
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));
                }
            } catch (e) {
                // Silent fail
            }
        }

        generateId() {
            return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        }

        init() {
            this.log('🚀 Initializing pixel tracker...', {
                sessionId: this.sessionId,
                url: window.location.href,
                storage: 'localStorage'
            });

            // Track initial pageview
            this.track('pageview');

            // Track clicks
            document.addEventListener('click', (e) => {
                this.handleClick(e);
            }, true);

            // Update activity periodically
            setInterval(() => this.updateSessionActivity(), 60000);

            // Flush periodically
            this.flushInterval = setInterval(() => this.flush(), CONFIG.batchInterval);

            // Flush on unload
            window.addEventListener('beforeunload', () => {
                this.updateSessionActivity();
                this.flush(true);
            });

            // Flush on visibility change
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.updateSessionActivity();
                    this.flush(true);
                }
            });

            // Track navigation for SPAs
            let lastUrl = location.href;
            new MutationObserver(() => {
                const currentUrl = location.href;
                if (currentUrl !== lastUrl) {
                    lastUrl = currentUrl;
                    this.track('pageview');
                }
            }).observe(document, { subtree: true, childList: true });

            this.log('✅ Pixel tracker initialized');
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

                if (target.tagName === 'A') {
                    metadata.href = target.href;
                }

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
                this.log(`📊 Event queued: ${eventType}`, { 
                    sessionId: this.sessionId,
                    metadata 
                });
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
                    keepalive: synchronous,
                    mode: 'cors',
                    credentials: 'omit'
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

                if (!synchronous && this.retryCount < CONFIG.maxRetries) {
                    this.retryCount++;
                    this.log(`🔄 Retrying... (${this.retryCount}/${CONFIG.maxRetries})`);
                    this.queue = [...eventsToSend, ...this.queue];

                    setTimeout(() => {
                        this.isFlushing = false;
                        this.flush();
                    }, CONFIG.retryDelay * this.retryCount);
                    return;
                }
            } finally {
                this.isFlushing = false;
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

            // Expose global API
            window.gravity = {
                track: (eventName, metadata) => window.pixelTracker.trackCustomEvent(eventName, metadata),
                getSession: () => window.pixelTracker.getSession()
            };

            console.log('🎯 Pixel Tracker loaded!');
            console.log('📍 Session ID:', window.pixelTracker.getSession());
            console.log('🌐 URL:', window.location.href);
        }
    } catch (error) {
        console.error('❌ Failed to initialize Pixel Tracker:', error);
    }
})();