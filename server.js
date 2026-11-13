
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-3.8-flash";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20000;

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1200;

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Le fichier doit être une image."));
    }
    cb(null, true);
  }
});

/* -------------------------------------------------------
   GESTION DES ERREURS GEMINI
------------------------------------------------------- */

function getErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.code,
    error?.response?.status,
    error?.error?.code,
    error?.cause?.status
  ];

  for (const candidate of candidates) {
    const status = Number(candidate);

    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }

  const message = String(error?.message || "");

  if (/RESOURCE_EXHAUSTED|429/.test(message)) return 429;
  if (/UNAVAILABLE|503/.test(message)) return 503;
  if (/DEADLINE_EXCEEDED|504/.test(message)) return 504;

  return null;
}

function isTemporaryError(error) {
  const status = getErrorStatus(error);

  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const networkCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT"
  ];

  return networkCodes.includes(error?.code) ||
    networkCodes.includes(error?.cause?.code);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(error, attempt) {
  const retryAfter =
    error?.response?.headers?.["retry-after"] ||
    error?.headers?.["retry-after"];

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 15000);
    }

    const date = Date.parse(retryAfter);

    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 15000);
    }
  }

  const exponentialDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 400);

  return exponentialDelay + jitter;
}

async function generateWithRetry(operation, label = "GEMINI") {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const temporary = isTemporaryError(error);

      if (!temporary || attempt === MAX_RETRIES) {
        console.error(
          `[${label}] Échec après ${attempt + 1} tentative(s) :`,
          error?.message || error
        );

        throw error;
      }

      const delay = getRetryDelay(error, attempt);

      console.warn(
        `[${label}] Erreur temporaire. ` +
        `Nouvelle tentative ${attempt + 1}/${MAX_RETRIES} ` +
        `dans ${delay} ms.`
      );

      await sleep(delay);
    }
  }

  throw new Error("Échec des tentatives Gemini.");
}

/* -------------------------------------------------------
   OUTILS GÉNÉRAUX
------------------------------------------------------- */

function requireAI(req, res, next) {
  if (!ai) {
    return res.status(503).json({
      ok: false,
      error: "GEMINI_API_KEY_MISSING",
      message: "La clé GEMINI_API_KEY n'est pas configurée sur le serveur."
    });
  }

  next();
}

function getText(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function getImageData(response) {
  const outputImage = response?.outputImage || response?.output_image;

  if (outputImage?.data) {
    const mimeType =
      outputImage.mimeType ||
      outputImage.mime_type ||
      "image/png";

    return {
      image: `data:${mimeType};base64,${outputImage.data}`,
      mimeType
    };
  }

  const parts =
    response?.candidates?.[0]?.content?.parts ||
    response?.response?.candidates?.[0]?.content?.parts ||
    [];

  for (const part of parts) {
    const inlineData = part?.inlineData || part?.inline_data;

    if (inlineData?.data) {
      const mimeType =
        inlineData.mimeType ||
        inlineData.mime_type ||
        "image/png";

      return {
        image: `data:${mimeType};base64,${inlineData.data}`,
        mimeType
      };
    }
  }

  for (const step of response?.steps || []) {
    if (step?.type !== "model_output") continue;

    for (const block of step?.content || []) {
      if (block?.type === "image" && block?.data) {
        const mimeType = block.mime_type || "image/png";

        return {
          image: `data:${mimeType};base64,${block.data}`,
          mimeType
        };
      }
    }
  }

  return null;
}

function getResponseText(response) {
  if (typeof response?.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  if (
    typeof response?.outputText === "string" &&
    response.outputText.trim()
  ) {
    return response.outputText.trim();
  }

  if (
    typeof response?.output_text === "string" &&
    response.output_text.trim()
  ) {
    return response.output_text.trim();
  }

  const parts =
    response?.candidates?.[0]?.content?.parts ||
    response?.response?.candidates?.[0]?.content?.parts ||
    [];

  return parts
    .filter(part => typeof part?.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function buildSystemInstruction({ system, mode, level, subject }) {
  const suppliedSystem = getText(system, 4000);

  return [
    "Tu es Sterling IA, un assistant pédagogique clair, patient et bienveillant.",
    `Niveau scolaire : ${getText(level, 100) || "Non précisé"}.`,
    `Matière : ${getText(subject, 100) || "Autre"}.`,
    `Mode de travail : ${getText(mode, 100) || "devoir"}.`,
    "Réponds dans la langue utilisée par l'utilisateur, sauf demande contraire.",
    "Pour les exercices, explique les étapes et adapte les explications au niveau scolaire.",
    suppliedSystem
      ? `Instructions supplémentaires de l'application : ${suppliedSystem}`
      : ""
  ].filter(Boolean).join("\n");
}

/* -------------------------------------------------------
   RÉPONSES D'ERREUR
------------------------------------------------------- */

function sendServerError(res, error, label = "Erreur du serveur") {
  console.error(`[${label}]`, error);

  const providerStatus = getErrorStatus(error);
  const networkError = isTemporaryError(error);

  let status = 500;
  let code = "SERVER_ERROR";
  let message = "Une erreur inattendue est survenue.";

  if (providerStatus === 429) {
    status = 429;
    code = "GEMINI_RATE_LIMIT";
    message =
      "Gemini reçoit trop de demandes actuellement. " +
      "Patiente un instant puis réessaie.";
  } else if (providerStatus === 503 || providerStatus === 504) {
    status = 503;
    code = "GEMINI_UNAVAILABLE";
    message =
      "Le service Gemini est temporairement indisponible. " +
      "Réessaie dans quelques instants.";
  } else if (
    providerStatus === 408 ||
    providerStatus === 500 ||
    providerStatus === 502
  ) {
    status = 503;
    code = "GEMINI_TEMPORARY_ERROR";
    message =
      "Le service IA rencontre un problème temporaire. Réessaie bientôt.";
  } else if (networkError) {
    status = 503;
    code = "GEMINI_CONNECTION_ERROR";
    message =
      "Impossible de joindre le service IA pour le moment. Réessaie.";
  }

  return res.status(status).json({
    ok: false,
    error: code,
    message
  });
}

/* -------------------------------------------------------
   ACCUEIL ET SANTÉ DU SERVEUR
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Sterling Box IA",
    status: "online",
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    geminiConfigured: Boolean(API_KEY),
    routes: [
      "/",
      "/health",
      "/chat",
      "/understand-image",
      "/analyze-image",
      "/transform",
      "/generate-image"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    geminiConfigured: Boolean(API_KEY)
  });
});

/* -------------------------------------------------------
   CHAT IA
   POST /chat
------------------------------------------------------- */

app.post("/chat", requireAI, async (req, res) => {
  try {
    const message = getText(req.body?.message);

    if (!message) {
      return res.status(400).json({
        ok: false,
        message: "Écris un message avant de l'envoyer."
      });
    }

    const system = buildSystemInstruction(req.body || {});

    const history = Array.isArray(req.body?.history)
      ? req.body.history.slice(-12)
      : [];

    const conversation = history
      .filter(item =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
      )
      .map(item => {
        const role =
          item.role === "assistant" ? "Assistant" : "Utilisateur";

        return `${role} : ${getText(item.content, 6000)}`;
      })
      .join("\n\n");

    const prompt = [
      system,
      conversation ? `Historique récent :\n${conversation}` : "",
      `Nouvelle question de l'utilisateur :\n${message}`
    ].filter(Boolean).join("\n\n");

    const response = await generateWithRetry(
      () => ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt
      }),
      "CHAT"
    );

    const output = getResponseText(response);

    if (!output) {
      return res.status(502).json({
        ok: false,
        message: "Le modèle n'a renvoyé aucun texte."
      });
    }

    return res.json({
      ok: true,
      output
    });
  } catch (error) {
    return sendServerError(res, error, "CHAT");
  }
});

/* -------------------------------------------------------
   ANALYSE D'IMAGE
   POST /understand-image
   Alias : POST /analyze-image
------------------------------------------------------- */

async function handleImageAnalysis(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Ajoute une image à analyser."
      });
    }

    const question =
      getText(req.body?.question) ||
      getText(req.body?.prompt) ||
      "Décris cette image et explique les éléments importants.";

    const system = buildSystemInstruction(req.body || {});

    const response = await generateWithRetry(
      () => ai.models.generateContent({
        model: TEXT_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `${system}\n\n` +
                  `Question sur l'image : ${question}\n\n` +
                  "Observe l'image et réponds de manière précise et pédagogique."
              },
              {
                inlineData: {
                  mimeType: req.file.mimetype,
                  data: req.file.buffer.toString("base64")
                }
              }
            ]
          }
        ]
      }),
      "IMAGE_ANALYSIS"
    );

    const output = getResponseText(response);

    if (!output) {
      return res.status(502).json({
        ok: false,
        message: "L'IA n'a renvoyé aucune analyse."
      });
    }

    return res.json({
      ok: true,
      output
    });
  } catch (error) {
    return sendServerError(res, error, "IMAGE_ANALYSIS");
  }
}

app.post(
  "/understand-image",
  requireAI,
  upload.single("image"),
  handleImageAnalysis
);

app.post(
  "/analyze-image",
  requireAI,
  upload.single("image"),
  handleImageAnalysis
);

/* -------------------------------------------------------
   MODIFICATION DE PHOTO
   POST /transform
------------------------------------------------------- */

app.post(
  "/transform",
  requireAI,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "Ajoute la photo à modifier."
        });
      }

      const prompt = getText(req.body?.prompt);

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          message: "Décris les modifications souhaitées."
        });
      }

      const response = await generateWithRetry(
        () => ai.models.generateContent({
          model: IMAGE_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    "Modifie l'image fournie selon les instructions suivantes. " +
                    "Conserve les éléments importants non concernés par la demande. " +
                    "Retourne une image modifiée.\n\n" +
                    `Instructions : ${prompt}`
                },
                {
                  inlineData: {
                    mimeType: req.file.mimetype,
                    data: req.file.buffer.toString("base64")
                  }
                }
              ]
            }
          ],
          config: {
            responseModalities: ["TEXT", "IMAGE"]
          }
        }),
        "IMAGE_TRANSFORM"
      );

      const result = getImageData(response);

      if (!result) {
        const explanation = getResponseText(response);

        return res.status(502).json({
          ok: false,
          message: explanation
            ? `Aucune image n'a été renvoyée. Réponse du modèle : ${explanation.slice(0, 350)}`
            : "Le modèle n'a pas renvoyé d'image. Réessaie avec une autre instruction."
        });
      }

      return res.json({
        ok: true,
        image: result.image,
        mimeType: result.mimeType,
        message: "Image modifiée avec succès."
      });
    } catch (error) {
      return sendServerError(res, error, "IMAGE_TRANSFORM");
    }
  }
);

/* -------------------------------------------------------
   GÉNÉRATION D'IMAGE
   POST /generate-image
------------------------------------------------------- */

app.post("/generate-image", requireAI, async (req, res) => {
  try {
    const prompt = getText(req.body?.prompt);

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message: "Décris l'image que tu souhaites générer."
      });
    }

    const response = await generateWithRetry(
      () => ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [
          "Crée une image correspondant à cette description. " +
          "Retourne une image de bonne qualité.\n\n" +
          `Description : ${prompt}`
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      }),
      "IMAGE_GENERATION"
    );

    const result = getImageData(response);

    if (!result) {
      const explanation = getResponseText(response);

      return res.status(502).json({
        ok: false,
        message: explanation
          ? `Aucune image n'a été générée. Réponse du modèle : ${explanation.slice(0, 350)}`
          : "Le modèle n'a pas renvoyé d'image. Réessaie avec une autre description."
      });
    }

    return res.json({
      ok: true,
      image: result.image,
      mimeType: result.mimeType,
      message: "Image générée avec succès."
    });
  } catch (error) {
    return sendServerError(res, error, "IMAGE_GENERATION");
  }
});

/* -------------------------------------------------------
   ERREURS MULTER ET EXPRESS
------------------------------------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;

    return res.status(status).json({
      ok: false,
      message: err.code === "LIMIT_FILE_SIZE"
        ? "L'image dépasse la limite de 10 Mo."
        : "Le fichier envoyé est invalide."
    });
  }

  if (err) {
    const status =
      err.message?.includes("doit être une image") ? 400 : 500;

    console.error("[EXPRESS_ERROR]", err);

    return res.status(status).json({
      ok: false,
      message: status === 400
        ? err.message
        : "Une erreur serveur est survenue."
    });
  }

  next();
});

/* -------------------------------------------------------
   ROUTES INCONNUES
------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: `Route introuvable : ${req.method} ${req.path}`
  });
});

/* -------------------------------------------------------
   DÉMARRAGE
------------------------------------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sterling Box IA écoute sur le port ${PORT}`);
  console.log(`Modèle texte : ${TEXT_MODEL}`);
  console.log(`Modèle image : ${IMAGE_MODEL}`);
  console.log(`Clé Gemini configurée : ${Boolean(API_KEY)}`);
  console.log(`Nombre maximal de tentatives : ${MAX_RETRIES + 1}`);
});
  
