import express from "express";
import cors from "cors";
import multer from "multer";
import { fal } from "@fal-ai/client";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const MODEL = "fal-ai/flux-2/klein/9b/edit";

const STYLE_PROMPTS = {
  manga: `
Transform this photo into a professional Japanese manga illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.
Use clean black ink linework, refined manga artwork, screentones and professional shading.
Do not add another person.
Do not change the pose.
`,

  anime: `
Transform this photo into a high-quality Japanese anime illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.
Use polished anime line art, detailed hair, expressive natural eyes and professional cel shading.
Do not add another person.
Do not change the pose.
`,

  cartoon: `
Transform this photo into a polished professional cartoon illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.
Use clean expressive outlines, appealing shapes and high-quality cartoon rendering.
Do not add another person.
Do not change the pose.
`,

  custom: `
Edit this photo according to the user's instructions.
Preserve the person's identity and important visual details unless the user
explicitly requests a change.
Create a clean, coherent, professional final image.
`
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Sterling Box AI",
    model: MODEL
  });
});

app.post("/transform", upload.single("image"), async (req, res) => {
  try {
    if (!process.env.FAL_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAL_KEY n'est pas configurée sur le serveur."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Aucune image reçue."
      });
    }

    const style = String(req.body.style || "custom").toLowerCase();
    const userPrompt = String(req.body.prompt || "").trim();

    const basePrompt =
      STYLE_PROMPTS[style] || STYLE_PROMPTS.custom;

    const prompt = `
${basePrompt}

Additional user instructions:
${userPrompt || "Apply the selected transformation naturally."}

The result must look like a real finished illustration,
not a simple color filter or pixel effect.
    `.trim();

    /*
     * Convert the uploaded image to a data URL.
     * fal.ai can receive image data through its client.
     */
    const mime = req.file.mimetype || "image/jpeg";

    const imageDataUrl =
      `data:${mime};base64,${req.file.buffer.toString("base64")}`;

    const result = await fal.subscribe(MODEL, {
      input: {
        prompt,
        image_urls: [imageDataUrl],
        num_images: 1
      },
      logs: false
    });

    const image =
      result?.data?.images?.[0];

    if (!image?.url) {
      console.error("Réponse fal.ai :", result);

      return res.status(500).json({
        ok: false,
        error: "fal.ai n'a pas renvoyé d'image."
      });
    }

    return res.json({
      ok: true,
      image: image.url
    });

  } catch (error) {
    console.error("STERLING BOX AI ERROR:", error);

    return res.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Sterling Box AI server running on port ${PORT}`
  );
});
