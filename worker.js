const MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function getStylePrompt(style) {
  const prompts = {
    manga: `
Transform the supplied photo into a professional Japanese manga illustration.

Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.

Use clean black ink linework, refined manga drawing, controlled screentones,
professional shading and detailed manga artwork.

Do not add another person.
Do not change the pose.
Do not change the person's identity.
    `,

    anime: `
Transform the supplied photo into a high-quality Japanese anime illustration.

Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.

Use professional anime line art, clean cel shading, detailed hair,
expressive but natural eyes and polished animation artwork.

Do not add another person.
Do not change the pose.
Do not change the person's identity.
    `,

    cartoon: `
Transform the supplied photo into a polished professional cartoon illustration.

Preserve the person's identity, facial structure, hairstyle, pose, clothing,
body position and overall composition.

Use clean expressive outlines, appealing cartoon shapes,
professional rendering and high-quality illustration.

Do not add another person.
Do not change the pose.
Do not change the person's identity.
    `,

    custom: `
Edit the supplied photo according to the user's instructions.

Preserve the person's identity, facial structure, pose and important details
unless the user explicitly requests a change.

Create a clean, coherent, high-quality final image.
    `,
  };

  return prompts[style] || prompts.custom;
}

export default {
  async fetch(request, env) {
    // ─────────────────────────────
    // CORS
    // ─────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    // ─────────────────────────────
    // TEST DU WORKER
    // ─────────────────────────────
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Sterling Box Image AI",
        model: MODEL,
        message: "Worker opérationnel.",
      });
    }

    // ─────────────────────────────
    // ENDPOINT IA
    // ─────────────────────────────
    if (url.pathname !== "/transform") {
      return json({
        ok: true,
        message: "Sterling Box Image AI est en ligne.",
      });
    }

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Méthode non autorisée.",
        },
        405
      );
    }

    try {
      // Vérifie la liaison Workers AI
      if (!env.AI) {
        return json(
          {
            ok: false,
            error:
              "La liaison Workers AI 'AI' n'est pas disponible sur ce Worker.",
          },
          500
        );
      }

      // ─────────────────────────────
      // RÉCUPÉRATION DU FORMULAIRE
      // ─────────────────────────────
      const incoming = await request.formData();

      const image = incoming.get("image");
      const style = String(
        incoming.get("style") || "custom"
      ).toLowerCase();

      const userPrompt = String(
        incoming.get("prompt") || ""
      ).trim();

      if (!(image instanceof File)) {
        return json(
          {
            ok: false,
            error: "Aucune image reçue.",
          },
          400
        );
      }

      if (image.size <= 0) {
        return json(
          {
            ok: false,
            error: "L'image reçue est vide.",
          },
          400
        );
      }

      // ─────────────────────────────
      // CONSTRUCTION DU PROMPT
      // ─────────────────────────────
      const basePrompt = getStylePrompt(style);

      const finalPrompt = `
${basePrompt}

Additional user instructions:
${userPrompt || "Apply the selected transformation naturally."}

The final result must look like a finished professional image,
not a filter, not a pixelated effect and not a crude color manipulation.
      `.trim();

      // ─────────────────────────────
      // FORMULAIRE POUR FLUX.2
      // ─────────────────────────────
      const modelForm = new FormData();

      modelForm.append(
        "prompt",
        finalPrompt
      );

      modelForm.append(
        "input_image_0",
        image,
        image.name || "sterling-box-image.jpg"
      );

      // Sortie carrée haute qualité
      modelForm.append(
        "width",
        "1024"
      );

      modelForm.append(
        "height",
        "1024"
      );

      // Intensité de suivi du prompt
      modelForm.append(
        "guidance",
        "3.5"
      );

      /*
       * Cloudflare demande un vrai multipart/form-data
       * avec son boundary.
       *
       * Response(FormData) permet de récupérer :
       * - le body
       * - le Content-Type avec boundary
       */
      const serializedForm =
        new Response(modelForm);

      const body =
        serializedForm.body;

      const contentType =
        serializedForm.headers.get(
          "content-type"
        );

      if (!body || !contentType) {
        throw new Error(
          "Impossible de préparer la requête multipart."
        );
      }

      // ─────────────────────────────
      // APPEL À FLUX.2 [KLEIN] 9B
      // ─────────────────────────────
      const result = await env.AI.run(
        MODEL,
        {
          multipart: {
            body,
            contentType,
          },
        }
      );

      // ─────────────────────────────
      // RÉPONSE FLUX
      // ─────────────────────────────
      if (
        result &&
        typeof result === "object" &&
        result.image
      ) {
        return json({
          ok: true,
          image: result.image,
        });
      }

      // Sécurité si Cloudflare renvoie
      // directement un flux
      if (
        result instanceof ReadableStream
      ) {
        return new Response(result, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "image/png",
          },
        });
      }

      // Réponse inattendue
      return json(
        {
          ok: false,
          error:
            "Workers AI a renvoyé une réponse inattendue.",
        },
        500
      );
    } catch (error) {
      console.error(
        "STERLING BOX AI ERROR:",
        error
      );

      return json(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500
      );
    }
  },
};
