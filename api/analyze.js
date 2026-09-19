export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { image } = req.body || {};

    if (!image) {
      return res.status(400).json({
        error: "No image was provided."
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OpenAI API key is not configured."
      });
    }

    // Make sure the image is a data URL
    if (!image.startsWith("data:image/")) {
      return res.status(400).json({
        error: "Invalid image format."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },

        body: JSON.stringify({
          model: "gpt-5.6-luna",

          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: `
You are Luméra, a skincare guidance assistant.

Analyze the provided facial image only for visible, non-diagnostic
skin characteristics.

Do NOT claim to diagnose diseases or medical conditions.
Do NOT identify the person's identity.
Do NOT infer sensitive personal characteristics.

Focus on visible characteristics such as:
- apparent hydration
- visible dryness
- visible oiliness
- visible blemishes
- apparent redness
- visible texture
- visible pores
- visible uneven-looking tone

The image may have limitations because of lighting, camera quality,
makeup, filters, shadows, or image angle. Mention uncertainty when
appropriate.

Give general skincare guidance, not medical diagnosis.

Return ONLY valid JSON using exactly this structure:

{
  "score": 0,
  "concerns": [],
  "needs": [],
  "morningRoutine": [],
  "eveningRoutine": [],
  "recommendations": [],
  "note": ""
}

Rules:

- score must be a number from 1 to 10.
- concerns must contain short descriptions of visible characteristics.
- needs must contain general skincare needs.
- morningRoutine must contain practical general steps.
- eveningRoutine must contain practical general steps.
- recommendations must contain skincare product categories or
  ingredients rather than claiming a specific product is medically
  necessary.
- note should remind the user that this is not a medical diagnosis
  and that persistent, severe, painful, or concerning skin problems
  should be assessed by a qualified healthcare professional.
- Never say the user definitely has acne, eczema, rosacea, infection,
  or another medical condition based only on this image.
`
                }
              ]
            },

            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `
Analyze this facial image for Luméra.

Give a concise, useful skincare snapshot based only on what is
visibly apparent.
`
                },

                {
                  type: "input_image",
                  image_url: image
                }
              ]
            }
          ],

          max_output_tokens: 1000
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);

      return res.status(500).json({
        error: "The AI analysis could not be completed.",
        details: data?.error?.message || "Unknown OpenAI error."
      });
    }

    // Extract the model's text response
    let outputText = "";

    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (!Array.isArray(item.content)) continue;

        for (const content of item.content) {
          if (
            content.type === "output_text" &&
            typeof content.text === "string"
          ) {
            outputText += content.text;
          }
        }
      }
    }

    if (!outputText) {
      return res.status(500).json({
        error: "Luméra received an empty AI response."
      });
    }

    // Remove possible markdown code fences
    outputText = outputText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let analysis;

    try {
      analysis = JSON.parse(outputText);
    } catch (parseError) {
      console.error(
        "Could not parse OpenAI JSON:",
        outputText
      );

      return res.status(500).json({
        error: "Luméra received an invalid analysis format."
      });
    }

    // Basic validation
    const score = Number(analysis.score);

    if (
      !Number.isFinite(score) ||
      score < 1 ||
      score > 10
    ) {
      analysis.score = 5;
    } else {
      analysis.score = Math.round(score * 10) / 10;
    }

    analysis.concerns =
      Array.isArray(analysis.concerns)
        ? analysis.concerns
        : [];

    analysis.needs =
      Array.isArray(analysis.needs)
        ? analysis.needs
        : [];

    analysis.morningRoutine =
      Array.isArray(analysis.morningRoutine)
        ? analysis.morningRoutine
        : [];

    analysis.eveningRoutine =
      Array.isArray(analysis.eveningRoutine)
        ? analysis.eveningRoutine
        : [];

    analysis.recommendations =
      Array.isArray(analysis.recommendations)
        ? analysis.recommendations
        : [];

    analysis.note =
      typeof analysis.note === "string"
        ? analysis.note
        : "This is general skincare guidance and not a medical diagnosis.";

    return res.status(200).json({
      success: true,
      analysis
    });

  } catch (error) {

    console.error("Luméra analyze error:", error);

    return res.status(500).json({
      error:
        "Something went wrong while analyzing the image."
    });
  }
        }
