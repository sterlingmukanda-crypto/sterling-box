
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
      transform: "/transform",
      understandImage: "/understand-image"
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
  console.log("========== STERLING IA /chat ==========");

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
      mode = "general",
      level = "adaptatif",
      subject = "Général",
      history = []
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Message vide."
      });
    }

    const historyText = Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            ["user", "assistant"].includes(item.role) &&
            typeof item.content === "string"
          )
          .slice(-12)
          .map(item =>
            `${item.role === "user" ? "Utilisateur" : "Sterling Box IA"}: ${item.content}`
          )
          .join("\n\n")
      : "";

    const prompt = `
Tu es Sterling Box IA, un assistant utile, clair, respectueux et fiable.

Réponds en français sauf si l'utilisateur demande une autre langue.
Explique les étapes quand cela facilite l'apprentissage.
N'invente pas de faits et indique les incertitudes.
Adapte tes explications au niveau de l'utilisateur.

Mode : ${mode}
Niveau : ${level}
Matière : ${subject}

${system || ""}

Historique récent :
${historyText || "Aucun historique précédent."}

Nouvelle question :
${String(message)}
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

    return res.json({
      ok: true,
      output,
      model: TEXT_MODEL
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
   ANALYSE D'IMAGE
   POST /understand-image
   FormData : image, question
========================= */

app.post(
  "/understand-image",
  upload.single("image"),
  async (req, res) => {
    console.log("========== STERLING IA /understand-image ==========");

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
          message: "Aucune image reçue. Le champ attendu est « image »."
        });
      }

      if (!req.file.mimetype.startsWith("image/")) {
        return res.status(400).json({
          ok: false,
          message: "Le fichier envoyé n'est pas une image valide."
        });
      }

      const question = String(
        req.body?.question ||
        "Décris cette image et explique ce qu'elle montre."
      );

      const system = String(req.body?.system || "");
      const mode = String(req.body?.mode || "general");
      const level = String(req.body?.level || "adaptatif");
      const subject = String(req.body?.subject || "Général");

      console.log("Image reçue :", req.file.originalname);
      console.log("Type :", req.file.mimetype);
      console.log("Taille :", req.file.size);
      console.log("Question :", question);

      const base64Image = req.file.buffer.toString("base64");

      // Utilise un modèle de compréhension multimodale :
      // le modèle doit pouvoir analyser les images en entrée.
      const interaction = await ai.interactions.create({
        model: TEXT_MODEL,
        input: [
          {
            type: "text",
            text: `
Tu es Sterling Box IA, un assistant capable d'analyser des images.

Mode : ${mode}
Niveau : ${level}
Matière : ${subject}

${system}

Examine attentivement l'image fournie et réponds à la question de l'utilisateur :
${question}

Si l'image contient un exercice scolaire, lis ce qui est visible et explique
la résolution étape par étape. Si une partie est illisible, indique-le
plutôt que d'inventer son contenu. Réponds en français sauf demande contraire.
`
          },
          {
            type: "image",
            mime_type: req.file.mimetype,
            data: base64Image
          }
        ]
      });

      const output = interaction.output_text || "";

      if (!output.trim()) {
        return res.status(502).json({
          ok: false,
          message: "Le modèle n'a retourné aucune analyse de l'image."
        });
      }

      console.log("Analyse de l'image terminée.");

      return res.json({
        ok: true,
        output,
        model: TEXT_MODEL
      });

    } catch (error) {
      console.error("ERREUR /understand-image:", error);

      return res.status(500).json({
        ok: false,
        message: error?.message || "Erreur lors de l'analyse de l'image.",
        status: error?.status || null
      });
    }
  }
);

/* =========================
   TRANSFORMATION D'IMAGE
   POST /transform
========================= */

app.post("/transform", upload.single("image"), async (req, res) => {
  console.log("========== STERLING IMAGE /transform ==========");

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

    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        ok: false,
        message: "Le fichier fourni n'est pas une image valide."
      });
    }

    const prompt = String(
      req.body?.prompt ||
      "Améliore cette image naturellement en conservant ses éléments importants."
    );

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
      if (step.type !== "model_output") continue;

      for (const contentBlock of step.content || []) {
        if (contentBlock.type === "image") {
          generatedImage = contentBlock;
        }
      }
    }

    if (!generatedImage?.data) {
      return res.status(502).json({
        ok: false,
        message: "Le modèle n'a retourné aucune image générée."
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
   ERREURS MULTER / SERVEUR
========================= */

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      message: `Erreur fichier : ${error.message}`
    });
  }

  console.error("ERREUR SERVEUR:", error);

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
  console.log("Port :", PORT);
  console.log("Assistant :", "/assistant.html");
  console.log("Image :", "/image.html");
  console.log("Chat :", "/chat");
  console.log("Analyse d'image :", "/understand-image");
  console.log("Transformation :", "/transform");
  console.log("Modèle texte :", TEXT_MODEL);
  console.log("Modèle image :", IMAGE_MODEL);
  console.log(
    "GEMINI_API_KEY :",
    process.env.GEMINI_API_KEY ? "CONFIGURÉE" : "ABSENTE"
  );
  console.log("Serveur prêt.");
});
  
