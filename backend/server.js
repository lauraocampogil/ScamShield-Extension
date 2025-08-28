// server.js - Servidor principal de ScamShield API
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const mongoose = require("mongoose");
const { OpenAI } = require("openai");
const redis = require("redis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de OpenAI
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

// Configuración de Redis para caché
const redisClient = redis.createClient({
	url: process.env.REDIS_URL || "redis://localhost:6379",
});

// Middlewares
app.use(helmet());
app.use(
	cors({
		origin: process.env.ALLOWED_ORIGINS?.split(",") || ["chrome-extension://*"],
		credentials: true,
	})
);
app.use(express.json({ limit: "10mb" }));

// Rate limiting
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
	max: 100, // máximo 100 requests por IP
	message: { error: "Demasiadas solicitudes, intenta más tarde" },
});
app.use("/api/", limiter);

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI, {
	useNewUrlParser: true,
	useUnifiedTopology: true,
});

// Modelos de datos
const JobAnalysis = mongoose.model("JobAnalysis", {
	jobId: { type: String, required: true, unique: true },
	title: String,
	company: String,
	location: String,
	description: String,
	salary: String,
	url: String,
	site: String,
	riskScore: { type: Number, required: true },
	confidence: { type: Number, required: true },
	flags: [String],
	aiAnalysis: {
		textScore: Number,
		companyVerified: Boolean,
		salaryRealistic: Boolean,
		patternMatches: [String],
	},
	timestamp: { type: Date, default: Date.now },
	userReports: {
		scamReports: { type: Number, default: 0 },
		falsePositives: { type: Number, default: 0 },
	},
});

const User = mongoose.model("User", {
	apiKey: { type: String, required: true, unique: true },
	email: String,
	plan: { type: String, enum: ["free", "pro", "enterprise"], default: "free" },
	usage: {
		dailyAnalyses: { type: Number, default: 0 },
		monthlyAnalyses: { type: Number, default: 0 },
		lastReset: { type: Date, default: Date.now },
	},
	created: { type: Date, default: Date.now },
});

// Middleware de autenticación
async function authenticateUser(req, res, next) {
	const apiKey = req.headers.authorization?.replace("Bearer ", "");

	if (!apiKey) {
		return res.status(401).json({ error: "API key requerida" });
	}

	try {
		const user = await User.findOne({ apiKey });
		if (!user) {
			return res.status(401).json({ error: "API key inválida" });
		}

		// Verificar límites según el plan
		const limits = {
			free: { daily: 50, monthly: 500 },
			pro: { daily: 1000, monthly: 10000 },
			enterprise: { daily: Infinity, monthly: Infinity },
		};

		const userLimit = limits[user.plan];
		if (user.usage.dailyAnalyses >= userLimit.daily) {
			return res.status(429).json({
				error: "Límite diario excedido",
				upgrade: user.plan === "free" ? "pro" : null,
			});
		}

		req.user = user;
		next();
	} catch (error) {
		res.status(500).json({ error: "Error de autenticación" });
	}
}

// Clase principal del detector IA
class ScamDetectorAI {
	constructor() {
		this.suspiciousPatterns = [
			/work from home.*\$\d{3,4}.*week/i,
			/no experience.*high pay/i,
			/urgent.*immediate start/i,
			/pay.*training fee/i,
			/western union.*money transfer/i,
			/package forwarding/i,
			/mystery shopper/i,
			/envelope stuffing/i,
			/data entry.*\$\d+.*hour/i,
			/earn.*\$\d+.*day.*guaranteed/i,
		];

		this.legitimateCompanyIndicators = [/\.com$/, /inc\.|llc|ltd\.|corp\./i, /founded in \d{4}/i, /headquarters/i, /employees/i];

		this.salaryRanges = {
			"entry-level": { min: 25000, max: 45000 },
			"mid-level": { min: 45000, max: 85000 },
			senior: { min: 75000, max: 150000 },
			executive: { min: 120000, max: 300000 },
		};
	}

	async analyzeJob(jobData) {
		try {
			// Análisis paralelo de múltiples aspectos
			const [textAnalysis, companyAnalysis, salaryAnalysis, aiAnalysis] = await Promise.all([this.analyzeJobText(jobData), this.verifyCompany(jobData.company), this.analyzeSalary(jobData.salary, jobData.title), this.performAIAnalysis(jobData)]);

			// Calcular score compuesto
			const riskScore = this.calculateCompositeRisk({
				textAnalysis,
				companyAnalysis,
				salaryAnalysis,
				aiAnalysis,
			});

			// Generar flags específicas
			const flags = this.generateFlags({
				textAnalysis,
				companyAnalysis,
				salaryAnalysis,
				aiAnalysis,
			});

			return {
				risk: riskScore,
				confidence: aiAnalysis.confidence || 0.8,
				flags,
				aiAnalysis: {
					textScore: textAnalysis.score,
					companyVerified: companyAnalysis.verified,
					salaryRealistic: salaryAnalysis.realistic,
					patternMatches: textAnalysis.matchedPatterns,
				},
				jobTitle: jobData.title,
				company: jobData.company,
				location: jobData.location,
				salary: jobData.salary,
				timestamp: Date.now(),
			};
		} catch (error) {
			console.error("Error en análisis:", error);
			return {
				risk: 0,
				confidence: 0,
				flags: ["Error en análisis"],
				error: error.message,
			};
		}
	}

	analyzeJobText(jobData) {
		const fullText = `${jobData.title} ${jobData.description}`.toLowerCase();
		let suspiciousScore = 0;
		const matchedPatterns = [];

		// Verificar patrones sospechosos
		this.suspiciousPatterns.forEach((pattern, index) => {
			if (pattern.test(fullText)) {
				suspiciousScore += 0.3;
				matchedPatterns.push(`Patrón sospechoso ${index + 1}`);
			}
		});

		// Análisis de urgencia artificial
		const urgencyWords = /urgent|immediate|asap|today only|limited time/gi;
		const urgencyMatches = (fullText.match(urgencyWords) || []).length;
		if (urgencyMatches > 2) {
			suspiciousScore += 0.2;
			matchedPatterns.push("Urgencia artificial excesiva");
		}

		// Análisis de gramática/ortografía (básico)
		const grammarIssues = this.detectGrammarIssues(fullText);
		if (grammarIssues > 3) {
			suspiciousScore += 0.15;
			matchedPatterns.push("Múltiples errores gramaticales");
		}

		return {
			score: Math.min(suspiciousScore, 1),
			matchedPatterns,
			urgencyScore: urgencyMatches / 10,
			grammarScore: grammarIssues / 20,
		};
	}

	async verifyCompany(companyName) {
		if (!companyName) return { verified: false, confidence: 0 };

		try {
			// Verificación en caché primero
			const cached = await redisClient.get(`company:${companyName}`);
			if (cached) {
				return JSON.parse(cached);
			}

			// Verificaciones básicas
			const isGeneric = this.isGenericCompanyName(companyName);
			const hasLegitIndicators = this.legitimateCompanyIndicators.some((pattern) => pattern.test(companyName));

			// Aquí se podría integrar con APIs como:
			// - Companies House (UK)
			// - SEC EDGAR (US)
			// - Google Places API
			// - LinkedIn Company API

			const result = {
				verified: !isGeneric && hasLegitIndicators,
				confidence: hasLegitIndicators ? 0.7 : 0.3,
				isGeneric,
			};

			// Cachear resultado por 24 horas
			await redisClient.setex(`company:${companyName}`, 86400, JSON.stringify(result));

			return result;
		} catch (error) {
			return { verified: false, confidence: 0, error: error.message };
		}
	}

	isGenericCompanyName(name) {
		const genericPatterns = [/hiring now/i, /work from home/i, /remote work/i, /online jobs/i, /employment agency/i, /staffing/i, /^job/i, /^work/i];

		return genericPatterns.some((pattern) => pattern.test(name));
	}

	analyzeSalary(salaryText, jobTitle) {
		if (!salaryText) return { realistic: true, confidence: 0.5 };

		try {
			// Extraer números del texto de salario
			const numbers = salaryText.match(/\d+/g);
			if (!numbers) return { realistic: true, confidence: 0.3 };

			const maxSalary = Math.max(...numbers.map((n) => parseInt(n)));

			// Determinar nivel del trabajo
			const jobLevel = this.determineJobLevel(jobTitle);
			const expectedRange = this.salaryRanges[jobLevel];

			// Si es por hora y es muy alto (ej: $500/hora para entry-level)
			const isHourly = /hour|hr|\/h/i.test(salaryText);
			if (isHourly && maxSalary > 100 && jobLevel === "entry-level") {
				return { realistic: false, confidence: 0.9, reason: "Salario por hora irrealista" };
			}

			// Si es anual y está fuera de rango esperado
			if (!isHourly) {
				const annualSalary = maxSalary;
				if (annualSalary > expectedRange.max * 2) {
					return { realistic: false, confidence: 0.8, reason: "Salario anual excesivo" };
				}
			}

			return { realistic: true, confidence: 0.7 };
		} catch (error) {
			return { realistic: true, confidence: 0.3, error: error.message };
		}
	}

	determineJobLevel(title) {
		const titleLower = title.toLowerCase();

		if (/senior|lead|principal|director|manager/i.test(titleLower)) {
			return "senior";
		}
		if (/junior|entry|intern|assistant/i.test(titleLower)) {
			return "entry-level";
		}
		if (/executive|vp|president|ceo|cto|cfo/i.test(titleLower)) {
			return "executive";
		}

		return "mid-level";
	}

	async performAIAnalysis(jobData) {
		try {
			const prompt = `
        Analiza esta oferta de trabajo y determina si es potencialmente una estafa.
        
        Título: ${jobData.title}
        Empresa: ${jobData.company}
        Descripción: ${jobData.description}
        Salario: ${jobData.salary || "No especificado"}
        Ubicación: ${jobData.location}
        
        Evalúa estos aspectos:
        1. Realismo de la oferta (0-1)
        2. Legitimidad de la empresa (0-1)
        3. Consistencia de la información (0-1)
        4. Señales de alarma detectadas
        
        Responde en JSON con: {"riskScore": 0-1, "confidence": 0-1, "reasoning": "explicación breve"}
      `;

			const completion = await openai.chat.completions.create({
				model: "gpt-3.5-turbo",
				messages: [{ role: "user", content: prompt }],
				max_tokens: 200,
				temperature: 0.1,
			});

			const response = JSON.parse(completion.choices[0].message.content);

			return {
				riskScore: response.riskScore || 0,
				confidence: response.confidence || 0.5,
				reasoning: response.reasoning || "",
				model: "gpt-3.5-turbo",
			};
		} catch (error) {
			console.error("Error en análisis OpenAI:", error);
			return {
				riskScore: 0,
				confidence: 0,
				reasoning: "Error en análisis IA",
				error: error.message,
			};
		}
	}

	calculateCompositeRisk({ textAnalysis, companyAnalysis, salaryAnalysis, aiAnalysis }) {
		const weights = {
			text: 0.3,
			company: 0.25,
			salary: 0.2,
			ai: 0.25,
		};

		let totalRisk = 0;

		// Texto sospechoso
		totalRisk += textAnalysis.score * weights.text;

		// Empresa no verificada
		if (!companyAnalysis.verified) {
			totalRisk += 0.4 * weights.company;
		}

		// Salario irrealista
		if (!salaryAnalysis.realistic) {
			totalRisk += 0.6 * weights.salary;
		}

		// IA risk score
		totalRisk += (aiAnalysis.riskScore || 0) * weights.ai;

		return Math.min(totalRisk, 1);
	}

	generateFlags({ textAnalysis, companyAnalysis, salaryAnalysis, aiAnalysis }) {
		const flags = [];

		if (textAnalysis.matchedPatterns.length > 0) {
			flags.push(...textAnalysis.matchedPatterns);
		}

		if (companyAnalysis.isGeneric) {
			flags.push("Nombre de empresa genérico o sospechoso");
		}

		if (!companyAnalysis.verified) {
			flags.push("Empresa no verificada en bases de datos");
		}

		if (!salaryAnalysis.realistic) {
			flags.push(`Salario irrealista: ${salaryAnalysis.reason || "fuera de rango esperado"}`);
		}

		if (aiAnalysis.reasoning) {
			flags.push(`IA: ${aiAnalysis.reasoning}`);
		}

		return flags;
	}

	detectGrammarIssues(text) {
		let issues = 0;

		// Errores comunes en estafas
		const grammarPatterns = [
			/\b(recieve|recive)\b/gi, // receive mal escrito
			/\b(seperate)\b/gi, // separate mal escrito
			/\b(loose)\b/gi, // lose/loose confusion
			/\b(your)\s+(hired|selected)\b/gi, // you're vs your
			/\b(its)\s+(a)\s+(great)\b/gi, // it's vs its
		];

		grammarPatterns.forEach((pattern) => {
			const matches = (text.match(pattern) || []).length;
			issues += matches;
		});

		return issues;
	}
}

// Instancia del detector
const detector = new ScamDetectorAI();

// Endpoint principal de análisis
app.post("/api/v1/analyze", authenticateUser, async (req, res) => {
	try {
		const { job } = req.body;

		if (!job || !job.title || !job.description) {
			return res.status(400).json({
				error: "Datos de trabajo incompletos",
			});
		}

		// Actualizar contadores de uso
		await User.findByIdAndUpdate(req.user._id, {
			$inc: {
				"usage.dailyAnalyses": 1,
				"usage.monthlyAnalyses": 1,
			},
		});

		// Verificar si ya existe análisis reciente
		const jobId = job.id || Buffer.from(job.title + job.company).toString("base64");
		const existingAnalysis = await JobAnalysis.findOne({
			jobId,
			timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // 24 horas
		});

		let analysis;
		if (existingAnalysis) {
			analysis = existingAnalysis.toObject();
		} else {
			// Realizar nuevo análisis
			analysis = await detector.analyzeJob(job);

			// Guardar en base de datos
			await new JobAnalysis({
				jobId,
				...job,
				riskScore: analysis.risk,
				confidence: analysis.confidence,
				flags: analysis.flags,
				aiAnalysis: analysis.aiAnalysis,
			}).save();
		}

		res.json(analysis);
	} catch (error) {
		console.error("Error en análisis:", error);
		res.status(500).json({
			error: "Error interno del servidor",
			message: error.message,
		});
	}
});

// Endpoint para reportar estafas/falsos positivos
app.post("/api/v1/report", authenticateUser, async (req, res) => {
	try {
		const { jobId, type, feedback } = req.body; // type: 'scam' | 'false_positive'

		const updateField = type === "scam" ? { $inc: { "userReports.scamReports": 1 } } : { $inc: { "userReports.falsePositives": 1 } };

		await JobAnalysis.findOneAndUpdate({ jobId }, updateField, { upsert: true });

		res.json({ success: true, message: "Reporte recibido" });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Endpoint para estadísticas del usuario
app.get("/api/v1/stats", authenticateUser, async (req, res) => {
	try {
		const userId = req.user._id;
		const last30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

		const stats = await JobAnalysis.aggregate([
			{ $match: { timestamp: { $gte: last30Days } } },
			{
				$group: {
					_id: null,
					totalAnalyses: { $sum: 1 },
					scamsDetected: {
						$sum: { $cond: [{ $gt: ["$riskScore", 0.6] }, 1, 0] },
					},
					avgRiskScore: { $avg: "$riskScore" },
					highRiskJobs: {
						$sum: { $cond: [{ $gt: ["$riskScore", 0.8] }, 1, 0] },
					},
				},
			},
		]);

		res.json({
			user: {
				plan: req.user.plan,
				usage: req.user.usage,
			},
			stats: stats[0] || {
				totalAnalyses: 0,
				scamsDetected: 0,
				avgRiskScore: 0,
				highRiskJobs: 0,
			},
		});
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Endpoint para crear API key (registro de usuario)
app.post("/api/v1/register", async (req, res) => {
	try {
		const { email, plan = "free" } = req.body;

		// Generar API key única
		const apiKey = "sk_" + require("crypto").randomBytes(32).toString("hex");

		const user = new User({
			email,
			apiKey,
			plan,
		});

		await user.save();

		res.json({
			success: true,
			apiKey,
			plan,
			message: "Usuario registrado exitosamente",
		});
	} catch (error) {
		if (error.code === 11000) {
			res.status(400).json({ error: "Email ya registrado" });
		} else {
			res.status(500).json({ error: error.message });
		}
	}
});

// Endpoint de health check
app.get("/api/v1/health", (req, res) => {
	res.json({
		status: "ok",
		timestamp: Date.now(),
		version: "1.0.0",
	});
});

// Middleware de manejo de errores
app.use((error, req, res, next) => {
	console.error("Error no manejado:", error);
	res.status(500).json({
		error: "Error interno del servidor",
		message: error.message,
	});
});

// Iniciar servidor
app.listen(PORT, () => {
	console.log(`🛡️ ScamShield API corriendo en puerto ${PORT}`);

	// Conectar Redis
	redisClient.connect().catch(console.error);

	console.log("✅ Servicios iniciados correctamente");
});

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("🛑 Cerrando servidor...");
	redisClient.quit();
	process.exit(0);
});

module.exports = app;
