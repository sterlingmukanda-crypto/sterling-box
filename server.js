
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

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
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

function requireGeminiKey(res) {
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({
      ok: false,
      message: "GEMINI_API_KEY est absente de Render."
    });
    return false;
  }

  return true;
}

function getPedagogicalPrompt({ system = "", mode = "devoir",
  level = "Autre", subject = "Général" } = {}) {
  return `
Tu es Sterling IA, un assistant pédagogique intelligent et bienveillant.

Niveau scolaire : ${String(level).slice(0, 100)}
Matière : ${String(subject).slice(0, 100)}
Mode : ${String(mode).slice(0, 100)}

Consignes :
- Réponds en français sauf si l'utilisateur demande une autre langue.
- Explique clairement, progressivement et avec des exemples adaptés.
- Pour les exercices, détaille les étapes du raisonnement.
- Tiens compte des messages précédents de cette conversation.
- Quand l'utilisateur dit « cela », « continue », « pourquoi ? » ou
  « explique la deuxième étape », utilise le contexte précédent.
- Ne recommence pas systématiquement une réponse depuis le début.
- Ne répète pas inutilement les informations déjà données.
- Si l'utilisateur corrige ou précise sa demande, adapte ta réponse.
- Utilise des titres sobres, des listes et des formules quand ils sont utiles.
- Évite les suites de symboles Markdown inutiles et les titres excessifs.
- Reste précis, pédagogique et honnête en cas d'incertitude.

${String(system).slice(0, 12000)}
`;
}

function getImageFromInteraction(interaction) {
  // Format de sortie direct, lorsqu'il est disponible.
  if (interaction?.output_image?.data) {
    return interaction.output_image;
  }

  // Sorties multimodales de l'API Interactions.
  for (const item of interaction?.outputs || []) {
    if (item?.type === "image" && item.data) {
      return item;
    }
  }

  // Compatibilité avec les étapes de sortie du SDK.
  for (const step of interaction?.steps || []) {
    if (step?.type !== "model_output") continue;

    for (const block of step.content || []) {
      if (block?.type === "image" && block.data) {
        return block;
      }
    }
  }

  return null;
}

/* =========================
   PAGES
========================= */

app.get("/assistant.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assistant.html"));
});

app.get("/image.html", (req, res) => {
  res.sendFile(path.join(__dirname, "image.html"));
});

/* =========================
   ROOT
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Sterling Box AI",
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    features: {
      multiTurnConversation: true,
      imageTransformation: true,
      imageGeneration: true
    },
    routes: {
      assistant: "/assistant.html",
      image: "/image.html",
      chat: "/chat",
      transform: "/transform",
      generateImage: "/generate-image"
    }
  });
});

/* =========================
   CHAT STATUS
========================= */

app.get("/chat", (req, res) => {
  res.json({
    ok: true,
    route: "/chat",
    model: TEXT_MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

/* =========================
   CHAT AVEC CONTEXTE
========================= */

app.post("/chat", async (req, res) => {
  try {
    if (!requireGeminiKey(res)) return;

    const {
      message,
      system = "",
      mode = "devoir",
      level = "Autre",
      subject = "Général",
      previousInteractionId,
      history
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Message vide."
      });
    }

    const prompt = getPedagogicalPrompt({
      system,
      mode,
      level,
      subject
    });

    const userMessage = String(message).trim();

    const request = {
      model: TEXT_MODEL,
      system_instruction: prompt,
      input: userMessage
    };

    // Si le navigateur fournit l'identifiant du tour précédent,
    // Gemini continue cette même conversation.
    if (
      typeof previousInteractionId === "string" &&
      previousInteractionId.trim()
    ) {
      request.previous_interaction_id =
        previousInteractionId.trim();
    } else if (Array.isArray(history) && history.length > 0) {
      // Solution de secours pour les interfaces utilisant un historique local.
      // Les derniers échanges seulement sont transmis afin de limiter la taille.
      const previousTurns = history
        .filter(turn =>
          turn &&
          ["user", "assistant", "model"].includes(turn.role) &&
          typeof turn.content === "string" &&
          turn.content.trim()
        )
        .slice(-20)
        .map(turn => {
          const role = turn.role === "user"
            ? "Élève"
            : "Sterling IA";

          return `${role} : ${turn.content.slice(0, 6000)}`;
        });

      if (previousTurns.length) {
        request.input =
          "Historique précédent de cette conversation :\n" +
          previousTurns.join("\n\n") +
          "\n\nNouveau message de l'élève :\n" +
          userMessage;
      }
    }

    console.log("STERLING IA /chat");
    console.log("Modèle:", TEXT_MODEL);
    console.log("Mode:", mode);
    console.log("Niveau:", level);
    console.log("Matière:", subject);
    console.log("Suite de conversation:", Boolean(
      request.previous_interaction_id
    ));

    const interaction = await ai.interactions.create(request);
    const output = interaction.output_text || "";

    if (!output.trim()) {
      return res.status(502).json({
        ok: false,
        message: "Gemini n'a retourné aucune réponse."
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
      message: error?.message || "Erreur Gemini.",
      status: error?.status || null
    });
  }
});

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
        message: "Décris l'image que tu souhaites créer."
      });
    }

    if (prompt.length > 5000) {
      return res.status(400).json({
        ok: false,
        message: "La description est trop longue (maximum 5000 caractères)."
      });
    }

    console.log("STERLING IA /generate-image");
    console.log("Modèle:", IMAGE_MODEL);

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: prompt,
      response_modalities: ["image"]
    });

    const generatedImage = getImageFromInteraction(interaction);

    if (!generatedImage?.data) {
      return res.status(502).json({
        ok: false,
        message:
          "Aucune image reçue. Vérifie la compatibilité du modèle " +
          "avec la génération d'images et les modalités de sortie."
      });
    }

    return res.json({
      ok: true,
      model: IMAGE_MODEL,
      image: `data:${generatedImage.mime_type || "image/png"};base64,${generatedImage.data}`
    });

  } catch (error) {
    console.error("ERREUR /generate-image:", error);

    return res.status(500).json({
      ok: false,
      message: error?.message || "Erreur de génération d'image.",
      status: error?.status || null
    });
  }
});

/* =========================
   TRANSFORMATION D'IMAGE
   Route conservée pour l'interface existante.
========================= */

app.post("/transform", upload.single("image"), async (req, res) => {
  try {
    if (!requireGeminiKey(res)) return;

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Aucune image reçue."
      });
    }

    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        ok: false,
        message: "Le fichier envoyé n'est pas une image."
      });
    }

    const prompt = String(
      req.body?.prompt ||
      "Améliore cette image naturellement en conservant ses éléments importants."
    ).slice(0, 5000);

    console.log("STERLING IA /transform");
    console.log("Fichier:", req.file.originalname);
    console.log("Type:", req.file.mimetype);
    console.log("Modèle:", IMAGE_MODEL);

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: [
        {
          type: "image",
          mime_type: req.file.mimetype,
          data: req.file.buffer.toString("base64")
        },
        {
          type: "text",
          text: prompt
        }
      ],
      response_modalities: ["image"]
    });

    const generatedImage = getImageFromInteraction(interaction);

    if (!generatedImage?.data) {
      return res.status(502).json({
        ok: false,
        message:
          "Gemini n'a retourné aucune image modifiée. " +
          "Le modèle doit prendre en charge l'édition d'images."
      });
    }

    return res.json({
      ok: true,
      model: IMAGE_MODEL,
      image: `data:${generatedImage.mime_type || "image/png"};base64,${generatedImage.data}`
    });

  } catch (error) {
    console.error("ERREUR /transform:", error);

    return res.status(500).json({
      ok: false,
      message: error?.message || "Erreur Gemini Image.",
      status: error?.status || null
    });
  }
});

/* =========================
   ERREURS DE FICHIERS ET SERVEUR
========================= */

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      message: `Erreur fichier : ${error.message}`
    });
  }

  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({
      ok: false,
      message: "Le JSON envoyé est invalide."
    });
  }

  console.error("ERREUR SERVEUR:", error);

  return res.status(500).json({
    ok: false,
    message: "Erreur serveur."
  });
});

/* =========================
   DÉMARRAGE
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("STERLING BOX AI");
  console.log("======================================");
  console.log("Port:", PORT);
  console.log("Assistant: /assistant.html");
  console.log("Image: /image.html");
  console.log("Chat: /chat");
  console.log("Transform: /transform");
  console.log("Génération: /generate-image");
  console.log("Modèle texte:", TEXT_MODEL);
  console.log("Modèle image:", IMAGE_MODEL);
  console.log(
    "GEMINI_API_KEY:",
    process.env.GEMINI_API_KEY ? "CONFIGURÉE" : "ABSENTE"
  );
  console.log("Serveur prêt.");
});
  
