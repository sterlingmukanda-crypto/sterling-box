
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

const TEXT_MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

if (!process.env.GEMINI_API_KEY) {
  console.warn("ATTENTION : GEMINI_API_KEY est absente.");
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 8 },
  fileFilter(req, file, callback) {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif"
    ];
    if (!allowed.includes(file.mimetype)) {
      return callback(new Error(
        "Format non pris en charge. Utilise JPEG, PNG ou WebP."
      ));
    }
    callback(null, true);
  }
});

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"]
}));
app.use(express.json({ limit: "15mb" }));

app.use((req, res, next) => {
  console.log(`REQUEST: ${req.method} ${req.url}`);
  next();
});

function requireApiKey(res) {
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({
      ok: false,
      message: "GEMINI_API_KEY est absente des variables d'environnement de Render."
    });
    return false;
  }
  return true;
}

function errorMessage(error) {
  const message = String(error?.message || "Erreur inconnue.");
  console.error("Erreur Gemini :", message);

  if (/API_KEY|api key|unauthorized|forbidden/i.test(message)) {
    return "La clé API Gemini est absente, invalide ou non autorisée.";
  }
  if (/quota|rate.?limit|resource.?exhausted/i.test(message)) {
    return "La limite d'utilisation de Gemini a été atteinte. Réessaie plus tard.";
  }
  if (/not found|404|model/i.test(message)) {
    return "Le modèle demandé est indisponible ou son identifiant est invalide. Vérifie les modèles autorisés pour ta clé Gemini.";
  }
  return message.slice(0, 500);
}

function buildVisionPrompt({
  question,
  system = "",
  mode = "general",
  level = "adaptatif",
  subject = "Général"
}) {
  return `
Tu es Sterling Box IA, un assistant multimodal rigoureux et honnête.
Analyse les détails réellement visibles. N'invente pas les objets,
les couleurs, les noms, le texte ni les actions qui ne sont pas discernables.
Distingue les observations des suppositions et signale les incertitudes.
Si plusieurs personnages ou objets sont présents, décris-les séparément.
Lis le texte de l'image uniquement lorsqu'il est suffisamment lisible.
Pour un exercice scolaire, recopie l'énoncé visible et explique les étapes.
Réponds en français sauf demande contraire.

Mode : ${mode}
Niveau : ${level}
Matière : ${subject}
Instructions supplémentaires : ${system || "Aucune"}
Question : ${question || "Décris cette image avec précision."}
`;
}

function getOutputImage(interaction) {
  if (interaction?.output_image?.data) {
    return interaction.output_image;
  }

  for (const step of interaction?.steps || []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content || []) {
      if (block.type === "image" && block.data) return block;
    }
  }
  return null;
}

function imageDataUrl(image) {
  const mime = image?.mime_type || "image/png";
  return `data:${mime};base64,${image.data}`;
}

/* Pages */
app.get("/assistant.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assistant.html"));
});

/* Page historique : conservée pour compatibilité, mais non nécessaire au chat */
app.get("/image.html", (req, res) => {
  res.sendFile(path.join(__dirname, "image.html"));
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Sterling Box AI",
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    routes: {
      assistant: "/assistant.html",
      chat: "/chat",
      understandImage: "/understand-image",
      analyzeImage: "/analyze-image",
      transform: "/transform",
      generateImage: "/generate-image"
    }
  });
});

/* Chat texte */
app.get("/chat", (req, res) => {
  res.json({
    ok: true,
    route: "/chat",
    model: TEXT_MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post("/chat", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const {
      message,
      system = "",
      mode = "general",
      level = "adaptatif",
      subject = "Général",
      history = []
    } = req.body || {};

    if (!String(message || "").trim()) {
      return res.status(400).json({ ok: false, message: "Message vide." });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            ["user", "assistant"].includes(item.role) &&
            typeof item.content === "string"
          )
          .slice(-12)
          .map(item =>
            `${item.role === "user" ? "Utilisateur" : "Sterling Box IA"}: ${item.content.slice(0, 5000)}`
          )
          .join("\n\n")
      : "";

    const prompt = `
Tu es Sterling Box IA, un assistant utile, clair et fiable.
Réponds en français sauf demande contraire. Explique les étapes utiles
et adapte tes explications au niveau de l'utilisateur. N'invente pas de faits.

Mode : ${String(mode).slice(0, 100)}
Niveau : ${String(level).slice(0, 100)}
Matière : ${String(subject).slice(0, 200)}
Instructions : ${String(system).slice(0, 5000)}

Historique récent :
${safeHistory || "Aucun historique précédent."}

Nouveau message :
${String(message).slice(0, 12000)}
`;

    const interaction = await ai.interactions.create({
      model: TEXT_MODEL,
      input: prompt
    });

    const output = interaction.output_text || "";
    if (!output.trim()) {
      return res.status(502).json({
        ok: false,
        message: "Gemini n'a retourné aucune réponse."
      });
    }

    res.json({ ok: true, output, model: TEXT_MODEL });
  } catch (error) {
    res.status(500).json({ ok: false, message: errorMessage(error) });
  }
});

/* Analyse d'image */
async function handleUnderstandImage(req, res) {
  try {
    if (!requireApiKey(res)) return;
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Aucune image reçue. Le champ attendu est « image »."
      });
    }

    const question = String(
      req.body?.question || req.body?.prompt ||
      "Décris cette image et explique ses éléments importants."
    ).slice(0, 5000);

    const prompt = buildVisionPrompt({
      question,
      system: String(req.body?.system || "").slice(0, 5000),
      mode: String(req.body?.mode || "general").slice(0, 100),
      level: String(req.body?.level || "adaptatif").slice(0, 100),
      subject: String(req.body?.subject || "Général").slice(0, 200)
    });

    const interaction = await ai.interactions.create({
      model: TEXT_MODEL,
      input: [
        { type: "text", text: prompt },
        {
          type: "image",
          mime_type: req.file.mimetype,
          data: req.file.buffer.toString("base64")
        }
      ]
    });

    const output = interaction.output_text || "";
    if (!output.trim()) {
      return res.status(502).json({
        ok: false,
        message: "Gemini n'a retourné aucune analyse."
      });
    }

    res.json({ ok: true, output, model: TEXT_MODEL });
  } catch (error) {
    res.status(500).json({ ok: false, message: errorMessage(error) });
  }
}

app.post("/understand-image", upload.single("image"), handleUnderstandImage);
app.post("/analyze-image", upload.single("image"), handleUnderstandImage);

/* Génération d'image depuis un texte */
app.post("/generate-image", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const prompt = String(req.body?.prompt || "").trim().slice(0, 5000);
    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message: "Décris l'image que tu souhaites générer."
      });
    }

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: prompt,
      response_format: {
        type: "image",
        mime_type: "image/png",
        aspect_ratio: "1:1",
        image_size: "1K"
      }
    });

    const generatedImage = getOutputImage(interaction);
    if (!generatedImage?.data) {
      return res.status(502).json({
        ok: false,
        message: "Le modèle n'a retourné aucune image. Essaie avec une autre description."
      });
    }

    res.json({
      ok: true,
      model: IMAGE_MODEL,
      image: imageDataUrl(generatedImage),
      description: interaction.output_text || ""
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: errorMessage(error) });
  }
});

/* Retouche d'une photo ou d'un montage */
async function handleTransform(req, res) {
  try {
    if (!requireApiKey(res)) return;
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Aucune image reçue. Choisis une photo ou un montage."
      });
    }

    const prompt = String(
      req.body?.prompt ||
      "Améliore cette image naturellement en conservant ses éléments importants."
    ).slice(0, 5000);

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: [
        { type: "text", text: prompt },
        {
          type: "image",
          mime_type: req.file.mimetype,
          data: req.file.buffer.toString("base64")
        }
      ],
      response_format: {
        type: "image",
        mime_type: "image/png",
        image_size: "1K"
      }
    });

    const generatedImage = getOutputImage(interaction);
    if (!generatedImage?.data) {
      return res.status(502).json({
        ok: false,
        message: "Le modèle n'a retourné aucune image modifiée."
      });
    }

    res.json({
      ok: true,
      model: IMAGE_MODEL,
      image: imageDataUrl(generatedImage),
      description: interaction.output_text || ""
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: errorMessage(error) });
  }
}

app.post("/transform", upload.single("image"), handleTransform);

/* Gestion des erreurs de fichiers */
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      ok: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "L'image dépasse la limite de 10 Mo."
        : `Erreur de fichier : ${error.message}`
    });
  }

  if (error) {
    console.error("Erreur serveur :", error);
    return res.status(400).json({
      ok: false,
      message: error.message || "Erreur serveur."
    });
  }
  next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("STERLING BOX AI");
  console.log("Port :", PORT);
  console.log("Chat : /chat");
  console.log("Analyse : /analyze-image et /understand-image");
  console.log("Retouche : /transform");
  console.log("Génération : /generate-image");
  console.log("Modèle texte/vision :", TEXT_MODEL);
  console.log("Modèle image :", IMAGE_MODEL);
  console.log("GEMINI_API_KEY :", process.env.GEMINI_API_KEY ? "CONFIGURÉE" : "ABSENTE");
  console.log("Serveur prêt.");
});
  
