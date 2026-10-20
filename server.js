
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
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function getImageData(response) {
  // Format recommandé pour les réponses d'image de l'API Gemini.
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

  // Compatibilité avec les réponses Generate Content.
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

  // Compatibilité avec les blocs d'image de l'API Interactions.
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
    suppliedSystem ? `Instructions supplémentaires de l'application : ${suppliedSystem}` : ""
  ].filter(Boolean).join("\n");
}

function sendServerError(res, error, label = "Erreur du serveur") {
  console.error(`[${label}]`, error);

  const message =
    error?.message ||
    "Une erreur inattendue est survenue.";

  return res.status(500).json({
    ok: false,
    error: "SERVER_ERROR",
    message: message.slice(0, 500)
  });
}

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
        const role = item.role === "assistant" ? "Assistant" : "Utilisateur";
        return `${role} : ${getText(item.content, 6000)}`;
      })
      .join("\n\n");

    const prompt = [
      system,
      conversation ? `Historique récent :\n${conversation}` : "",
      `Nouvelle question de l'utilisateur :\n${message}`
    ].filter(Boolean).join("\n\n");

    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt
    });

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

    const response = await ai.models.generateContent({
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
    });

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

      const response = await ai.models.generateContent({
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
      });

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
   Body JSON : { "prompt": "..." }
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

    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [
        "Crée une image correspondant à cette description. " +
        "Retourne une image de bonne qualité.\n\n" +
        `Description : ${prompt}`
      ],
      config: {
        responseModalities: ["TEXT", "IMAGE"]
      }
    });

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
   ERREURS MULTER ET ROUTES INCONNUES
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
    const status = err.message?.includes("doit être une image") ? 400 : 500;

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

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: `Route introuvable : ${req.method} ${req.path}`
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sterling Box IA écoute sur le port ${PORT}`);
  console.log(`Modèle texte : ${TEXT_MODEL}`);
  console.log(`Modèle image : ${IMAGE_MODEL}`);
  console.log(`Clé Gemini configurée : ${Boolean(API_KEY)}`);
});
  
