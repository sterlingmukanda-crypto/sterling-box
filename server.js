import express from "express";
import cors from "cors";
import multer from "multer";
import { fal } from "@fal-ai/client";

const app = express();

const PORT = process.env.PORT || 3000;

const IMAGE_MODEL =
  "fal-ai/flux-2/klein/9b/edit";

const STUDY_MODEL =
  "fal-ai/bytedance/seed/v2/mini";


/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({
  limit: "10mb"
}));


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/", (req, res) => {

  res.json({
    ok: true,
    service: "Sterling Box AI",
    imageModel: IMAGE_MODEL,
    studyModel: STUDY_MODEL
  });

});


/* =========================================================
   IA ÉTUDES
   ========================================================= */

app.post("/chat", async (req, res) => {

  try {

    if (!process.env.FAL_KEY) {

      console.error(
        "FAL_KEY absente de l'environnement Render."
      );

      return res.status(500).json({
        ok: false,
        error: "FAL_KEY non configurée sur Render."
      });

    }


    const message =
      String(req.body.message || "").trim();

    const system =
      String(req.body.system || "").trim();

    const mode =
      String(req.body.mode || "devoir");

    const level =
      String(req.body.level || "Collège");


    if (!message) {

      return res.status(400).json({
        ok: false,
        error: "Aucune question reçue."
      });

    }


    const defaultSystem = `
Tu es Sterling IA, l'assistant pédagogique de Sterling Box.

Tu aides les élèves à comprendre leurs cours et leurs exercices.

Niveau scolaire :
${level}

Mode :
${mode}

Règles pédagogiques :

- Explique avant de donner une réponse finale lorsque c'est pertinent.
- Décompose les problèmes complexes en étapes simples.
- Pour les mathématiques, montre les calculs.
- Pour les sciences, explique les concepts avec des exemples.
- Pour les langues, explique les erreurs et les corrections.
- Adapte le vocabulaire au niveau de l'élève.
- Si la question est ambiguë, indique clairement ce qui manque.
- Vérifie ton raisonnement avant de répondre.
- Ne prétends pas avoir effectué une action que tu n'as pas effectuée.
- Reste clair, structuré et pédagogique.
`;


    const systemPrompt =
      system || defaultSystem;


    console.log(
      "STERLING IA /chat - mode:",
      mode,
      "- niveau:",
      level
    );


    const result = await fal.subscribe(
      STUDY_MODEL,
      {
        input: {

          prompt: message,

          system_prompt:
            systemPrompt,

          max_completion_tokens: 4096,

          temperature: 0.4

        },

        logs: true,

        onQueueUpdate: (update) => {

          if (
            update.status === "IN_PROGRESS" &&
            Array.isArray(update.logs)
          ) {

            update.logs
              .map(log => log.message)
              .forEach(msg => {
                console.log(
                  "fal.ai:",
                  msg
                );
              });

          }

        }

      }
    );


    const output =
      result?.data?.output;


    if (!output) {

      console.error(
        "Réponse IA inattendue :",
        result
      );

      return res.status(500).json({
        ok: false,
        error:
          "fal.ai n'a pas renvoyé de réponse textuelle."
      });

    }


    console.log(
      "STERLING IA réponse reçue."
    );


    return res.json({

      ok: true,

      answer: output,

      model: STUDY_MODEL

    });


  } catch (error) {

    console.error(
      "STERLING IA ERROR:",
      error
    );


    return res.status(500).json({

      ok: false,

      error:
        error instanceof Error
          ? error.message
          : String(error)

    });

  }

});


/* =========================================================
   IMAGE AI
   ========================================================= */

const STYLE_PROMPTS = {

  manga: `
Transform this photo into a professional Japanese manga illustration.

Preserve the person's identity, facial structure,
hairstyle, pose, clothing, body position
and overall composition.

Use clean black ink linework,
refined manga artwork, screentones
and professional shading.

Do not add another person.
Do not change the pose.
`,

  anime: `
Transform this photo into a high-quality Japanese anime illustration.

Preserve the person's identity,
facial structure, hairstyle, pose,
clothing, body position
and overall composition.

Use polished anime line art,
detailed hair, expressive natural eyes
and professional cel shading.

Do not add another person.
Do not change the pose.
`,

  cartoon: `
Transform this photo into a polished professional cartoon illustration.

Preserve the person's identity,
facial structure, hairstyle, pose,
clothing, body position
and overall composition.

Use clean expressive outlines,
appealing shapes
and high-quality cartoon rendering.

Do not add another person.
Do not change the pose.
`,

  custom: `
Edit this photo according to the user's instructions.

Preserve the person's identity
and important visual details unless
the user explicitly requests a change.

Create a clean, coherent,
professional final image.
`

};


app.post(
  "/transform",
  upload.single("image"),
  async (req, res) => {

    try {

      if (!process.env.FAL_KEY) {

        return res.status(500).json({
          ok: false,
          error:
            "FAL_KEY n'est pas configurée sur le serveur."
        });

      }


      if (!req.file) {

        return res.status(400).json({
          ok: false,
          error: "Aucune image reçue."
        });

      }


      const style =
        String(
          req.body.style || "custom"
        ).toLowerCase();


      const userPrompt =
        String(
          req.body.prompt || ""
        ).trim();


      const basePrompt =
        STYLE_PROMPTS[style] ||
        STYLE_PROMPTS.custom;


      const prompt = `
${basePrompt}

Additional user instructions:

${userPrompt ||
  "Apply the selected transformation naturally."}

The result must look like a real finished
illustration, not a simple color filter
or pixel effect.
      `.trim();


      const mime =
        req.file.mimetype ||
        "image/jpeg";


      const imageDataUrl =
        `data:${mime};base64,${req.file.buffer.toString("base64")}`;


      console.log(
        "STERLING IMAGE /transform - style:",
        style
      );


      const result =
        await fal.subscribe(
          IMAGE_MODEL,
          {

            input: {

              prompt,

              image_urls: [
                imageDataUrl
              ],

              num_images: 1

            },

            logs: true,

            onQueueUpdate: (update) => {

              if (
                update.status === "IN_PROGRESS" &&
                Array.isArray(update.logs)
              ) {

                update.logs
                  .map(log => log.message)
                  .forEach(msg => {
                    console.log(
                      "fal.ai image:",
                      msg
                    );
                  });

              }

            }

          }
        );


      const image =
        result?.data?.images?.[0];


      if (!image?.url) {

        console.error(
          "Réponse image fal.ai :",
          result
        );

        return res.status(500).json({

          ok: false,

          error:
            "fal.ai n'a pas renvoyé d'image."

        });

      }


      return res.json({

        ok: true,

        image: image.url

      });


    } catch (error) {

      console.error(
        "STERLING IMAGE ERROR:",
        error
      );


      return res.status(500).json({

        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error)

      });

    }

  }
);


/* =========================================================
   SERVER
   ========================================================= */

app.listen(PORT, () => {

  console.log(
    `Sterling Box AI server running on port ${PORT}`
  );

});
