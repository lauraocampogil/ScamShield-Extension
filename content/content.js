// ScamShield Content Script - Detector principal
class ScamShieldDetector {
	constructor() {
		this.isActive = true;
		this.scannedJobs = new Set();
		this.observer = null;
		this.apiBase = "https://api.scamshield.com/v1";
		this.currentSite = this.detectSite();

		this.init();
	}

	init() {
		console.log("🛡️ ScamShield activado en:", this.currentSite);
		this.loadSettings();
		this.setupObserver();
		this.scanExistingJobs();
		this.injectStyles();
		this.setupMessageListener(); // Agregar esto

		// Notificar al background que se activó en esta página
		chrome.runtime.sendMessage({
			action: "contentScriptLoaded",
			site: this.currentSite,
		});
	}

	detectSite() {
		const hostname = window.location.hostname.toLowerCase();
		if (hostname.includes("linkedin")) return "linkedin";
		if (hostname.includes("indeed")) return "indeed";
		if (hostname.includes("glassdoor")) return "glassdoor";
		if (hostname.includes("ziprecruiter")) return "ziprecruiter";
		return "unknown";
	}

	// Configurar observer para detectar nuevos jobs que se cargan dinámicamente
	setupObserver() {
		const config = { childList: true, subtree: true };
		this.observer = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				if (mutation.type === "childList") {
					mutation.addedNodes.forEach((node) => {
						if (node.nodeType === Node.ELEMENT_NODE) {
							this.scanJobElement(node);
						}
					});
				}
			});
		});

		this.observer.observe(document.body, config);
	}

	// Escanear trabajos existentes al cargar la página
	scanExistingJobs() {
		const jobSelectors = this.getJobSelectors();
		const jobs = document.querySelectorAll(jobSelectors.join(", "));

		jobs.forEach((job) => this.scanJobElement(job));
	}

	// Obtener selectores CSS específicos por sitio
	getJobSelectors() {
		const selectors = {
			linkedin: [".job-card-container", ".jobs-search__job-card", ".job-card-list__entity-lockup"],
			indeed: [".jobsearch-SerpJobCard", ".slider_container .slider_item", "[data-jk]"],
			glassdoor: [".react-job-listing", ".jobListing", '[data-test="job-listing"]'],
			ziprecruiter: [".job_content", ".jobList-container article", "[data-job-id]"],
		};

		return selectors[this.currentSite] || [".job", ".listing", ".card"];
	}

	// Escanear un elemento específico de trabajo
	async scanJobElement(element) {
		try {
			const jobData = this.extractJobData(element);
			if (!jobData || this.scannedJobs.has(jobData.id)) return;

			this.scannedJobs.add(jobData.id);

			// Análisis local primero (rápido)
			const localRisk = this.performLocalAnalysis(jobData);

			if (localRisk.risk > 0) {
				this.showWarningBadge(element, localRisk);
			}

			// Análisis con IA (más lento pero más preciso)
			const aiAnalysis = await this.performAIAnalysis(jobData);
			this.updateJobRiskDisplay(element, aiAnalysis);
		} catch (error) {
			console.error("Error escaneando trabajo:", error);
		}
	}

	// Extraer datos del trabajo según el sitio
	extractJobData(element) {
		const extractors = {
			linkedin: this.extractLinkedInJobData,
			indeed: this.extractIndeedJobData,
			glassdoor: this.extractGlassdoorJobData,
			ziprecruiter: this.extractZipRecruiterJobData,
		};

		const extractor = extractors[this.currentSite] || this.extractGenericJobData;
		return extractor.call(this, element);
	}

	extractLinkedInJobData(element) {
		return {
			id: element.dataset.jobId || this.generateJobId(element),
			title: this.getTextContent(element, ".job-card-list__title, .t-16"),
			company: this.getTextContent(element, ".job-card-container__company-name, .t-14"),
			location: this.getTextContent(element, ".job-card-container__metadata-item, .tvm__text"),
			description: this.getTextContent(element, ".job-card-list__job-description"),
			salary: this.getTextContent(element, ".job-card-container__salary-info"),
			url: this.getLinkHref(element, "a"),
			postedTime: this.getTextContent(element, ".job-card-container__listed-time"),
			site: "linkedin",
		};
	}

	extractIndeedJobData(element) {
		return {
			id: element.dataset.jk || this.generateJobId(element),
			title: this.getTextContent(element, '[data-testid="job-title"], .jobTitle'),
			company: this.getTextContent(element, '[data-testid="company-name"], .companyName'),
			location: this.getTextContent(element, '[data-testid="job-location"], .companyLocation'),
			description: this.getTextContent(element, ".job-snippet"),
			salary: this.getTextContent(element, ".salary-snippet"),
			url: this.getLinkHref(element, '[data-testid="job-title"] a, .jobTitle a'),
			postedTime: this.getTextContent(element, ".date"),
			site: "indeed",
		};
	}

	extractGenericJobData(element) {
		return {
			id: this.generateJobId(element),
			title: this.getTextContent(element, "h1, h2, h3, .title, .job-title"),
			company: this.getTextContent(element, ".company, .employer, .company-name"),
			location: this.getTextContent(element, ".location, .place, .address"),
			description: this.getTextContent(element, ".description, .summary, .content"),
			salary: this.getTextContent(element, ".salary, .pay, .wage"),
			url: this.getLinkHref(element, "a"),
			postedTime: this.getTextContent(element, ".date, .time, .posted"),
			site: this.currentSite,
		};
	}

	// Utilidades para extraer texto
	getTextContent(element, selector) {
		const found = element.querySelector(selector);
		return found ? found.textContent.trim() : "";
	}

	getLinkHref(element, selector) {
		const found = element.querySelector(selector);
		return found ? found.href : "";
	}

	generateJobId(element) {
		return btoa(element.innerText.substring(0, 100)).replace(/[^a-zA-Z0-9]/g, "");
	}

	// Análisis local básico (patrones conocidos)
	performLocalAnalysis(jobData) {
		const risk = { score: 0, flags: [], risk: 0 };

		// Patrones de texto sospechosos
		const suspiciousPatterns = [/work from home.*\$\d{3,4}.*week/i, /no experience.*high pay/i, /urgent.*immediate start/i, /pay.*training fee/i, /western union.*money transfer/i, /package forwarding/i, /mystery shopper/i];

		suspiciousPatterns.forEach((pattern) => {
			if (pattern.test(jobData.description) || pattern.test(jobData.title)) {
				risk.score += 30;
				risk.flags.push("Patrón de texto sospechoso detectado");
			}
		});

		// Verificar salario irreal
		if (jobData.salary) {
			const salaryNumbers = jobData.salary.match(/\$(\d+)/g);
			if (salaryNumbers) {
				const maxSalary = Math.max(...salaryNumbers.map((s) => parseInt(s.replace("$", ""))));
				if (maxSalary > 200) {
					// Por hora
					risk.score += 20;
					risk.flags.push("Salario potencialmente irreal");
				}
			}
		}

		// Verificar empresa genérica
		const genericCompanies = ["hiring now", "work from home", "remote work", "online jobs"];
		if (genericCompanies.some((generic) => jobData.company.toLowerCase().includes(generic))) {
			risk.score += 25;
			risk.flags.push("Nombre de empresa genérico");
		}

		risk.risk = Math.min(risk.score / 100, 1);
		return risk;
	}

	// Análisis con IA (llamada al backend)
	async performAIAnalysis(jobData) {
		try {
			const response = await fetch(`${this.apiBase}/analyze`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${await this.getApiKey()}`,
				},
				body: JSON.stringify({
					job: jobData,
					timestamp: Date.now(),
				}),
			});

			if (!response.ok) {
				throw new Error(`API Error: ${response.status}`);
			}

			const analysis = await response.json();

			// Guardar análisis para métricas
			this.saveAnalysisResult(jobData.id, analysis);

			return analysis;
		} catch (error) {
			console.warn("Error en análisis IA:", error);
			return { risk: 0, confidence: 0, flags: [] };
		}
	}

	// Mostrar badge de advertencia
	showWarningBadge(element, analysis) {
		// Evitar duplicados
		if (element.querySelector(".scam-shield-badge")) return;

		const badge = document.createElement("div");
		badge.className = "scam-shield-badge";
		badge.dataset.risk = analysis.risk;

		const riskLevel = analysis.risk > 0.7 ? "high" : analysis.risk > 0.4 ? "medium" : "low";
		badge.classList.add(`risk-${riskLevel}`);

		badge.innerHTML = `
      <div class="badge-content">
        <span class="shield-icon">🛡️</span>
        <span class="risk-text">${this.getRiskText(riskLevel)}</span>
        <span class="info-icon" title="${analysis.flags.join(", ")}">ℹ️</span>
      </div>
    `;

		// Posicionar badge
		element.style.position = "relative";
		element.appendChild(badge);

		// Event listener para mostrar detalles - notificar al sidepanel
		badge.addEventListener("click", (e) => {
			e.stopPropagation();
			chrome.runtime.sendMessage({
				action: "openSidePanel",
			});

			// Esperar un poco y luego mostrar análisis
			setTimeout(() => {
				chrome.runtime.sendMessage({
					action: "showDetailedAnalysis",
					data: analysis,
				});
			}, 500);
		});
	}

	// Actualizar display con análisis completo
	updateJobRiskDisplay(element, analysis) {
		const existingBadge = element.querySelector(".scam-shield-badge");
		if (existingBadge) {
			// Actualizar badge existente con datos de IA
			this.updateBadgeWithAI(existingBadge, analysis);
		}

		// Notificar al background script sobre análisis completo
		chrome.runtime.sendMessage({
			action: "analysisComplete",
			data: analysis,
		});
	}

	getRiskText(level) {
		const texts = {
			high: "ALTO RIESGO",
			medium: "RIESGO MEDIO",
			low: "VERIFICADO",
		};
		return texts[level] || "DESCONOCIDO";
	}

	// Actualizar display con análisis completo
	updateJobRiskDisplay(element, analysis) {
		const existingBadge = element.querySelector(".scam-shield-badge");
		if (existingBadge) {
			// Actualizar badge existente con datos de IA
			this.updateBadgeWithAI(existingBadge, analysis);
		}
	}

	updateBadgeWithAI(badge, analysis) {
		const riskLevel = analysis.risk > 0.7 ? "high" : analysis.risk > 0.4 ? "medium" : "low";

		// Actualizar clases CSS
		badge.className = "scam-shield-badge";
		badge.classList.add(`risk-${riskLevel}`);
		badge.dataset.risk = analysis.risk;
		badge.dataset.confidence = analysis.confidence;

		// Actualizar contenido si es necesario
		const riskText = badge.querySelector(".risk-text");
		if (riskText) {
			riskText.textContent = this.getRiskText(riskLevel);
		}
	}

	// Inyectar estilos CSS
	injectStyles() {
		if (document.querySelector("#scam-shield-styles")) return;

		const styles = document.createElement("style");
		styles.id = "scam-shield-styles";
		styles.textContent = `
      .scam-shield-badge {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 1000;
        background: white;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: bold;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        cursor: pointer;
        transition: all 0.3s ease;
      }
      
      .scam-shield-badge.risk-high {
        background: #ff4757;
        color: white;
        border: 2px solid #ff3838;
      }
      
      .scam-shield-badge.risk-medium {
        background: #ffa502;
        color: white;
        border: 2px solid #ff9500;
      }
      
      .scam-shield-badge.risk-low {
        background: #2ed573;
        color: white;
        border: 2px solid #20bf6b;
      }
      
      .scam-shield-badge:hover {
        transform: scale(1.05);
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      }
      
      .badge-content {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      .shield-icon {
        font-size: 14px;
      }
      
      .info-icon {
        opacity: 0.8;
        cursor: help;
      }
    `;

		document.head.appendChild(styles);
	}

	// Escuchar mensajes del background script
	setupMessageListener() {
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			switch (message.action) {
				case "rescan":
					this.scanExistingJobs();
					sendResponse({ success: true });
					break;
				case "settingsUpdated":
					this.settings = message.settings;
					this.applySettings();
					break;
				case "showDetailedAnalysis":
					// Ya no necesario, se maneja en el sidepanel
					break;
			}
			return true;
		});
	}

	applySettings() {
		// Aplicar configuraciones actualizadas
		const badges = document.querySelectorAll(".scam-shield-badge");
		badges.forEach((badge) => {
			badge.style.display = this.settings.showBadges ? "block" : "none";
		});
	}

	// Remover método showDetailedAnalysis ya que ahora se maneja en el sidepanel

	// Utilidades de storage y API
	async getApiKey() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(["apiKey"], (result) => {
				resolve(result.apiKey || "demo-key");
			});
		});
	}

	async loadSettings() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(["settings"], (result) => {
				this.settings = result.settings || {
					enabled: true,
					sensitivity: "medium",
					showBadges: true,
				};
				resolve();
			});
		});
	}

	saveAnalysisResult(jobId, analysis) {
		chrome.storage.local.get(["analyses"], (result) => {
			const analyses = result.analyses || {};
			analyses[jobId] = {
				...analysis,
				timestamp: Date.now(),
			};

			// Mantener solo los últimos 1000 análisis
			const entries = Object.entries(analyses);
			if (entries.length > 1000) {
				const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
				const limited = Object.fromEntries(sorted.slice(0, 1000));
				chrome.storage.local.set({ analyses: limited });
			} else {
				chrome.storage.local.set({ analyses });
			}
		});
	}
}

// Inicializar cuando el DOM esté listo
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", () => new ScamShieldDetector());
} else {
	new ScamShieldDetector();
}
