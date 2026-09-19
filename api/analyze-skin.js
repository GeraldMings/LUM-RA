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
        error: "No skin image was provided."
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not configured."
      });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `
You are Luméra's skincare analysis assistant.

Analyze the person's visible facial skin from the provided image.

IMPORTANT:
- This is cosmetic skincare guidance, NOT a medical diagnosis.
- Only describe things that are reasonably visible.
- Do not claim certainty about diseases or medical conditions.
- Do not identify the person.
- If the image is unclear, say so.

Return ONLY valid JSON in exactly this structure:

{
  "score": 0,
  "summary": "",
  "concerns": [],
  "needs": [],
  "routine": {
    "morning": [],
    "night": []
  },
  "recommendations": []
}

Rules:
- "score" must be a number from 0 to 10.
- "summary" should briefly describe the visible skin.
- "concerns" should contain visible skincare concerns such as acne-like blemishes, uneven tone, visible dryness, oiliness, texture, or dark spots when applicable.
- "needs" should explain what the skin appears to need.
- "morning" and "night" should contain practical skincare steps.
- "recommendations" should contain suitable skincare product categories and, where appropriate, well-known international brands.
- Do not invent a product if you are unsure.
- Keep the recommendations realistic and gentle.
`
              },
              {
                type: "input_image",
                image_url: image
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);

      return res.status(500).json({
        error: "Skin analysis failed."
      });
    }

    const text =
      data.output?.[0]?.content?.find(
        item => item.type === "output_text"
      )?.text;

    if (!text) {
      return res.status(500).json({
        error: "No analysis was returned."
      });
    }

    let analysis;

    try {
      analysis = JSON.parse(text);
    } catch {
      console.error("Invalid AI JSON:", text);

      return res.status(500).json({
        error: "The AI returned an invalid analysis."
      });
    }

    return res.status(200).json(analysis);

  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      error: "Something went wrong while analyzing the skin."
    });
  }
}
