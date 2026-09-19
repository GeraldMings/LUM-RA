export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        error: "No image was provided."
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
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `
You are Luméra, a skincare analysis assistant.

Analyze the visible characteristics of the person's facial skin in the provided image.

Do NOT diagnose medical conditions.

Give practical, general skincare guidance based only on what is visibly apparent.

Return ONLY valid JSON in exactly this structure:

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
- concerns should contain short descriptions of visible skin concerns.
- needs should explain what the skin may benefit from.
- morningRoutine should contain practical skincare steps.
- eveningRoutine should contain practical skincare steps.
- recommendations should contain well-known skincare product categories or brands when appropriate.
- note should be a short encouraging message.
- Do not claim certainty about medical conditions.
- Do not identify the person's identity.
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

      return res.status(response.status).json({
        success: false,
        error: data?.error?.message || "OpenAI analysis failed."
      });
    }

    let outputText = "";

    if (data.output) {
      for (const item of data.output) {
        if (!item.content) continue;

        for (const content of item.content) {
          if (content.type === "output_text") {
            outputText += content.text;
          }
        }
      }
    }

    if (!outputText) {
      throw new Error("OpenAI returned no analysis.");
    }

    // Remove possible markdown code fences
    outputText = outputText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const analysis = JSON.parse(outputText);

    // Basic validation
    analysis.score = Math.max(
      1,
      Math.min(10, Number(analysis.score) || 1)
    );

    analysis.concerns = Array.isArray(analysis.concerns)
      ? analysis.concerns
      : [];

    analysis.needs = Array.isArray(analysis.needs)
      ? analysis.needs
      : [];

    analysis.morningRoutine = Array.isArray(
      analysis.morningRoutine
    )
      ? analysis.morningRoutine
      : [];

    analysis.eveningRoutine = Array.isArray(
      analysis.eveningRoutine
    )
      ? analysis.eveningRoutine
      : [];

    analysis.recommendations = Array.isArray(
      analysis.recommendations
    )
      ? analysis.recommendations
      : [];

    analysis.note =
      typeof analysis.note === "string"
        ? analysis.note
        : "";

    return res.status(200).json({
      success: true,
      analysis
    });

  } catch (error) {
    console.error("Luméra API error:", error);

    return res.status(500).json({
      success: false,
      error: "Luméra could not analyze the image."
    });
  }
      }
