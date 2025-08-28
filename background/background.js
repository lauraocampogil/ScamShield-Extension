// ScamShield Background Script - Service Worker
class ScamShieldBackground {
	constructor() {
		this.setupEventListeners();
		this.supportedSites = ["linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com"];
	}

	setupEventListeners() {
		// Cuando se hace clic en el icono de la extensión, abrir sidepanel
		chrome.action.onClicked.addListener((tab) => {
			this.toggleSidePanel(tab.id);
		});

		// Escuchar cambios de pestañas para habilitar/deshabilitar sidepanel
		chrome.tabs.onActivated.addListener(async (activeInfo) => {
			await this.updateSidePanelState(activeInfo.tabId);
		});

		chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
			if (changeInfo.status === "complete") {
				await this.updateSidePanelState(tabId);
			}
		});

		// Escuchar mensajes del content script
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			this.handleMessage(message, sender, sendResponse);
			return true; // Para respuestas asíncronas
		});

		// Configurar sidepanel al instalar
		chrome.runtime.onInstalled.addListener(() => {
			this.onInstalled();
		});

		// Configurar sidepanel al iniciar
		chrome.runtime.onStartup.addListener(() => {
			this.onStartup();
		});
	}

	async toggleSidePanel(tabId) {
		try {
			// Abrir sidepanel para la pestaña actual
			await chrome.sidePanel.open({
				tabId: tabId,
			});

			// Notificar al sidepanel sobre la pestaña activa
			setTimeout(() => {
				chrome.runtime
					.sendMessage({
						action: "tabActivated",
						tabId: tabId,
					})
					.catch(() => {}); // Ignorar errores si sidepanel no está listo
			}, 100);
		} catch (error) {
			console.error("Error abriendo sidepanel:", error);
		}
	}

	async updateSidePanelState(tabId) {
		try {
			const tab = await chrome.tabs.get(tabId);
			const isSupported = this.isSupportedSite(tab.url);

			if (isSupported) {
				// Habilitar para sitios compatibles
				await chrome.sidePanel.setOptions({
					tabId: tabId,
					enabled: true,
					path: "sidepanel/sidepanel.html",
				});

				// Actualizar ícono para mostrar que está activo
				chrome.action.setIcon({
					tabId: tabId,
					path: {
						16: "assets/icons/icon16-active.png",
						32: "assets/icons/icon32-active.png",
						48: "assets/icons/icon48-active.png",
						128: "assets/icons/icon128-active.png",
					},
				});

				chrome.action.setTitle({
					tabId: tabId,
					title: "ScamShield - Click para abrir panel",
				});
			} else {
				// Deshabilitar para sitios no compatibles
				await chrome.sidePanel.setOptions({
					tabId: tabId,
					enabled: false,
				});

				chrome.action.setIcon({
					tabId: tabId,
					path: {
						16: "assets/icons/icon16-inactive.png",
						32: "assets/icons/icon32-inactive.png",
						48: "assets/icons/icon48-inactive.png",
						128: "assets/icons/icon128-inactive.png",
					},
				});

				chrome.action.setTitle({
					tabId: tabId,
					title: "ScamShield - No disponible en esta página",
				});
			}

			// Notificar al sidepanel sobre el cambio de pestaña
			chrome.runtime
				.sendMessage({
					action: "tabChanged",
					tabId: tabId,
					isSupported: isSupported,
					url: tab.url,
				})
				.catch(() => {}); // Ignorar si sidepanel no está abierto
		} catch (error) {
			console.error("Error actualizando estado del sidepanel:", error);
		}
	}

	isSupportedSite(url) {
		if (!url) return false;
		return this.supportedSites.some((site) => url.includes(site));
	}

	async handleMessage(message, sender, sendResponse) {
		try {
			switch (message.action) {
				case "jobDetected":
					await this.handleJobDetected(message.data, sender.tab?.id);
					break;

				case "analysisComplete":
					await this.handleAnalysisComplete(message.data, sender.tab?.id);
					break;

				case "scamReported":
					await this.handleScamReport(message.data);
					break;

				case "getSidePanelData":
					const data = await this.getSidePanelData(sender.tab?.id);
					sendResponse(data);
					break;

				case "openSidePanel":
					await this.toggleSidePanel(sender.tab?.id);
					break;

				default:
					console.warn("Acción no reconocida:", message.action);
			}
		} catch (error) {
			console.error("Error manejando mensaje:", error);
			sendResponse({ error: error.message });
		}
	}

	async handleJobDetected(jobData, tabId) {
		// Incrementar contador de trabajos detectados
		const stats = await this.getStats();
		stats.jobsDetected = (stats.jobsDetected || 0) + 1;
		await this.saveStats(stats);

		// Notificar al sidepanel
		chrome.runtime
			.sendMessage({
				action: "jobDetectedUpdate",
				data: { jobData, stats },
				tabId: tabId,
			})
			.catch(() => {});
	}

	async handleAnalysisComplete(analysisData, tabId) {
		// Guardar análisis en storage local
		await this.saveAnalysis(analysisData);

		// Actualizar estadísticas
		const stats = await this.getStats();
		if (analysisData.risk > 0.6) {
			stats.scamsBlocked = (stats.scamsBlocked || 0) + 1;
			stats.timeSaved = (stats.timeSaved || 0) + 5; // 5 minutos ahorrados por estafa
		}
		stats.jobsScanned = (stats.jobsScanned || 0) + 1;
		await this.saveStats(stats);

		// Notificar al sidepanel
		chrome.runtime
			.sendMessage({
				action: "analysisCompleteUpdate",
				data: { analysis: analysisData, stats },
				tabId: tabId,
			})
			.catch(() => {});

		// Si es una estafa de alto riesgo, mostrar notificación
		if (analysisData.risk > 0.8) {
			chrome.notifications.create({
				type: "basic",
				iconUrl: "assets/icons/icon48.png",
				title: "🚨 ScamShield Alert",
				message: `Estafa de alto riesgo detectada: ${analysisData.jobTitle || "Trabajo"}`,
			});
		}
	}

	async handleScamReport(reportData) {
		// Enviar reporte al backend
		try {
			await fetch("https://api.scamshield.com/api/v1/report", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${await this.getApiKey()}`,
				},
				body: JSON.stringify(reportData),
			});

			chrome.notifications.create({
				type: "basic",
				iconUrl: "assets/icons/icon48.png",
				title: "✅ Reporte Enviado",
				message: "Gracias por reportar esta estafa",
			});
		} catch (error) {
			console.error("Error enviando reporte:", error);
		}
	}

	async getSidePanelData(tabId) {
		const [stats, analyses, settings] = await Promise.all([this.getStats(), this.getRecentAnalyses(), this.getSettings()]);

		let currentTab = null;
		if (tabId) {
			try {
				currentTab = await chrome.tabs.get(tabId);
			} catch (error) {
				console.warn("No se pudo obtener información de la pestaña:", error);
			}
		}

		return {
			stats,
			analyses,
			settings,
			currentTab: currentTab
				? {
						id: currentTab.id,
						url: currentTab.url,
						title: currentTab.title,
						isSupported: this.isSupportedSite(currentTab.url),
				  }
				: null,
		};
	}

	async getStats() {
		return new Promise((resolve) => {
			chrome.storage.local.get(["stats"], (result) => {
				resolve(
					result.stats || {
						scamsBlocked: 0,
						jobsScanned: 0,
						timeSaved: 0,
						jobsDetected: 0,
					}
				);
			});
		});
	}

	async saveStats(stats) {
		return new Promise((resolve) => {
			chrome.storage.local.set({ stats }, resolve);
		});
	}

	async saveAnalysis(analysis) {
		return new Promise((resolve) => {
			chrome.storage.local.get(["analyses"], (result) => {
				const analyses = result.analyses || {};
				const jobId = analysis.jobId || `job_${Date.now()}`;
				analyses[jobId] = {
					...analysis,
					timestamp: Date.now(),
				};

				// Mantener solo los últimos 100 análisis
				const entries = Object.entries(analyses);
				if (entries.length > 100) {
					const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
					const limited = Object.fromEntries(sorted.slice(0, 100));
					chrome.storage.local.set({ analyses: limited }, resolve);
				} else {
					chrome.storage.local.set({ analyses }, resolve);
				}
			});
		});
	}

	async getRecentAnalyses() {
		return new Promise((resolve) => {
			chrome.storage.local.get(["analyses"], (result) => {
				const analyses = result.analyses || {};
				const recent = Object.entries(analyses)
					.sort((a, b) => b[1].timestamp - a[1].timestamp)
					.slice(0, 10)
					.map(([id, analysis]) => ({ id, ...analysis }));
				resolve(recent);
			});
		});
	}

	async getSettings() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(["settings"], (result) => {
				resolve(
					result.settings || {
						enabled: true,
						showBadges: true,
						sensitivity: "medium",
						notifications: true,
					}
				);
			});
		});
	}

	async getApiKey() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(["apiKey"], (result) => {
				resolve(result.apiKey || "demo-key");
			});
		});
	}

	onInstalled() {
		console.log("🛡️ ScamShield instalado");

		// Configurar sidepanel por defecto
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

		// Mostrar página de bienvenida
		chrome.tabs.create({
			url: chrome.runtime.getURL("welcome.html"),
		});
	}

	onStartup() {
		console.log("🛡️ ScamShield iniciado");
	}
}

// Inicializar el background script
new ScamShieldBackground();
