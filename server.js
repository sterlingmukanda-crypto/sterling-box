import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fal } from "@fal-ai/client";

const app = express();
const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// CHEMINS
// --------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const IMAGE_MODEL = "fal-ai/flux-2/klein/9b/edit";
const STUDY_MODEL = "fal-ai/bytedance/seed/v2/mini";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// --------------------------------------------------
// LOGS DE REQUÊTES
// --------------------------------------------------

app.use((req, res, next) => {
  console.log(
    "REQUEST:",
    req.method,
    req.originalUrl,
    "origin:",
    req.headers.origin || "none"
  );
  next();
});

// --------------------------------------------------
// FICHIERS HTML
// --------------------------------------------------

// Sterling IA
app.get("/assistant.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assistant.html"));
});

// Sterling Image
app.get("/image.html", (req, res) => {
  res.sendFile(path.join(__dirname, "image.html"));
});

// --------------------------------------------------
// PAGE PRINCIPALE / TEST SERVEUR
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Sterling Box AI",
    imageModel: IMAGE_MODEL,
    studyModel: STUDY_MODEL,
    routes: {
      assistant: "/assistant.html",
      image: "/image.html",
      chat: "/chat",
      transform: "/transform",
    },
  });
});

// --------------------------------------------------
// TEST GET /chat
// --------------------------------------------------

app.get("/chat", (req, res) => {
  res.json({
    ok: true,
    route: "/chat",
    method: "GET",
    message: "La route Sterling IA fonctionne sur Render.",
  });
});

// --------------------------------------------------
// STERLING IA — ÉTUDES & DEVOIRS
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  console.log("======================================");
  console.log("STERLING IA /chat");
  console.log("======================================");

  try {
    // Vérification de la clé
    if (!process.env.FAL_KEY) {
      console.error("FAL_KEY absente.");
      return res.status(500).json({
        ok: false,
        error: "FAL_KEY_MISSING",
        message: "La clé FAL_KEY n'est pas configurée sur Render.",
      });
    }

    const {
      message,
      system,
      mode = "devoir",
      level = "Autre",
    } = req.body || {};

    console.log("Mode:", mode);
    console.log("Niveau:", level);
    console.log("Message:", message);

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        error: "MESSAGE_MISSING",
        message: "Le message est vide.",
      });
    }

    // ------------------------------------------------
    // INSTRUCTIONS PÉDAGOGIQUES
    // ------------------------------------------------

    const defaultSystemPrompt = `
Tu es Sterling IA, un assistant pédagogique spécialisé dans les études.

Ton rôle est d'aider l'élève à comprendre réellement ses cours et ses exercices.

Niveau de l'élève : ${level}
Mode demandé : ${mode}

Règles :

1. Réponds en français sauf si l'utilisateur demande une autre langue.

2. Explique les choses simplement et progressivement.

3. Pour un exercice de mathématiques ou de sciences :
   - identifie les données ;
   - explique la formule ou la méthode ;
   - fais les calculs étape par étape ;
   - donne le résultat final ;
   - vérifie rapidement la cohérence du résultat.

4. Ne saute pas directement au résultat lorsque l'utilisateur demande une explication.

5. Si une notion est difficile, donne un petit exemple simple.

6. Pour une correction :
   - indique ce qui est correct ;
   - explique les erreurs ;
   - montre comment améliorer la réponse.

7. Pour un résumé :
   - conserve les idées essentielles ;
   - utilise des titres et des listes lorsque cela aide.

8. Pour une méthode :
   - donne une procédure claire ;
   - numérote les étapes.

9. Si la question est ambiguë, explique ce qui manque au lieu d'inventer des informations.

10. Le niveau d'explication doit correspondre au niveau scolaire indiqué.

Sois précis, pédagogique, clair et encourage l'apprentissage.
`;

    const systemPrompt =
      typeof system === "string" && system.trim()
        ? system
        : defaultSystemPrompt;

    // ------------------------------------------------
    // APPEL FAL.AI
    // ------------------------------------------------

    console.log("Appel du modèle:", STUDY_MODEL);

    const result = await fal.subscribe(STUDY_MODEL, {
      input: {
        prompt: message,
        system_prompt: systemPrompt,
        max_completion_tokens: 4096,
        temperature: 0.4,
      },

      logs: true,

      onQueueUpdate(update) {
        console.log("FAL QUEUE:", update.status || "update");
      },
    });

    console.log("Réponse FAL reçue.");

    const output = result?.data?.output;

    if (!output) {
      console.error("Réponse FAL sans output:", result);

      return res.status(502).json({
        ok: false,
        error: "EMPTY_AI_RESPONSE",
        message: "Sterling IA n'a reçu aucune réponse du modèle.",
      });
    }

    console.log("Sterling IA répond correctement.");

    return res.json({
      ok: true,
      output,
    });
  } catch (error) {
    console.error("ERREUR /chat:");
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "CHAT_ERROR",
      message:
        error?.message ||
        "Une erreur est survenue pendant la communication avec Sterling IA.",
    });
  }
});

// --------------------------------------------------
// STERLING IMAGE
// --------------------------------------------------

app.post("/transform", upload.single("image"), async (req, res) => {
  console.log("======================================");
  console.log("STERLING IMAGE /transform");
  console.log("======================================");

  try {
    if (!process.env.FAL_KEY) {
      console.error("FAL_KEY absente.");

      return res.status(500).json({
        ok: false,
        error: "FAL_KEY_MISSING",
        message: "La clé FAL_KEY n'est pas configurée sur Render.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "IMAGE_MISSING",
        message: "Aucune image n'a été envoyée.",
      });
    }

    const prompt =
      req.body?.prompt ||
      "Improve and transform this image while preserving the main subject.";

    console.log("Prompt image:", prompt);
    console.log("Taille image:", req.file.size);

    // Conversion en Data URI
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${base64}`;

    console.log("Appel du modèle image:", IMAGE_MODEL);

    const result = await fal.subscribe(IMAGE_MODEL, {
      input: {
        image_urls: [dataUri],
        prompt,
      },

      logs: true,

      onQueueUpdate(update) {
        console.log("FAL IMAGE QUEUE:", update.status || "update");
      },
    });

    console.log("Réponse image FAL reçue.");

    const data = result?.data;

    if (!data) {
      console.error("Réponse image vide:", result);

      return res.status(502).json({
        ok: false,
        error: "EMPTY_IMAGE_RESPONSE",
        message: "Le modèle image n'a retourné aucun résultat.",
      });
    }

    // ------------------------------------------------
    // Recherche de l'URL générée
    // ------------------------------------------------

    let imageUrl = null;

    if (Array.isArray(data.images) && data.images.length > 0) {
      imageUrl = data.images[0]?.url || null;
    }

    if (!imageUrl && data.image?.url) {
      imageUrl = data.image.url;
    }

    if (!imageUrl && data.output?.url) {
      imageUrl = data.output.url;
    }

    if (!imageUrl && typeof data.output === "string") {
      imageUrl = data.output;
    }

    if (!imageUrl) {
      console.error("Impossible de trouver l'image:", data);

      return res.status(502).json({
        ok: false,
        error: "IMAGE_URL_MISSING",
        message: "Le modèle a répondu mais aucune image n'a été trouvée.",
        data,
      });
    }

    console.log("Image générée avec succès.");

    return res.json({
      ok: true,
      imageUrl,
      data,
    });
  } catch (error) {
    console.error("ERREUR /transform:");
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "TRANSFORM_ERROR",
      message:
        error?.message ||
        "Une erreur est survenue pendant la transformation de l'image.",
    });
  }
});

// --------------------------------------------------
// ERREUR MULTER
// --------------------------------------------------

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error("Erreur Multer:", error);

    return res.status(400).json({
      ok: false,
      error: "UPLOAD_ERROR",
      message: error.message,
    });
  }

  next(error);
});

// --------------------------------------------------
// DÉMARRAGE
// --------------------------------------------------

app.listen(PORT, () => {
  console.log("======================================");
  console.log("STERLING BOX AI");
  console.log("======================================");
  console.log(`Port: ${PORT}`);
  console.log(`Assistant: /assistant.html`);
  console.log(`Image: /image.html`);
  console.log(`Chat: /chat`);
  console.log(`Transform: /transform`);
  console.log("Serveur prêt.");
});
