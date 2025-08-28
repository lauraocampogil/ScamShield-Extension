// ScamShield Sidepanel Logic
class ScamShieldSidepanel {
	constructor() {
		this.currentTab = null;
		this.stats = { scamsBlocked: 0, jobsScanned: 0, timeSaved: 0 };
		this.analyses = [];
		this.settings = {};
		this.activityFeed = [];
		this.isScanning = false;

		this.init();
	}

	async init() {
		console.log("🛡️ ScamShield initialized");

		await this.loadInitialData();
		this.setupEventListeners();
		this.setupMessageListeners();
		this.updateUI();
		this.startActivityUpdates();
	}

	async loadInitialData() {
		try {
			// Obtener datos del background script
			const response = await chrome.runtime.sendMessage({
				action: "getSidePanelData",
			});

			if (response) {
				this.stats = response.stats || this.stats;
				this.analyses = response.analyses || [];
				this.settings = response.settings || {};
				this.currentTab = response.currentTab;
			}
		} catch (error) {
			console.error("Error loading initial data:", error);
		}
	}

	setupEventListeners() {
		// Botón de escaneo
		document.getElementById("scanBtn").addEventListener("click", () => {
			this.scanCurrentPage();
		});

		// Toggles de secciones
		document.getElementById("activityToggle").addEventListener("click", () => {
			this.toggleSection("activity");
		});

		document.getElementById("settingsToggle").addEventListener("click", () => {
			this.toggleSection("settings");
		});

		// Settings
		document.getElementById("enableBadges").addEventListener("change", (e) => {
			this.updateSetting("showBadges", e.target.checked);
		});

		document.getElementById("sensitivityLevel").addEventListener("change", (e) => {
			this.updateSetting("sensitivity", e.target.value);
		});

		document.getElementById("enableNotifications").addEventListener("change", (e) => {
			this.updateSetting("notifications", e.target.checked);
		});

		document.getElementById("autoScan").addEventListener("change", (e) => {
			this.updateSetting("autoScan", e.target.checked);
		});

		// Action cards
		document.getElementById("reportScamBtn").addEventListener("click", () => {
			this.openReportModal();
		});

		document.getElementById("viewStatsBtn").addEventListener("click", () => {
			this.openStatsModal();
		});

		document.getElementById("settingsBtn").addEventListener("click", () => {
			this.toggleSection("settings");
		});

		document.getElementById("helpBtn").addEventListener("click", () => {
			this.openHelp();
		});

		// Clear detections
		document.getElementById("clearDetections").addEventListener("click", () => {
			this.clearDetections();
		});

		// Upgrade button
		document.getElementById("upgradeBtn").addEventListener("click", () => {
			this.openUpgrade();
		});

		// Footer links
		document.getElementById("privacyLink").addEventListener("click", () => {
			chrome.tabs.create({ url: "https://scamshield.com/privacy" });
		});

		document.getElementById("termsLink").addEventListener("click", () => {
			chrome.tabs.create({ url: "https://scamshield.com/terms" });
		});

		document.getElementById("feedbackLink").addEventListener("click", () => {
			chrome.tabs.create({ url: "https://scamshield.com/feedback" });
		});

		// Modal close
		document.getElementById("closeModal").addEventListener("click", () => {
			this.closeModal();
		});

		// Click outside modal to close
		document.getElementById("analysisModal").addEventListener("click", (e) => {
			if (e.target === e.currentTarget) {
				this.closeModal();
			}
		});
	}

	setupMessageListeners() {
		// Escuchar mensajes del background script
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			switch (message.action) {
				case "tabChanged":
					this.handleTabChanged(message);
					break;
				case "jobDetectedUpdate":
					this.handleJobDetected(message.data);
					break;
				case "analysisCompleteUpdate":
					this.handleAnalysisComplete(message.data);
					break;
				case "activityUpdate":
					this.handleActivityUpdate(message.data);
					break;
			}
		});
	}

	handleTabChanged(message) {
		this.currentTab = {
			id: message.tabId,
			url: message.url,
			isSupported: message.isSupported,
		};
		this.updateCurrentPageInfo();
	}

	handleJobDetected(data) {
		this.stats = data.stats;
		this.addActivityItem({
			type: "scanning",
			title: "Work detected",
			description: `Analyzing: ${data.jobData.title || "Job offer"}`,
			timestamp: Date.now(),
		});
		this.updateStats();
	}

	handleAnalysisComplete(data) {
		this.stats = data.stats;
		this.analyses.unshift({ id: Date.now().toString(), ...data.analysis });

		// Mantener solo últimas 50 detecciones
		if (this.analyses.length > 50) {
			this.analyses = this.analyses.slice(0, 50);
		}

		const riskLevel = data.analysis.risk > 0.7 ? "danger" : data.analysis.risk > 0.4 ? "warning" : "safe";

		this.addActivityItem({
			type: riskLevel,
			title: "Analysis completed",
			description: `${data.analysis.jobTitle || "Job"} - ${this.getRiskText(riskLevel)}`,
			timestamp: Date.now(),
		});

		this.updateStats();
		this.updateDetectionsList();
	}

	handleActivityUpdate(data) {
		this.addActivityItem(data);
	}

	addActivityItem(item) {
		this.activityFeed.unshift(item);

		// Mantener solo últimas 20 actividades
		if (this.activityFeed.length > 20) {
			this.activityFeed = this.activityFeed.slice(0, 20);
		}

		this.updateActivityFeed();
	}

	updateUI() {
		this.updateCurrentPageInfo();
		this.updateStats();
		this.updateDetectionsList();
		this.updateSettings();
		this.updateActivityFeed();
	}

	updateCurrentPageInfo() {
		const siteIcon = document.getElementById("siteIcon");
		const siteName = document.getElementById("siteName");
		const pageStatus = document.getElementById("pageStatus");
		const statusIndicator = document.getElementById("statusIndicator");
		const statusText = document.getElementById("statusText");

		if (!this.currentTab) {
			siteIcon.textContent = "🌐";
			siteName.textContent = "Detecting site...";
			pageStatus.textContent = "Loading page information";
			statusIndicator.className = "status-indicator";
			statusText.textContent = "Charging...";
			return;
		}

		const siteInfo = this.getSiteInfo(this.currentTab.url);
		siteIcon.textContent = siteInfo.icon;
		siteName.textContent = siteInfo.name;

		if (this.currentTab.isSupported) {
			pageStatus.textContent = `Active protection in ${siteInfo.name}`;
			statusIndicator.className = "status-indicator active";
			statusText.textContent = "Asset";
		} else {
			pageStatus.textContent = "Site not supported";
			statusIndicator.className = "status-indicator inactive";
			statusText.textContent = "Inactive";
		}
	}

	getSiteInfo(url) {
		if (!url) return { name: "Unknown page", icon: "🌐" };

		if (url.includes("linkedin.com")) return { name: "LinkedIn", icon: "💼" };
		if (url.includes("indeed.com")) return { name: "Indeed", icon: "🔍" };
		if (url.includes("glassdoor.com")) return { name: "Glassdoor", icon: "🏢" };
		if (url.includes("ziprecruiter.com")) return { name: "ZipRecruiter", icon: "📋" };

		return { name: "Web page", icon: "🌐" };
	}

	updateStats() {
		document.getElementById("scamsBlocked").textContent = this.stats.scamsBlocked || 0;
		document.getElementById("jobsScanned").textContent = this.stats.jobsScanned || 0;
		document.getElementById("timeSaved").textContent = `${this.stats.timeSaved || 0}min`;
	}

	updateDetectionsList() {
		const container = document.getElementById("detectionsList");
		const badge = document.getElementById("detectionsBadge");

		badge.textContent = this.analyses.length;

		if (this.analyses.length === 0) {
			container.innerHTML = `
        <div class="activity-placeholder">
          <div class="placeholder-icon">🛡️</div>
          <p>No recent detections</p>
          <small>ScamShield will alert you when it detects suspicious work</small>
        </div>
      `;
			return;
		}

		container.innerHTML = this.analyses
			.slice(0, 10)
			.map((analysis) => {
				const riskLevel = analysis.risk > 0.7 ? "high" : analysis.risk > 0.4 ? "medium" : "low";
				const riskIcon = this.getRiskIcon(riskLevel);
				const timeAgo = this.formatTimeAgo(analysis.timestamp);

				return `
        <div class="detection-item risk-${riskLevel}" onclick="sidepanel.showDetailedAnalysis('${analysis.id}')">
          <div class="detection-icon">${riskIcon}</div>
          <div class="detection-info">
            <div class="job-title">${analysis.jobTitle || "Work analyzed"}</div>
            <div class="company-name">${analysis.company || "Unknown company"}</div>
            <div class="detection-meta">
              <span class="risk-level ${riskLevel}">${this.getRiskText(riskLevel)}</span>
              <span class="time-ago">${timeAgo}</span>
            </div>
          </div>
        </div>
      `;
			})
			.join("");
	}

	updateActivityFeed() {
		const container = document.getElementById("activityFeed");

		if (this.activityFeed.length === 0) {
			container.innerHTML = `
        <div class="activity-placeholder">
          <div class="placeholder-icon">👁️</div>
          <p>Navigate to LinkedIn, Indeed or similar to view activity</p>
          <small>ScamShield will automatically analyze job offers</small>
        </div>
      `;
			return;
		}

		container.innerHTML = this.activityFeed
			.slice(0, 15)
			.map(
				(item) => `
      <div class="activity-item">
        <div class="activity-icon ${item.type}">
          ${this.getActivityIcon(item.type)}
        </div>
        <div class="activity-content">
          <div class="activity-title">${item.title}</div>
          <div class="activity-description">${item.description}</div>
        </div>
        <div class="activity-time">${this.formatTimeAgo(item.timestamp)}</div>
      </div>
    `
			)
			.join("");
	}

	updateSettings() {
		document.getElementById("enableBadges").checked = this.settings.showBadges !== false;
		document.getElementById("sensitivityLevel").value = this.settings.sensitivity || "medium";
		document.getElementById("enableNotifications").checked = this.settings.notifications !== false;
		document.getElementById("autoScan").checked = this.settings.autoScan !== false;
	}

	async scanCurrentPage() {
		if (this.isScanning) return;

		const scanBtn = document.getElementById("scanBtn");
		const scanBtnIcon = document.getElementById("scanBtnIcon");
		const scanBtnText = document.getElementById("scanBtnText");

		this.isScanning = true;
		scanBtn.disabled = true;
		scanBtnIcon.className = "loading";
		scanBtnText.textContent = "Scanning...";

		try {
			// Obtener pestaña activa
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

			if (!tab) {
				throw new Error("Could not get the active tab");
			}

			// Enviar mensaje al content script
			await chrome.tabs.sendMessage(tab.id, {
				action: "rescan",
			});

			this.addActivityItem({
				type: "scanning",
				title: "Manual scan started",
				description: "Analyzing current page...",
				timestamp: Date.now(),
			});

			// Simular progreso
			await new Promise((resolve) => setTimeout(resolve, 2000));

			this.addActivityItem({
				type: "safe",
				title: "Scanning completed",
				description: "Page successfully scanned",
				timestamp: Date.now(),
			});
		} catch (error) {
			console.error("Error scanning page:", error);

			this.addActivityItem({
				type: "warning",
				title: "Scanning error",
				description: error.message || "The page could not be scanned.",
				timestamp: Date.now(),
			});
		} finally {
			this.isScanning = false;
			scanBtn.disabled = false;
			scanBtnIcon.className = "";
			scanBtnIcon.textContent = "🔄";
			scanBtnText.textContent = "Scan";
		}
	}

	async updateSetting(key, value) {
		this.settings[key] = value;

		try {
			await chrome.storage.sync.set({ settings: this.settings });

			// Notificar al background script
			chrome.runtime.sendMessage({
				action: "settingsUpdated",
				settings: this.settings,
			});

			this.showNotification("Updated configuration", "success");
		} catch (error) {
			console.error("Error updating configuration:", error);
			this.showNotification("Error updating configuration", "error");
		}
	}

	toggleSection(sectionName) {
		const section = document.getElementById(`${sectionName}Section`);
		const toggle = document.getElementById(`${sectionName}Toggle`);

		if (section && toggle) {
			const isCollapsed = section.classList.contains("collapsed");

			if (isCollapsed) {
				section.classList.remove("collapsed");
				toggle.querySelector("span").textContent = "▼";
			} else {
				section.classList.add("collapsed");
				toggle.querySelector("span").textContent = "▶";
			}
		}
	}

	showDetailedAnalysis(analysisId) {
		const analysis = this.analyses.find((a) => a.id === analysisId);
		if (!analysis) return;

		const modal = document.getElementById("analysisModal");
		const modalBody = document.getElementById("modalBody");

		const riskLevel = analysis.risk > 0.7 ? "high" : analysis.risk > 0.4 ? "medium" : "low";
		const riskPercentage = Math.round(analysis.risk * 100);

		modalBody.innerHTML = `
      <div class="analysis-overview">
        <div class="risk-score risk-${riskLevel}">
          <div class="score-circle">
            <div class="score-value">${riskPercentage}%</div>
            <div class="score-label">Riesgo</div>
          </div>
        </div>
        <div class="risk-summary">
          <h4>${this.getRiskText(riskLevel)}</h4>
          <p class="confidence">Confianza: ${Math.round((analysis.confidence || 0.8) * 100)}%</p>
        </div>
      </div>

      <div class="analysis-details">
        <h4>Work Analyzed</h4>
        <div class="job-info">
          <p><strong>Title:</strong> ${analysis.jobTitle || "Not available"}</p>
          <p><strong>Company:</strong> ${analysis.company || "Not available"}</p>
          <p><strong>Location:</strong> ${analysis.location || "Not available"}</p>
          ${analysis.salary ? `<p><strong>Salary:</strong> ${analysis.salary}</p>` : ""}
        </div>

        <h4>Warning Signs Detected</h4>
        <div class="flags-list">
          ${
						(analysis.flags || [])
							.map(
								(flag) => `
            <div class="flag-item">
              <span class="flag-icon">🚩</span>
              <span class="flag-text">${flag}</span>
            </div>
          `
							)
							.join("") || '<p class="no-flags">No specific signals were detected</p>'
					}
        </div>

        <h4>AI Analysis</h4>
        <div class="ai-analysis">
          <p><strong>Text pattern:</strong> ${analysis.aiAnalysis?.textScore ? `${Math.round(analysis.aiAnalysis.textScore * 100)}% suspicious` : "Not analyzed"}</p>
          <p><strong>Company verification:</strong> ${analysis.aiAnalysis?.companyVerified ? "Verified ✅" : "Not verified ❌"}</p>
          <p><strong>Salary Analysis:</strong> ${analysis.aiAnalysis?.salaryRealistic ? "Realistic ✅" : "Doubtful ❌"}</p>
        </div>

        <h4>Recommendations</h4>
        <div class="recommendations">
          ${this.getRecommendations(riskLevel)
						.map(
							(rec) => `
            <div class="recommendation-item">
              <span class="rec-icon">${rec.icon}</span>
              <span class="rec-text">${rec.text}</span>
            </div>
          `
						)
						.join("")}
        </div>
      </div>

      <div class="modal-actions" style="display: flex; gap: 12px; margin-top: 20px;">
        <button class="btn-secondary" onclick="sidepanel.reportFalsePositive('${analysisId}')" style="flex: 1; padding: 10px; border: 1px solid #dee2e6; background: white; border-radius: 6px; cursor: pointer;">
          Report false positive
        </button>
        <button class="btn-primary" onclick="sidepanel.reportScam('${analysisId}')" style="flex: 1; padding: 10px; border: none; background: #667eea; color: white; border-radius: 6px; cursor: pointer;">
          Report as scam
        </button>
      </div>
    `;

		modal.classList.remove("hidden");
	}

	closeModal() {
		document.getElementById("analysisModal").classList.add("hidden");
	}

	clearDetections() {
		this.analyses = [];
		this.updateDetectionsList();

		chrome.storage.local.set({ analyses: {} });
		this.showNotification("Detections removed", "success");
	}

	openReportModal() {
		this.showNotification("Reporting feature coming soon", "info");
	}

	openStatsModal() {
		// Implementar modal de estadísticas detalladas
		this.showNotification("Detailed statistics coming soon", "info");
	}

	openHelp() {
		chrome.tabs.create({ url: "https://scamshield.com/help" });
	}

	openUpgrade() {
		chrome.tabs.create({ url: "https://scamshield.com/upgrade" });
	}

	reportScam(analysisId) {
		// Implementar reporte de estafa
		this.showNotification("Thank you for reporting this scam.", "success");
		this.closeModal();
	}

	reportFalsePositive(analysisId) {
		// Implementar reporte de falso positivo
		this.showNotification("Thank you for your feedback.", "success");
		this.closeModal();
	}

	// Utility methods
	getRiskIcon(level) {
		const icons = {
			high: "🚨",
			medium: "⚠️",
			low: "✅",
		};
		return icons[level] || "❓";
	}

	getRiskText(level) {
		const texts = {
			high: "High Risk",
			medium: "Medium Risk",
			low: "Sure",
			danger: "Dangerous",
			warning: "Caution",
			safe: "Sure",
		};
		return texts[level] || "Stranger";
	}

	getActivityIcon(type) {
		const icons = {
			scanning: "🔄",
			safe: "✅",
			warning: "⚠️",
			danger: "🚨",
		};
		return icons[type] || "📊";
	}

	formatTimeAgo(timestamp) {
		const now = Date.now();
		const diff = now - timestamp;
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (days > 0) return `${days}d`;
		if (hours > 0) return `${hours}h`;
		if (minutes > 0) return `${minutes}m`;
		return "now";
	}

	getRecommendations(riskLevel) {
		const recommendations = {
			high: [
				{ icon: "🚫", text: "Do NOT apply for this job" },
				{ icon: "📞", text: "Do NOT provide personal information" },
				{ icon: "💰", text: "Do NOT pay any fees" },
				{ icon: "🕵️", text: "Research the company independently" },
			],
			medium: [
				{ icon: "🔍", text: "Do more research before applying" },
				{ icon: "🏢", text: "Verify that the company exists" },
				{ icon: "📧", text: "Use a secondary email to apply" },
				{ icon: "❓", text: "Ask specific questions in the interview" },
			],
			low: [
				{ icon: "✅", text: "Work seems legitimate" },
				{ icon: "📋", text: "Review terms and conditions" },
				{ icon: "🤝", text: "Proceed with normal caution" },
			],
		};

		return recommendations[riskLevel] || recommendations.low;
	}

	showNotification(message, type = "info") {
		// Crear notificación temporal en la parte superior del sidepanel
		const notification = document.createElement("div");
		notification.className = `notification ${type}`;
		notification.style.cssText = `
      position: fixed;
      top: 70px;
      left: 8px;
      right: 8px;
      background: ${type === "success" ? "#d4edda" : type === "error" ? "#f8d7da" : "#d1ecf1"};
      color: ${type === "success" ? "#155724" : type === "error" ? "#721c24" : "#0c5460"};
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      z-index: 1001;
      transform: translateY(-100%);
      transition: transform 0.3s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
		notification.textContent = message;

		document.body.appendChild(notification);

		// Animación de entrada
		setTimeout(() => {
			notification.style.transform = "translateY(0)";
		}, 100);

		// Remover después de 3 segundos
		setTimeout(() => {
			notification.style.transform = "translateY(-100%)";
			setTimeout(() => notification.remove(), 300);
		}, 3000);
	}

	startActivityUpdates() {
		// Simular updates periódicas para demo
		setInterval(() => {
			if (this.currentTab?.isSupported && Math.random() < 0.1) {
				this.addActivityItem({
					type: "scanning",
					title: "Monitoring page",
					description: "Looking for new job offers...",
					timestamp: Date.now(),
				});
			}
		}, 30000); // Cada 30 segundos
	}
}

// Inicializar sidepanel cuando el DOM esté listo
let sidepanel;
document.addEventListener("DOMContentLoaded", () => {
	sidepanel = new ScamShieldSidepanel();
});

// Hacer disponible globalmente para onclick handlers
window.sidepanel = sidepanel;
