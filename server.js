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

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  console.log(
    `REQUEST: ${req.method} ${req.url} origin: ${req.headers.origin || "-"}`
  );
  next();
});

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
    routes: {
      assistant: "/assistant.html",
      image: "/image.html",
      chat: "/chat",
      transform: "/transform"
    }
  });
});

/* =========================
   CHAT
========================= */

app.get("/chat", (req, res) => {
  res.json({
    ok: true,
    route: "/chat",
    model: TEXT_MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post("/chat", async (req, res) => {
  console.log("======================================");
  console.log("STERLING IA /chat");
  console.log("======================================");

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        ok: false,
        message: "GEMINI_API_KEY est absente de Render."
      });
    }

    const {
      message,
      system = "",
      mode = "devoir",
      level = "Autre",
      subject = "Général"
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Message vide."
      });
    }

    console.log("Mode:", mode);
    console.log("Niveau:", level);
    console.log("Matière:", subject);
    console.log("Message:", message);
    console.log("Modèle:", TEXT_MODEL);

    const pedagogicalPrompt = `
Tu es Sterling IA, un assistant pédagogique.

Ton rôle est d'aider les élèves à comprendre leurs cours,
leurs exercices et leurs devoirs.

Niveau scolaire : ${level}
Matière : ${subject}
Mode : ${mode}

Consignes :
- Réponds en français sauf si l'utilisateur demande une autre langue.
- Explique clairement et progressivement.
- Pour un exercice, montre les étapes du raisonnement.
- Ne donne pas seulement la réponse finale lorsqu'une explication est demandée.
- Utilise des exemples simples lorsque cela aide.
- Adapte ton vocabulaire au niveau scolaire.
- Si l'élève fait une erreur, explique-la calmement.
- Sois précis et pédagogique.

${system || ""}
`;

    const interaction = await ai.interactions.create({
      model: TEXT_MODEL,
      input: [
        {
          type: "text",
          text: pedagogicalPrompt
        },
        {
          type: "text",
          text: String(message)
        }
      ]
    });

    const output = interaction.output_text || "";

    console.log("Réponse Gemini reçue.");
    console.log("Longueur:", output.length);

    if (!output) {
      return res.status(502).json({
        ok: false,
        message: "Gemini n'a retourné aucune réponse."
      });
    }

    return res.json({
      ok: true,
      output,
      model: TEXT_MODEL
    });

  } catch (error) {
    console.error("ERREUR /chat:");
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: error?.message || "Erreur Gemini.",
      status: error?.status || null
    });
  }
});

/* =========================
   IMAGE
========================= */

app.post("/transform", upload.single("image"), async (req, res) => {
  console.log("======================================");
  console.log("STERLING IMAGE /transform");
  console.log("======================================");

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        ok: false,
        message: "GEMINI_API_KEY est absente de Render."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Aucune image reçue."
      });
    }

    const prompt = String(
      req.body?.prompt ||
      "Améliore cette image naturellement en conservant ses éléments importants."
    );

    console.log("Image reçue:", req.file.originalname);
    console.log("Type:", req.file.mimetype);
    console.log("Prompt:", prompt);
    console.log("Modèle:", IMAGE_MODEL);

    const base64Image = req.file.buffer.toString("base64");

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: [
        {
          type: "image",
          mime_type: req.file.mimetype,
          data: base64Image
        },
        {
          type: "text",
          text: prompt
        }
      ]
    });

    let generatedImage = null;

    for (const step of interaction.steps || []) {
      if (step.type !== "model_output") {
        continue;
      }

      for (const contentBlock of step.content || []) {
        if (contentBlock.type === "image") {
          generatedImage = contentBlock;
        }
      }
    }

    if (!generatedImage?.data) {
      console.error("Aucune image générée par Gemini.");

      return res.status(502).json({
        ok: false,
        message: "Gemini n'a retourné aucune image."
      });
    }

    console.log("Image Gemini reçue.");

    return res.json({
      ok: true,
      model: IMAGE_MODEL,
      image: `data:${generatedImage.mime_type || "image/png"};base64,${generatedImage.data}`
    });

  } catch (error) {
    console.error("ERREUR /transform:");
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: error?.message || "Erreur Gemini Image.",
      status: error?.status || null
    });
  }
});

/* =========================
   MULTER / SERVER ERRORS
========================= */

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      message: `Erreur fichier : ${error.message}`
    });
  }

  console.error("ERREUR SERVEUR:");
  console.error(error);

  return res.status(500).json({
    ok: false,
    message: error?.message || "Erreur serveur."
  });
});

/* =========================
   START
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
  console.log("Modèle texte:", TEXT_MODEL);
  console.log("Modèle image:", IMAGE_MODEL);
  console.log(
    "GEMINI_API_KEY:",
    process.env.GEMINI_API_KEY ? "CONFIGURÉE" : "ABSENTE"
  );
  console.log("Serveur prêt.");
});
