const MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function corsResponse(response) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(CORS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function stylePrompt(style) {
  switch (style) {
    case "manga":
      return `
Transform the provided person's photo into a high-quality Japanese manga illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing and overall composition.
Use clean professional black ink line art, manga screentones, expressive but natural facial details,
detailed hair, strong composition and polished manga artwork.
Do not add extra people.
Do not change the person's pose.
      `;

    case "anime":
      return `
Transform the provided person's photo into a high-quality anime illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing and overall composition.
Use clean anime line art, polished cel shading, detailed eyes, detailed hair,
professional Japanese animation artwork and high visual quality.
Do not add extra people.
Do not change the person's pose.
      `;

    case "cartoon":
      return `
Transform the provided person's photo into a polished professional cartoon illustration.
Preserve the person's identity, facial structure, hairstyle, pose, clothing and overall composition.
Use clean expressive line art, appealing shapes, smooth colors and high-quality cartoon rendering.
Do not add extra people.
Do not change the person's pose.
      `;

    default:
      return `
Edit the provided image according to the user's instructions.
Preserve the person's identity, facial structure, pose and important details unless the user explicitly asks for a change.
Create a clean, high-quality finished image.
      `;
  }
}

export default {
  async fetch(request, env) {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    const url = new URL(request.url);

    // Simple health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Sterling Box Image AI",
        model: MODEL,
      });
    }

    // Only our transformation endpoint
    if (url.pathname !== "/transform") {
      return json({
        ok: true,
        message: "Sterling Box Image AI is online.",
      });
    }

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed",
        },
        405
      );
    }

    try {
      if (!env.AI) {
        return json(
          {
            ok: false,
            error:
              "Workers AI n'est pas connecté à ce Worker. La liaison AI doit être configurée dans Cloudflare.",
          },
          500
        );
      }

      const incoming = await request.formData();

      const image = incoming.get("image");
      const style = String(incoming.get("style") || "custom");
      const customPrompt = String(incoming.get("prompt") || "");

      if (!(image instanceof File)) {
        return json(
          {
            ok: false,
            error: "Aucune image n'a été reçue.",
          },
          400
        );
      }

      if (image.size === 0) {
        return json(
          {
            ok: false,
            error: "L'image reçue est vide.",
          },
          400
        );
      }

      // Prompt de base selon le mode choisi
      const basePrompt = stylePrompt(style);

      // Prompt utilisateur
      const finalPrompt = `
${basePrompt}

IMPORTANT:
The result must remain based on the provided source image.

User's additional instructions:
${customPrompt || "No additional instructions."}
      `.trim();

      // Formulaire multipart attendu par FLUX.2
      const modelForm = new FormData();

      modelForm.append("prompt", finalPrompt);

      // FLUX.2 klein accepte l'image de référence sous input_image_0
      modelForm.append(
        "input_image_0",
        image,
        image.name || "sterling-box-input.jpg"
      );

      // Taille de sortie
      modelForm.append("width", "1024");
      modelForm.append("height", "1024");

      // Guidance
      modelForm.append("guidance", "3.5");

      /*
       * FormData doit être sérialisé par Request/Response
       * pour obtenir le bon boundary multipart.
       */
      const serialized = new Response(modelForm);

      const body = serialized.body;
      const contentType = serialized.headers.get("content-type");

      if (!body || !contentType) {
        throw new Error("Impossible de préparer la requête multipart.");
      }

      // Appel réel à Workers AI
      const result = await env.AI.run(MODEL, {
        multipart: {
          body,
          contentType,
        },
      });

      /*
       * FLUX.2 klein retourne normalement :
       * {
       *   image: "BASE64..."
       * }
       */

      if (result && typeof result === "object" && result.image) {
        return json({
          ok: true,
          image: result.image,
        });
      }

      // Sécurité au cas où Cloudflare renvoie directement un flux
      if (result instanceof ReadableStream) {
        return corsResponse(
          new Response(result, {
            headers: {
              "Content-Type": "image/png",
            },
          })
        );
      }

      return json({
        ok: false,
        error: "Réponse inattendue de Workers AI.",
        result,
      }, 500);

    } catch (error) {
      console.error("Sterling Box AI error:", error);

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
