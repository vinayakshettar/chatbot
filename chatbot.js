(function (window) {
    'use strict';

    const DEFAULT_CONFIG = {
        apiBaseUrl: 'http://localhost:5000',
        endpoints: {
            createTicket: '/api/ticket',
            intentDetection: '/api/chatbot/intent'
        },
        position: 'bottom-right',
        primaryColor: '#259feb',
        chatbotName: 'Support Assistant',
        autoOpen: false,
        enableErrorDetection: true,
        enableScreenshot: true,
        maxFileSize: 5242880,
        maxFiles: 5,
        allowedFileTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],

        // AUTO-REPORTING CONFIG
        autoReportErrors: true,
        autoReportDelay: 2000,
        autoReportDefaults: {
            impact: 'SingleUser',
            urgency: 'CanWorkWithManyDifficulties',
            priority: 'High',
            category: 'Functional issue Report',
            contactDetails: 'Auto-reported'
        },

        headers: { 'Content-Type': 'application/json' },
        onTicketCreated: null,
        onError: null,
        onOpen: null,
        onClose: null,
        onAutoReport: null
    };

    class SupportChatbot {
        constructor(userConfig = {}) {
            this.config = { ...DEFAULT_CONFIG, ...userConfig };
            this.state = {
                isOpen: this.config.autoOpen,
                messages: [],
                currentStep: 'greeting',
                ticketData: this.initTicketData(),
                detectedErrors: [],
                isLoading: false,
                uploadedImages: [],
                sessionId: this.generateSessionId(),
                autoReportTimer: null,
                autoReportedErrors: [],
                pendingError: null
            };
            this.options = this.initOptions();
            this.container = null;
            this.init();
        }

        generateSessionId() {
            return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        initTicketData() {
            return {
                impact: '', urgency: '', priority: '', category: '',
                description: '', contactDetails: '', images: [], errors: [],
                metadata: {
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    timestamp: new Date().toISOString()
                }
            };
        }

        initOptions() {
            return {
                impact: [
                    { id: 'SingleUser', label: 'Single user' },
                    { id: 'GroupOfUsers', label: 'Group of users' },
                    { id: 'AllUsers', label: 'All users' }
                ],
                urgency: [
                    { id: 'CanWorkNormally', label: 'I can work normally anyway' },
                    { id: 'CanWorkWithSomeDifficulties', label: 'I can work with some difficulties' },
                    { id: 'CanWorkWithManyDifficulties', label: 'I can work but with many difficulties' },
                    { id: 'CannotWork', label: 'I cannot work' }
                ],
                priority: [
                    { id: 'Low', label: 'Low' }, { id: 'Normal', label: 'Normal' },
                    { id: 'High', label: 'High' }, { id: 'Critical', label: 'Critical' }
                ],
                category: ['UI/UX', 'Functional issue Report', 'Other']
            };
        }

        init() {
            this.injectStyles();
            this.createChatbotUI();
            if (this.config.enableErrorDetection) {
                this.setupErrorDetection();
            }
            if (this.state.isOpen) {
                this.addMessage('bot', `👋 Hello! I'm ${this.config.chatbotName}. How can I help you today?`);
            }
        }

        setupErrorDetection() {
            const self = this;

            window.addEventListener('error', (event) => {
                this.captureError({
                    type: 'JavaScript Error',
                    message: event.message,
                    file: event.filename,
                    line: event.lineno,
                    column: event.colno,
                    timestamp: new Date().toISOString(),
                    severity: 'high'
                });
            });

            window.addEventListener('unhandledrejection', (event) => {
                this.captureError({
                    type: 'Unhandled Promise',
                    message: event.reason?.message || String(event.reason),
                    timestamp: new Date().toISOString(),
                    severity: 'high'
                });
            });

            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                try {
                    const response = await originalFetch(...args);
                    if (!response.ok && response.status >= 400) {
                        const severity = response.status >= 500 ? 'critical' : 'medium';
                        self.captureError({
                            type: `HTTP ${response.status}`,
                            message: `${response.statusText} - ${args[0]}`,
                            url: args[0],
                            status: response.status,
                            timestamp: new Date().toISOString(),
                            severity: severity
                        });
                    }
                    return response;
                } catch (error) {
                    self.captureError({
                        type: 'Network Error',
                        message: `Failed: ${args[0]}`,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                        severity: 'critical'
                    });
                    throw error;
                }
            };

            const originalXHR = window.XMLHttpRequest;
            window.XMLHttpRequest = function () {
                const xhr = new originalXHR();
                const originalOpen = xhr.open;
                let requestURL = '';

                xhr.open = function (method, url) {
                    requestURL = url;
                    return originalOpen.apply(this, arguments);
                };

                xhr.addEventListener('error', () => {
                    self.captureError({
                        type: 'XHR Error',
                        message: `Request failed: ${requestURL}`,
                        timestamp: new Date().toISOString(),
                        severity: 'critical'
                    });
                });

                xhr.addEventListener('load', function () {
                    if (this.status >= 400) {
                        const severity = this.status >= 500 ? 'critical' : 'medium';
                        self.captureError({
                            type: `HTTP ${this.status}`,
                            message: `${this.statusText} - ${requestURL}`,
                            status: this.status,
                            timestamp: new Date().toISOString(),
                            severity: severity
                        });
                    }
                });

                return xhr;
            };
        }

        captureError(error) {
            const errorSignature = `${error.type}-${error.message}`;
            if (this.state.autoReportedErrors.includes(errorSignature)) {
                return;
            }

            this.state.detectedErrors.push(error);
            this.updateErrorBadge();

            const shouldAutoReport = this.shouldAutoReportError(error);

            if (shouldAutoReport) {
                this.scheduleAutoReport(error, errorSignature);
            } else if (error.severity === 'critical') {
                this.open();
                this.state.currentStep = 'error_detected';
                this.state.pendingError = error;
                this.addMessage('bot', `⚠️ We detected an error: ${error.message}. Would you like to report this?`);
            }
        }

        shouldAutoReportError(error) {
            if (!this.config.autoReportErrors) return false;
            const criticalTypes = [
                'HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 504',
                'Network Error', 'JavaScript Error'
            ];
            return criticalTypes.some(type => error.type.includes(type));
        }

        scheduleAutoReport(error, errorSignature) {
            if (this.state.autoReportTimer) {
                clearTimeout(this.state.autoReportTimer);
            }
            this.state.autoReportTimer = setTimeout(() => {
                this.autoReportError(error, errorSignature);
            }, this.config.autoReportDelay);
        }

        async autoReportError(triggeringError, errorSignature) {
            this.state.autoReportedErrors.push(errorSignature);
            const errorSummary = this.buildErrorDescription(triggeringError);

            const autoTicketData = {
                ...this.config.autoReportDefaults,
                description: errorSummary,
                images: [],
                errors: [triggeringError, ...this.state.detectedErrors.slice(-5)],
                metadata: {
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    timestamp: new Date().toISOString(),
                    sessionId: this.state.sessionId,
                    autoReported: true
                }
            };

            this.open();
            this.addMessage('bot', `🤖 Auto-reporting error: ${triggeringError.type} - ${triggeringError.message}`);

            try {
                const formData = new FormData();
                for (const key in autoTicketData) {
                    if (key !== 'images' && key !== 'errors') {
                        formData.append(key, typeof autoTicketData[key] === 'object' ?
                            JSON.stringify(autoTicketData[key]) : autoTicketData[key]);
                    }
                }
                formData.append('errors', JSON.stringify(autoTicketData.errors));

                const url = `${this.config.apiBaseUrl}${this.config.endpoints.createTicket}`;
                const response = await fetch(url, {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();
                console.log(result);
                console.log(response);

                this.addMessage('bot', `✅ Error automatically reported as ticket #${result}. Our team will investigate.`);

                if (this.config.onAutoReport) {
                    this.config.onAutoReport(ticketId, autoTicketData);
                }

                this.state.detectedErrors = [];
                this.updateErrorBadge();

            } catch (error) {
                console.error('Auto-report failed:', error);
                this.addMessage('bot', '⚠️ Auto-report failed. You can manually create a ticket if needed.');
            }
        }

        buildErrorDescription(primaryError) {
            const lines = [
                '🤖 AUTOMATICALLY REPORTED ERROR', '',
                `Primary Error: ${primaryError.type}`,
                `Message: ${primaryError.message}`,
                `Timestamp: ${primaryError.timestamp}`, ''
            ];

            if (primaryError.url) lines.push(`URL: ${primaryError.url}`);
            if (primaryError.file) lines.push(`File: ${primaryError.file}:${primaryError.line}:${primaryError.column}`);
            if (primaryError.status) lines.push(`Status Code: ${primaryError.status}`);

            if (this.state.detectedErrors.length > 1) {
                lines.push('', 'Recent errors:');
                this.state.detectedErrors.slice(-3).forEach((err, idx) => {
                    lines.push(`${idx + 1}. ${err.type}: ${err.message}`);
                });
            }

            lines.push('', `Session ID: ${this.state.sessionId}`);
            lines.push(`User Agent: ${navigator.userAgent}`);
            lines.push(`Page URL: ${window.location.href}`);

            return lines.join('\n');
        }

        updateErrorBadge() {
            const badge = this.container?.querySelector('.chatbot-error-badge');
            if (badge) {
                badge.textContent = this.state.detectedErrors.length;
                badge.style.display = this.state.detectedErrors.length > 0 ? 'flex' : 'none';
            }
        }

        injectStyles() {
            const styles = `
.support-chatbot * { box-sizing: border-box; margin: 0; padding: 0; }
.support-chatbot { position: fixed; ${this.getPositionStyles()} z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.chatbot-button { width: 60px; height: 60px; border-radius: 50%; background: ${this.config.primaryColor}; border: none; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; transition: transform 0.2s; position: relative; }
.chatbot-button:hover { transform: scale(1.1); }
.chatbot-button svg { width: 28px; height: 28px; fill: white; }
.chatbot-error-badge { position: absolute; top: -8px; right: -8px; background: #ef4444; color: white; border-radius: 50%; width: 24px; height: 24px; font-size: 12px; font-weight: bold; display: none; align-items: center; justify-content: center; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.chatbot-window { width: 380px; height: 500px; background: white; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); display: none; flex-direction: column; overflow: hidden; }
.chatbot-window.open { display: flex; }
.chatbot-header { background: linear-gradient(135deg, ${this.config.primaryColor} 0%, ${this.adjustColor(this.config.primaryColor, -20)} 100%); color: white; padding: 16px; display: flex; justify-content: space-between; align-items: center; }
.chatbot-header-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 16px; }
.chatbot-close { background: rgba(255,255,255,0.2); border: none; color: white; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-size: 20px; line-height: 1; }
.chatbot-close:hover { background: rgba(255,255,255,0.3); }
.chatbot-messages { flex: 1; overflow-y: auto; padding: 16px; background: #f9fafb; }
.chatbot-messages::-webkit-scrollbar { width: 6px; }
.chatbot-messages::-webkit-scrollbar-track { background: #f1f1f1; }
.chatbot-messages::-webkit-scrollbar-thumb { background: #888; border-radius: 3px; }
.message { margin-bottom: 12px; display: flex; animation: slideIn 0.3s ease-out; }
@keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.message.user { justify-content: flex-end; }
.message-content { max-width: 80%; padding: 12px; border-radius: 8px; font-size: 14px; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
.message.bot .message-content { background: white; color: #1f2937; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
.message.user .message-content { background: ${this.config.primaryColor}; color: white; }
.message-time { font-size: 11px; opacity: 0.7; margin-top: 4px; }
.options-container { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; animation: slideIn 0.3s ease-out; }
.option-button { padding: 12px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; cursor: pointer; text-align: left; font-size: 14px; transition: all 0.2s; font-family: inherit; }
.option-button:hover { background: ${this.adjustColor(this.config.primaryColor, 90)}; border-color: ${this.config.primaryColor}; transform: translateX(4px); }
.option-button.primary { background: ${this.config.primaryColor}; color: white; border-color: ${this.config.primaryColor}; font-weight: 600; }
.option-button.primary:hover { background: ${this.adjustColor(this.config.primaryColor, -10)}; }
.chatbot-input-area { border-top: 1px solid #e5e7eb; padding: 16px; background: white; }
.input-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.input-actions .action-btn { padding: 10px; background: #f3f4f6; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; color: #6b7280; }
.input-actions .action-btn:hover { background: #e5e7eb; color: #374151; }
.input-actions .action-btn svg { width: 20px; height: 20px; }
.input-row { display: flex; gap: 8px; }
.chatbot-input { flex: 1; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; font-family: inherit; }
.chatbot-input:focus { border-color: ${this.config.primaryColor}; box-shadow: 0 0 0 3px ${this.adjustColor(this.config.primaryColor, 90)}; }
.send-button { padding: 10px 16px; background: ${this.config.primaryColor}; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-family: inherit; transition: all 0.2s; }
.send-button:hover { background: ${this.adjustColor(this.config.primaryColor, -10)}; }
.send-button:disabled { background: #d1d5db; cursor: not-allowed; }
.loader { border: 2px solid #f3f4f6; border-top: 2px solid ${this.config.primaryColor}; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; }
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
.submit-button { width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; margin-top: 8px; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; }
.submit-button:hover { background: #059669; }
.submit-button:disabled { background: #d1d5db; cursor: not-allowed; }
.ticket-summary { background: white; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb; margin-top: 8px; }
.ticket-summary h4 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #1f2937; }
.ticket-summary p { font-size: 12px; margin: 4px 0; color: #4b5563; }
.ticket-summary strong { color: #1f2937; }
.image-preview { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; max-height: 150px; overflow-y: auto; padding: 8px; background: #f9fafb; border-radius: 6px; }
.image-preview-item { position: relative; width: 70px; height: 70px; border-radius: 6px; overflow: hidden; border: 2px solid #e5e7eb; background: white; flex-shrink: 0; }
.image-preview-item img { width: 100%; height: 100%; object-fit: cover; }
.image-preview-remove { position: absolute; top: -8px; right: -8px; background: #ef4444; color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.image-preview-remove:hover { background: #dc2626; transform: scale(1.1); }
@media (max-width: 480px) {
  .chatbot-window { width: 100vw; height: 100vh; border-radius: 0; }
  .support-chatbot { bottom: 0 !important; right: 0 !important; left: 0 !important; top: 0 !important; }
}`;
            const styleSheet = document.createElement('style');
            styleSheet.textContent = styles;
            document.head.appendChild(styleSheet);
        }

        getPositionStyles() {
            const positions = {
                'bottom-right': 'bottom: 20px; right: 20px;',
                'bottom-left': 'bottom: 20px; left: 20px;',
                'top-right': 'top: 20px; right: 20px;',
                'top-left': 'top: 20px; left: 20px;'
            };
            return positions[this.config.position] || positions['bottom-right'];
        }

        adjustColor(color, amount) {
            const clamp = (val) => Math.min(Math.max(val, 0), 255);
            const num = parseInt(color.replace('#', ''), 16);
            const r = clamp((num >> 16) + amount);
            const g = clamp(((num >> 8) & 0x00FF) + amount);
            const b = clamp((num & 0x0000FF) + amount);
            return '#' + (0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1);
        }

        createChatbotUI() {
            this.container = document.createElement('div');
            this.container.className = 'support-chatbot';
            this.container.innerHTML = this.renderChatbot();
            document.body.appendChild(this.container);
            this.attachEventListeners();
        }

        renderChatbot() {
            return `${!this.state.isOpen ? this.renderButton() : this.renderWindow()}`;
        }

        renderButton() {
            return `
<button class="chatbot-button" onclick="window.supportChatbot.toggle()">
  <svg viewBox="0 0 24 24">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
  </svg>
  <div class="chatbot-error-badge">${this.state.detectedErrors.length}</div>
</button>`;
        }

        renderWindow() {
            return `
<div class="chatbot-window open">
  <div class="chatbot-header">
    <div class="chatbot-header-title">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
      </svg>
      <span>${this.config.chatbotName}</span>
    </div>
    <button class="chatbot-close" onclick="window.supportChatbot.toggle()">×</button>
  </div>
  <div class="chatbot-messages" id="chatbot-messages">
    ${this.renderMessages()}
    ${this.renderOptions()}
    ${this.state.isLoading ? '<div class="message bot"><div class="message-content"><div class="loader"></div></div></div>' : ''}
  </div>
  <div class="chatbot-input-area">
    ${this.renderImagePreviews()}
    <div class="input-actions">
      <input type="file" id="chatbot-file-input" accept="${this.config.allowedFileTypes.join(',')}" multiple style="display: none;">
      <button onclick="document.getElementById('chatbot-file-input').click()" title="Upload image" class="action-btn">
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </button>
      ${this.config.enableScreenshot ? `<button onclick="window.supportChatbot.captureScreenshot()" title="Take screenshot" class="action-btn">
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </button>` : ''}
    </div>
    <div class="input-row">
      <input type="text" id="chatbot-input" class="chatbot-input" placeholder="Type a message..." />
      <button class="send-button" onclick="window.supportChatbot.send()">Send</button>
    </div>
  </div>
</div>`;
        }

        renderMessages() {
            return this.state.messages.map(msg => `
<div class="message ${msg.sender}">
  <div class="message-content">
    ${this.escapeHtml(msg.text)}
    <div class="message-time">${this.formatTime(msg.timestamp)}</div>
  </div>
</div>`).join('');
        }

        renderOptions() {
            const step = this.state.currentStep;
            const data = this.state.ticketData;

            if (step === 'error_detected') {
                return `<div class="options-container">
<button class="option-button primary" onclick="window.supportChatbot.reportDetectedError()">
  🐛 Report This Error
</button>
<button class="option-button" onclick="window.supportChatbot.dismissError()">
  ❌ Dismiss
</button>
</div>`;
            }

            if (step === 'greeting') {
                return `<div class="options-container">
<button class="option-button primary" onclick="window.supportChatbot.startReportIssue()">🛠 Open a support ticket</button>
</div>`;
            }
            if (step === 'new_ticket_prompt') {
                return `<div class="options-container">
<button class="option-button primary" onclick="window.supportChatbot.handleNewTicketResponse('yes')">✅ Yes, create another ticket</button>
<button class="option-button" onclick="window.supportChatbot.handleNewTicketResponse('no')">❌ No, I'm done</button>
</div>`;
            }
            if (step === 'contact_prompt') {
                return `<div class="options-container">
<button class="option-button primary" onclick="window.supportChatbot.selectContactOption('provide')">✅ Yes, I'll provide my email</button>
<button class="option-button" onclick="window.supportChatbot.selectContactOption('skip')">⏭️ Skip (submit anonymously)</button>
</div>`;
            }
            if (step === 'impact' && !data.impact) {
                return `<div class="options-container">
${this.options.impact.map(opt => `<button class="option-button" onclick="window.supportChatbot.selectOption('impact', '${opt.id}')">${opt.label}</button>`).join('')}
</div>`;
            }
            if (step === 'urgency' && !data.urgency) {
                return `<div class="options-container">
${this.options.urgency.map(opt => `<button class="option-button" onclick="window.supportChatbot.selectOption('urgency', '${opt.id}')">${opt.label}</button>`).join('')}
</div>`;
            }
            if (step === 'priority' && !data.priority) {
                return `<div class="options-container">
${this.options.priority.map(opt => `<button class="option-button" onclick="window.supportChatbot.selectOption('priority', '${opt.id}')">${opt.label}</button>`).join('')}
</div>`;
            }
            if (step === 'category' && !data.category) {
                return `<div class="options-container">
${this.options.category.map(cat => `<button class="option-button" onclick="window.supportChatbot.selectOption('category', '${cat}')">${cat}</button>`).join('')}
</div>`;
            }
            if (step === 'confirmation') {
                return `
<div class="ticket-summary">
  <h4>📋 Ticket Summary</h4>
  <p><strong>Description:</strong> ${data.description}</p>
  <p><strong>Impact:</strong> ${data.impact}</p>
  <p><strong>Urgency:</strong> ${data.urgency}</p>
  <p><strong>Priority:</strong> ${data.priority}</p>
  <p><strong>Category:</strong> ${data.category}</p>
  ${data.contactDetails ? `<p><strong>Contact:</strong> ${data.contactDetails}</p>` : '<p><strong>Contact:</strong> Anonymous</p>'}
  ${data.images.length > 0 ? `<p><strong>Attachments:</strong> ${data.images.length} file(s)</p>` : ''}
  ${this.state.detectedErrors.length > 0 ? `<p><strong>Detected Errors:</strong> ${this.state.detectedErrors.length} error(s)</p>` : ''}
</div>
<button class="submit-button" onclick="window.supportChatbot.submitTicket()">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20 6L9 17l-5-5"/></svg>
  Submit Ticket
</button>`;
            }
            return '';
        }

        renderImagePreviews() {
            if (this.state.uploadedImages.length === 0) return '';
            return `
<div class="image-preview">
  ${this.state.uploadedImages.map((img, idx) => `
    <div class="image-preview-item">
      <img src="${img.data}" alt="${img.name}" />
      <button class="image-preview-remove" onclick="window.supportChatbot.removeImage(${idx})">×</button>
    </div>`).join('')}
</div>`;
        }

        attachEventListeners() {
            const input = this.container?.querySelector('#chatbot-input');
            const fileInput = this.container?.querySelector('#chatbot-file-input');

            if (input) {
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.send();
                });
            }
            if (fileInput) {
                fileInput.addEventListener('change', (e) => this.handleFileUpload(e));
            }
        }

        addMessage(sender, text) {
            this.state.messages.push({ sender, text, timestamp: new Date() });
            this.render();
            this.scrollToBottom();
        }

        startReportIssue() {
            this.addMessage('user', '🛠 Open a support ticket');
            this.state.currentStep = 'description';
            this.addMessage('bot', 'Please describe the issue you\'re experiencing in detail:');
        }

        handleNewTicketResponse(response) {
            if (response === 'yes') {
                this.addMessage('user', '✅ Yes, create another ticket');
                this.state.ticketData = this.initTicketData();
                this.state.uploadedImages = [];
                this.state.currentStep = 'description';
                this.addMessage('bot', 'Please describe the issue you\'re experiencing in detail:');
            } else {
                this.addMessage('bot', 'Thank you for using our support system! Feel free to reach out anytime. 👋');
                this.state.currentStep = 'closed';
            }
        }

        async reportDetectedError() {
            if (!this.state.pendingError) return;

            this.addMessage('user', '🐛 Report This Error');
            this.addMessage('bot', '📝 Submitting error report...');

            const error = this.state.pendingError;
            const errorSignature = `${error.type}-${error.message}`;

            // Mark as reported to prevent duplicate auto-reports
            this.state.autoReportedErrors.push(errorSignature);

            // Build error description
            const errorDescription = this.buildErrorDescription(error);

            // Create ticket with default values
            const errorTicketData = {
                ...this.config.autoReportDefaults,
                description: errorDescription,
                images: [],
                errors: [error],
                metadata: {
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    timestamp: new Date().toISOString(),
                    sessionId: this.state.sessionId,
                    userReported: true
                }
            };

            try {
                const formData = new FormData();
                for (const key in errorTicketData) {
                    if (key !== 'images' && key !== 'errors') {
                        formData.append(key, typeof errorTicketData[key] === 'object' ?
                            JSON.stringify(errorTicketData[key]) : errorTicketData[key]);
                    }
                }
                const url = `${this.config.apiBaseUrl}${this.config.endpoints.createTicket}`;
                const response = await fetch(url, {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();
                this.addMessage('bot', `✅ Error reported successfully as ticket #${result.ticketId}. Our team will investigate this issue.`);

                if (this.config.onTicketCreated) {
                    this.config.onTicketCreated(ticketId, errorTicketData);
                }

                // Clear the pending error
                this.state.pendingError = null;
                this.state.detectedErrors = [];
                this.updateErrorBadge();

                // Reset to greeting after 3 seconds
                setTimeout(() => {
                    this.state.currentStep = 'greeting';
                    this.render();
                }, 3000);

            } catch (error) {
                console.error('Error report failed:', error);
                this.addMessage('bot', '❌ Failed to submit error report. Please try again.');
                this.state.currentStep = 'error_detected';
            }
        }

        dismissError() {
            this.addMessage('user', '❌ Dismiss');
            this.addMessage('bot', 'Okay, I\'ve dismissed this error. Let me know if you need anything else!');
            this.state.pendingError = null;
            this.state.currentStep = 'greeting';
            this.render();
        }

        selectContactOption(option) {
            if (option === 'provide') {
                this.addMessage('user', '✅ Yes, I\'ll provide my email');
                this.state.currentStep = 'contact';
                this.addMessage('bot', 'Please provide your email address:');
            } else {
                this.addMessage('user', '⏭️ Skip (submit anonymously)');
                this.state.ticketData.contactDetails = 'Anonymous';
                this.state.currentStep = 'confirmation';
                this.addMessage('bot', 'Perfect! Review your ticket and click Submit when ready.');
            }
        }

        send() {
            const input = this.container?.querySelector('#chatbot-input');
            const message = input?.value.trim();
            if (!message) return;

            this.addMessage('user', message);
            input.value = '';

            if (this.state.currentStep === 'description') {
                this.state.ticketData.description = message;
                this.state.currentStep = 'impact';
                this.addMessage('bot', 'Thanks! Now, who is affected by this issue?');
            } else if (this.state.currentStep === 'contact') {
                this.state.ticketData.contactDetails = message;
                this.state.currentStep = 'confirmation';
                this.addMessage('bot', 'Perfect! Review your ticket and click Submit when ready.');
            }
        }

        selectOption(step, value) {
            this.state.ticketData[step] = value;
            this.addMessage('user', value);

            const nextSteps = {
                category: { next: 'contact_prompt', msg: 'Would you like to provide your email address for follow-up?' },
                impact: { next: 'urgency', msg: 'How urgent is this issue for you?' },
                urgency: { next: 'priority', msg: 'What priority level would you assign?' },
                priority: { next: 'category', msg: 'Please select the category:' }
            };

            if (nextSteps[step]) {
                this.state.currentStep = nextSteps[step].next;
                this.addMessage('bot', nextSteps[step].msg);
            }
        }

        handleFileUpload(event) {
            const files = Array.from(event.target.files);
            if (!files || files.length === 0) return;

            const totalFiles = this.state.uploadedImages.length + files.length;
            if (totalFiles > this.config.maxFiles) {
                this.addMessage('bot', `❌ Too many files. Maximum ${this.config.maxFiles} files allowed.`);
                event.target.value = '';
                return;
            }

            files.forEach(file => {
                if (!this.config.allowedFileTypes.includes(file.type)) {
                    this.addMessage('bot', `❌ File type not allowed: ${file.name}`);
                    return;
                }
                if (file.size > this.config.maxFileSize) {
                    const maxMB = (this.config.maxFileSize / 1024 / 1024).toFixed(1);
                    this.addMessage('bot', `❌ File too large: ${file.name} (max ${maxMB}MB)`);
                    return;
                }
                this.state.ticketData.images.push(file);
                const reader = new FileReader();
                reader.onload = (e) => {
                    this.state.uploadedImages.push({
                        name: file.name, type: file.type, size: file.size,
                        data: e.target.result, uploadedAt: new Date().toISOString()
                    });
                    this.render();
                };
                reader.readAsDataURL(file);
            });
            event.target.value = '';
        }

        async captureScreenshot() {
            if (typeof html2canvas === 'undefined') {
                await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
            }

            try {
                await new Promise(resolve => setTimeout(resolve, 500));

                const canvas = await html2canvas(document.body, {
                    allowTaint: true, useCORS: true, backgroundColor: '#ffffff',
                    scale: 2, logging: false
                });

                canvas.toBlob((blob) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        if (this.state.uploadedImages.length >= this.config.maxFiles) {
                            this.addMessage('bot', `❌ Maximum ${this.config.maxFiles} files reached.`);
                            return;
                        }

                        const fileName = e.fileName;

                        this.state.uploadedImages.push({
                            name: fileName, type: 'image/png', size: blob.size,
                            data: e.target.result, isScreenshot: true, uploadedAt: new Date().toISOString()
                        });
                        this.state.ticketData.images.push({
                            name: fileName, type: 'image/png', size: blob.size,
                            data: e.target.result, isScreenshot: true
                        });

                        this.render();
                    };
                    reader.readAsDataURL(blob);
                }, 'image/png');
            } catch (error) {
                this.addMessage('bot', `❌ Failed to capture screenshot: ${error.message}`);
            }
        }

        loadScript(src) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        removeImage(index) {
            this.state.uploadedImages.splice(index, 1);
            this.state.ticketData.images.splice(index, 1);
            this.render();
        }

        async submitTicket() {
            if (!this.state.ticketData.description || this.state.ticketData.description.trim() === '') {
                this.addMessage('bot', '❌ Cannot submit ticket without a description.');
                return;
            }

            this.addMessage('bot', '📝 Creating your ticket...');
            const submitButton = this.container?.querySelector('.submit-button');
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.innerHTML = '<div class="loader"></div> Submitting...';
            }

            try {
                const formData = new FormData();
                for (const key in this.state.ticketData) {
                    const value = this.state.ticketData[key];

                    if (value === null || value === undefined) continue;

                    if (key === 'images') continue;

                    // Enums / numbers / strings
                    if (typeof value === 'string' || typeof value === 'number') {
                        formData.append(key, value.toString());
                    }
                    // Objects (metadata, errors, etc.)
                    else if (typeof value === 'object') {
                        formData.append(key, JSON.stringify(value));
                    }
                }
                debugger;
                // Files MUST be appended separately
                this.state.ticketData.images?.forEach((file) => {
                    formData.append('files', file, file.name);
                });
                const url = `${this.config.apiBaseUrl}${this.config.endpoints.createTicket}`;
                const response = await fetch(url, { method: 'POST', body: formData });
                const result = await response.json();

                this.addMessage('bot', `✅ Success! Your ticket #${result.ticketId} has been created.`);

                if (this.config.onTicketCreated) {
                    this.config.onTicketCreated(ticketId, this.state.ticketData);
                }

                setTimeout(() => {
                    this.state.ticketData = this.initTicketData();
                    this.state.uploadedImages = [];
                    this.state.detectedErrors = [];
                    this.state.currentStep = 'new_ticket_prompt';
                    this.addMessage('bot', 'Would you like to create another support ticket?');
                    this.updateErrorBadge();
                    this.render();
                }, 3000);

            } catch (error) {
                console.error('Ticket submission error:', error);
                this.addMessage('bot', '❌ Sorry, there was an error creating your ticket.');

                if (this.config.onError) this.config.onError(error);
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20 6L9 17l-5-5"/></svg> Submit Ticket';
                }
            }
        }

        toggle() {
            this.state.isOpen = !this.state.isOpen;
            if (this.state.isOpen) {
                if (this.state.messages.length === 0) {
                    this.addMessage('bot', `👋 Hello! I'm ${this.config.chatbotName}. How can I help you today?`);
                }
                if (this.config.onOpen) this.config.onOpen();
            } else {
                if (this.config.onClose) this.config.onClose();
            }
            this.render();
        }

        open() {
            if (!this.state.isOpen) this.toggle();
        }

        close() {
            if (this.state.isOpen) this.toggle();
        }

        render() {
            if (this.container) {
                this.container.innerHTML = this.renderChatbot();
                this.attachEventListeners();
                this.updateErrorBadge();
            }
        }

        scrollToBottom() {
            setTimeout(() => {
                const messagesDiv = this.container?.querySelector('#chatbot-messages');
                if (messagesDiv) {
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
            }, 100);
        }

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        formatTime(date) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        destroy() {
            if (this.container) this.container.remove();
        }
    }

    window.SupportChatbot = SupportChatbot;
    if (window.chatbotConfig) {
        window.supportChatbot = new SupportChatbot(window.chatbotConfig);
    }

})(window);