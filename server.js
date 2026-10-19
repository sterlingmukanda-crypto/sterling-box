
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

const TEXT_MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Le fichier doit être une image."));
    }
  }
});

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

/* =========================
   OUTILS COMMUNS
========================= */

function requireGeminiKey(res) {
  if (!ai) {
    res.status(500).json({
      ok: false,
      message: "La clé GEMINI_API_KEY n'est pas configurée dans Render."
    });
    return false;
  }

  return true;
}

function getPedagogicalPrompt(options = {}) {
  const mode = String(options.mode || "general");
  const level = String(options.level || "Autre");
  const subject = String(options.subject || "Autre");
  const customSystem = String(options.system || "");

  const modeInstructions = {
    general: "Réponds naturellement, clairement et utilement.",
    devoir: "Aide l'élève à comprendre son devoir, en expliquant les étapes.",
    cours: "Explique le cours progressivement avec des exemples simples.",
    resume: "Fais un résumé fidèle, organisé et facile à retenir.",
    correction: "Corrige les erreurs et explique pourquoi.",
    methode: "Résous le problème étape par étape et justifie les calculs.",
    "compréhension d'image":
      "Analyse l'image fournie. Décris ce que tu observes réellement. " +
      "Signale les textes illisibles et les incertitudes. Pour un exercice, " +
      "explique la méthode étape par étape. Ne prétends pas voir des détails incertains."
  };

  return [
    "Tu es Sterling Box IA, un assistant pédagogique et polyvalent.",
    "Réponds principalement en français, sauf si l'utilisateur demande une autre langue.",
    "Sois précis, respectueux, clair et adapté au niveau indiqué.",
    "N'invente pas des informations et indique les incertitudes.",
    `Niveau : ${level}.`,
    `Matière : ${subject}.`,
    modeInstructions[mode] || modeInstructions.general,
    customSystem
  ].filter(Boolean).join("\n\n");
}

function extractOutput(interaction) {
  if (interaction && typeof interaction.output_text === "string") {
    return interaction.output_text.trim();
  }

  return "";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string" &&
      item.content.trim()
    )
    .slice(-10)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 4000)
    }));
}

function buildHistoryText(history) {
  if (!history.length) return "";

  return "Contexte précédent de la conversation :\n" +
    history.map(item => {
      const role = item.role === "user" ? "Utilisateur" : "Sterling IA";
      return `${role} : ${item.content}`;
    }).join("\n\n") +
    "\n\n";
}

function imageMimeAllowed(mimeType) {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ].includes(String(mimeType || "").toLowerCase());
}

/* =========================
   PAGE ET ÉTAT DU SERVEUR
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Sterling Box IA",
    status: "online",
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    routes: [
      "GET /",
      "GET /health",
      "GET /assistant.html",
      "GET /image.html",
      "POST /chat",
      "POST /understand-image",
      "POST /transform",
      "POST /generate-image"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    apiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.get("/assistant.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assistant.html"));
});

app.get("/image.html", (req, res) => {
  res.sendFile(path.join(__dirname, "image.html"));
});

/* =========================
   CHAT TEXTUEL
========================= */

app.get("/chat", (req, res) => {
  res.json({
    ok: true,
    message: "La route de chat est disponible.",
    method: "POST"
  });
});

app.post("/chat", async (req, res) => {
  try {
    if (!requireGeminiKey(res)) return;

    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        ok: false,
        message: "Écris un message avant d'envoyer."
      });
    }

    if (message.length > 20000) {
      return res.status(400).json({
        ok: false,
        message: "Le message est trop long."
      });
    }

    const history = cleanHistory(req.body?.history);

    const system = getPedagogicalPrompt({
      system: req.body?.system,
      mode: req.body?.mode,
      level: req.body?.level,
      subject: req.body?.subject
    });

    const context = buildHistoryText(history);

    const interaction = await ai.interactions.create({
      model: TEXT_MODEL,
      system_instruction: system,
      input: context +
        "Nouveau message de l'utilisateur :\n" +
        message
    });

    const output = extractOutput(interaction);

    if (!output) {
      return res.status(502).json({
        ok: false,
        message: "Le modèle n'a renvoyé aucune réponse."
      });
    }

    return res.json({
      ok: true,
      output,
      model: TEXT_MODEL,
      interactionId: interaction.id || null
    });

  } catch (error) {
    console.error("ERREUR /chat:", error);

    return res.status(500).json({
      ok: false,
      message: error.message || "Une erreur est survenue pendant le chat.",
      status: error.status || null
    });
  }
});

/* =========================
   COMPRÉHENSION D'IMAGES
========================= */

app.post(
  "/understand-image",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!requireGeminiKey(res)) return;

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "Aucune image reçue. Choisis une image."
        });
      }

      if (!imageMimeAllowed(req.file.mimetype)) {
        return res.status(400).json({
          ok: false,
          message: "Format non pris en charge. Utilise JPEG, PNG ou WebP."
        });
      }

      const question = String(req.body?.question || "").trim();

      if (!question) {
        return res.status(400).json({
          ok: false,
          message: "Écris une question sur l'image."
        });
      }

      if (question.length > 5000) {
        return res.status(400).json({
          ok: false,
          message: "La question est trop longue."
        });
      }

      let history = [];

      try {
        const parsed = JSON.parse(req.body?.history || "[]");
        history = cleanHistory(parsed);
      } catch {
        history = [];
      }

      const system = getPedagogicalPrompt({
        system:
          "Tu peux analyser des images, des exercices photographiés, " +
          "des documents et des schémas. Décris uniquement ce que tu peux " +
          "réellement observer. Si un texte est illisible, signale-le. " +
          "Pour un exercice, explique les étapes progressivement. " +
          "Ne prétends pas voir des détails incertains.",
        mode: "compréhension d'image",
        level: req.body?.level,
        subject: req.body?.subject
      });

      const imageData = req.file.buffer.toString("base64");
      const context = buildHistoryText(history);

      const interaction = await ai.interactions.create({
        model: TEXT_MODEL,
        system_instruction: system,
        input: [
          {
            type: "text",
            text: context +
              "Analyse l'image jointe et réponds à cette question :\n" +
              question
          },
          {
            type: "image",
            mime_type: req.file.mimetype,
            data: imageData
          }
        ]
      });

      const output = extractOutput(interaction);

      if (!output) {
        return res.status(502).json({
          ok: false,
          message: "Aucune explication n'a été renvoyée pour cette image."
        });
      }

      return res.json({
        ok: true,
        output,
        model: TEXT_MODEL,
        interactionId: interaction.id || null
      });

    } catch (error) {
      console.error("ERREUR /understand-image:", error);

      return res.status(500).json({
        ok: false,
        message: error.message ||
          "Une erreur est survenue pendant l'analyse de l'image.",
        status: error.status || null
      });
    }
  }
);

/* =========================
   TRANSFORMATION D'IMAGE
========================= */

app.post(
  "/transform",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!requireGeminiKey(res)) return;

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "Choisis une image à transformer."
        });
      }

      if (!imageMimeAllowed(req.file.mimetype)) {
        return res.status(400).json({
          ok: false,
          message: "Format d'image non pris en charge."
        });
      }

      const prompt = String(req.body?.prompt || "").trim();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          message: "Décris la transformation souhaitée."
        });
      }

      if (prompt.length > 4000) {
        return res.status(400).json({
          ok: false,
          message: "La description est trop longue."
        });
      }

      const result = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [
          {
            text:
              "Modifie l'image fournie selon cette instruction : " +
              prompt +
              ". Préserve les éléments non concernés autant que possible."
          },
          {
            inlineData: {
              mimeType: req.file.mimetype,
              data: req.file.buffer.toString("base64")
            }
          }
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      });

      let image = null;
      let output = "";

      for (const candidate of result.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.text) output += part.text + "\n";

          const inlineData = part.inlineData;

          if (inlineData?.data && inlineData?.mimeType) {
            image = `data:${inlineData.mimeType};base64,${inlineData.data}`;
          }
        }
      }

      if (!image) {
        return res.status(502).json({
          ok: false,
          message: output.trim() ||
            "Le modèle n'a pas renvoyé d'image. Vérifie la disponibilité du modèle de génération d'images."
        });
      }

      return res.json({
        ok: true,
        output: output.trim(),
        image,
        model: IMAGE_MODEL
      });

    } catch (error) {
      console.error("ERREUR /transform:", error);

      return res.status(500).json({
        ok: false,
        message: error.message ||
          "Une erreur est survenue pendant la transformation.",
        status: error.status || null
      });
    }
  }
);

/* =========================
   GÉNÉRATION D'IMAGE
========================= */

app.post("/generate-image", async (req, res) => {
  try {
    if (!requireGeminiKey(res)) return;

    const prompt = String(req.body?.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message: "Décris l'image que tu veux créer."
      });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({
        ok: false,
        message: "La description est trop longue."
      });
    }

    const result = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: prompt,
      config: {
        responseModalities: ["TEXT", "IMAGE"]
      }
    });

    let image = null;
    let output = "";

    for (const candidate of result.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.text) output += part.text + "\n";

        const inlineData = part.inlineData;

        if (inlineData?.data && inlineData?.mimeType) {
          image = `data:${inlineData.mimeType};base64,${inlineData.data}`;
        }
      }
    }

    if (!image) {
      return res.status(502).json({
        ok: false,
        message: output.trim() ||
          "Le modèle n'a pas renvoyé d'image. Vérifie la disponibilité de ce modèle pour ton compte."
      });
    }

    return res.json({
      ok: true,
      output: output.trim(),
      image,
      model: IMAGE_MODEL
    });

  } catch (error) {
    console.error("ERREUR /generate-image:", error);

    return res.status(500).json({
      ok: false,
      message: error.message ||
        "Une erreur est survenue pendant la génération de l'image.",
      status: error.status || null
    });
  }
});

/* =========================
   GESTION DES ERREURS
========================= */

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "L'image dépasse la limite de 10 Mo."
      : "Le fichier envoyé n'a pas pu être traité.";

    return res.status(400).json({
      ok: false,
      message
    });
  }

  console.error("ERREUR SERVEUR:", error);

  return res.status(400).json({
    ok: false,
    message: error.message || "La requête n'a pas pu être traitée."
  });
});

/* =========================
   DÉMARRAGE
========================= */

app.listen(PORT, () => {
  console.log(`Sterling Box IA écoute sur le port ${PORT}`);
  console.log(`Modèle texte : ${TEXT_MODEL}`);
  console.log(`Modèle image : ${IMAGE_MODEL}`);
  console.log(`Clé Gemini configurée : ${Boolean(process.env.GEMINI_API_KEY)}`);
});
  
