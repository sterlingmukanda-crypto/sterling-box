
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

if (!process.env.GEMINI_API_KEY) {
  console.warn("ATTENTION : GEMINI_API_KEY est absente.");
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return callback(new Error("Le fichier doit être une image."));
    }
    callback(null, true);
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
   PROMPT DE PRÉCISION VISUELLE
========================= */

function buildVisionPrompt({
  question,
  system = "",
  mode = "general",
  level = "adaptatif",
  subject = "Général"
}) {
  return `
Tu es Sterling Box IA, un assistant multimodal qui doit analyser les images
avec rigueur, précision et honnêteté.

OBJECTIF PRINCIPAL
Réponds à la question de l'utilisateur en t'appuyant sur les détails
réellement visibles dans l'image. Ne te contente pas d'une description
générale lorsque la question demande une identification précise.

MÉTHODE D'OBSERVATION

1. OBSERVER L'IMAGE ENTIÈRE
- Examine la scène entière avant de répondre.
- Repère les personnes, personnages dessinés, animaux, objets, textes,
  vêtements, accessoires, couleurs, arrière-plan et actions visibles.
- Distingue les éléments du premier plan de ceux de l'arrière-plan.
- Repère combien d'éléments distincts sont clairement visibles.
- Ne confonds pas un objet partiellement caché avec un autre objet.

2. DISTINGUER LES PERSONNAGES
- Si plusieurs personnages sont présents, examine chacun séparément.
- Utilise leur position dans l'image pour les distinguer :
  par exemple, « personnage à gauche », « personnage au centre »,
  « personnage à droite ».
- Compare les cheveux, la coiffure, les vêtements, les accessoires,
  les couleurs, la silhouette et les caractéristiques visuelles distinctives.
- Ne transfère pas les caractéristiques d'un personnage à un autre.
- Ne suppose pas que deux personnages sont identiques simplement parce
  qu'ils ont des vêtements, des couleurs ou des visages similaires.
- Pour les personnages fictifs, donne un nom uniquement si les indices
  visuels et le contexte permettent une identification suffisamment fiable.
- Si plusieurs personnages se ressemblent, explique les différences visibles
  et précise si leur identité exacte demeure incertaine.
- Ne présente pas une supposition comme une certitude.

3. EXAMINER LES OBJETS ET LES DÉTAILS
- Décris les objets selon leur forme, leur couleur, leur position,
  leur taille relative et leurs caractéristiques visibles.
- Distingue les objets similaires au lieu de les regrouper sans raison.
- Ne prétends pas voir un détail trop petit, flou, masqué ou hors cadre.
- Si un objet ne peut pas être identifié précisément, donne sa catégorie
  générale et explique quel détail reste incertain.

4. LIRE LE TEXTE DANS L'IMAGE
- Recopie les mots ou inscriptions uniquement lorsqu'ils sont lisibles.
- Respecte autant que possible l'orthographe, les nombres et les symboles.
- Ne complète pas arbitrairement un texte coupé ou flou.
- Signale les passages impossibles à lire avec confiance.

5. VÉRIFIER AVANT DE RÉPONDRE
- Vérifie que chaque caractéristique mentionnée correspond au bon élément.
- Vérifie les positions relatives et les couleurs.
- Distingue les observations directes des interprétations.
- Cherche les contradictions entre la question et ce qui est visible.
- Si la résolution ne permet pas de vérifier un détail, dis-le clairement.
- N'invente jamais des objets, des accessoires, des vêtements, des noms,
  des actions ou des inscriptions pour rendre la réponse plus complète.

6. IDENTIFICATION DE PERSONNAGES FICTIFS
- Si l'utilisateur donne un nom, vérifie visuellement si les caractéristiques
  de l'image sont compatibles avec ce nom.
- Si l'image montre un personnage d'anime, de dessin animé, de jeu vidéo
  ou d'une autre œuvre fictive, explique les indices visuels utiles.
- Si tu ne peux pas départager deux identités possibles, indique les
  possibilités uniquement si elles sont raisonnablement étayées.
- N'invente pas de titre d'œuvre, de nom ou de pouvoir.
- Une ressemblance visuelle n'est pas une preuve définitive d'identité.

7. FORMAT DE RÉPONSE
Adapte la longueur à la question :
- Pour une question précise, réponds directement puis justifie la réponse.
- Pour une analyse détaillée, organise la réponse avec des titres.
- Pour plusieurs personnages ou objets, fais une liste séparée pour chacun.
- Pour un exercice scolaire, lis l'énoncé visible et explique les étapes.
- Si l'utilisateur demande une description complète, détaille la scène,
  les éléments importants et leurs relations.
- Évite les répétitions et les détails sans rapport avec la question.

NIVEAU DE PRÉCISION
Mode : ${mode}
Niveau : ${level}
Matière : ${subject}

Instructions supplémentaires :
${system || "Aucune instruction supplémentaire."}

QUESTION DE L'UTILISATEUR
${question || "Décris précisément cette image."}

IMPORTANT
La précision est plus importante que la quantité de détails.
Lorsque tu ne sais pas, dis-le. Ne prétends jamais avoir vérifié un détail
qui n'est pas réellement discernable dans l'image.
Réponds en français sauf si l'utilisateur demande une autre langue.
`;
}

/* =========================
   GESTION DES ERREURS
========================= */

function errorMessage(error) {
  const message = String(error?.message || "Erreur inconnue.");

  console.error("Erreur détaillée :", message);

  if (/API_KEY|api key|unauthorized|forbidden/i.test(message)) {
    return "La clé API Gemini est absente, invalide ou non autorisée.";
  }

  if (/quota|rate.?limit|resource.?exhausted/i.test(message)) {
    return "La limite d'utilisation de Gemini a été atteinte. Réessaie plus tard.";
  }

  if (/not found|404|model/i.test(message)) {
    return "Le modèle demandé n'est pas disponible ou son identifiant est invalide.";
  }

  return message.slice(0, 500);
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
    routes: {
      assistant: "/assistant.html",
      image: "/image.html",
      chat: "/chat",
      understandImage: "/understand-image",
      transform: "/transform"
    }
  });
});

/* =========================
   CHAT TEXTE
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

    const safeHistory = Array.isArray(history)
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
Réponds en français sauf demande contraire.
Explique les étapes lorsque cela facilite l'apprentissage.
N'invente pas de faits et indique les incertitudes.
Adapte tes explications au niveau de l'utilisateur.

Mode : ${mode}
Niveau : ${level}
Matière : ${subject}

Instructions supplémentaires :
${system}

Historique récent :
${safeHistory || "Aucun historique précédent."}

Nouveau message :
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
    console.error("ERREUR /chat :", error);

    return res.status(500).json({
      ok: false,
      message: errorMessage(error)
    });
  }
});

/* =========================
   ANALYSE D'IMAGE
   POST /understand-image

   Champs multipart :
   - image
   - question
   - system (facultatif)
   - mode, level, subject (facultatifs)
========================= */

app.post(
  "/understand-image",
  upload.single("image"),
  async (req, res) => {
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

      const supportedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif"
      ];

      if (!supportedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          ok: false,
          message: "Format d'image non pris en charge. Utilise JPEG, PNG ou WebP."
        });
      }

      const question = String(
        req.body?.question ||
        "Décris cette image avec précision."
      ).slice(0, 5000);

      const system = String(req.body?.system || "").slice(0, 5000);
      const mode = String(req.body?.mode || "general").slice(0, 100);
      const level = String(req.body?.level || "adaptatif").slice(0, 100);
      const subject = String(req.body?.subject || "Général").slice(0, 200);

      console.log("========== ANALYSE D'IMAGE ==========");
      console.log("Nom :", req.file.originalname);
      console.log("Type :", req.file.mimetype);
      console.log("Taille :", req.file.size, "octets");
      console.log("Mode :", mode);
      console.log("Question :", question);

      const base64Image = req.file.buffer.toString("base64");

      const prompt = buildVisionPrompt({
        question,
        system,
        mode,
        level,
        subject
      });

      const interaction = await ai.interactions.create({
        model: TEXT_MODEL,
        input: [
          {
            type: "text",
            text: prompt
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
          message: "Gemini n'a retourné aucune analyse de l'image."
        });
      }

      console.log("Analyse terminée.");
      console.log("Longueur de la réponse :", output.length);

      return res.json({
        ok: true,
        output,
        model: TEXT_MODEL
      });

    } catch (error) {
      console.error("ERREUR /understand-image :", error);

      return res.status(500).json({
        ok: false,
        message: errorMessage(error)
      });
    }
  }
);

/* =========================
   TRANSFORMATION D'IMAGE
   POST /transform
========================= */

app.post("/transform", upload.single("image"), async (req, res) => {
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
    ).slice(0, 5000);

    const base64Image = req.file.buffer.toString("base64");

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: [
        {
          type: "text",
          text: prompt
        },
        {
          type: "image",
          mime_type: req.file.mimetype,
          data: base64Image
        }
      ]
    });

    let generatedImage = null;

    for (const step of interaction.steps || []) {
      if (step.type !== "model_output") continue;

      for (const block of step.content || []) {
        if (block.type === "image") {
          generatedImage = block;
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
    console.error("ERREUR /transform :", error);

    return res.status(500).json({
      ok: false,
      message: errorMessage(error)
    });
  }
});

/* =========================
   ERREURS MULTER / SERVEUR
========================= */

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

  console.error("ERREUR SERVEUR :", error);

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
  console.log("Chat :", "/chat");
  console.log("Analyse visuelle :", "/understand-image");
  console.log("Transformation :", "/transform");
  console.log("Modèle texte/vision :", TEXT_MODEL);
  console.log("Modèle de génération d'image :", IMAGE_MODEL);
  console.log(
    "GEMINI_API_KEY :",
    process.env.GEMINI_API_KEY ? "CONFIGURÉE" : "ABSENTE"
  );
  console.log("Serveur prêt.");
});
  
