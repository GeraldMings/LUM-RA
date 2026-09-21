// api/analyze-skin.js

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const normalized = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const padded =
      normalized + "=".repeat((4 - normalized.length % 4) % 4);

    return JSON.parse(
      Buffer.from(padded, "base64").toString("utf8")
    );
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

async function verifyClerkUser(token) {
  const payload = decodeJwtPayload(token);

  if (!payload?.sid) {
    throw new Error("Invalid Clerk session.");
  }

  const sessionResponse = await fetch(
    `https://api.clerk.com/v1/sessions/${encodeURIComponent(payload.sid)}`,
    {
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (!sessionResponse.ok) {
    throw new Error("Clerk session could not be verified.");
  }

  const session = await sessionResponse.json();

  if (session.status !== "active") {
    throw new Error("Your Luméra session is no longer active.");
  }

  const userResponse = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(session.user_id)}`,
    {
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (!userResponse.ok) {
    throw new Error("Clerk user could not be retrieved.");
  }

  const user = await userResponse.json();

  const emailAddresses = user.email_addresses || [];

  const primary =
    emailAddresses.find(
      item => item.id === user.primary_email_address_id
    ) || emailAddresses[0];

  const email = primary?.email_address
    ?.toLowerCase()
    .trim();

  if (!email) {
    throw new Error("No email is attached to your Luméra account.");
  }

  return email;
}

async function consumeScan(email) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/consume_lumera_scan`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        account_email: email
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Luméra access check failed: ${errorText}`
    );
  }

  const result = await response.json();

  if (!Array.isArray(result) || !result.length) {
    throw new Error("Invalid Luméra access response.");
  }

  return result[0];
}

async function analyzeWithOpenAI(image) {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
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
Analyze the visible facial skin in this image for a cosmetic skincare
assessment.

Return ONLY valid JSON with this exact structure:

{
  "score": 0,
  "summary": "",
  "concerns": [],
  "needs": [],
  "morning_routine": [],
  "night_routine": [],
  "recommendations": []
}

Rules:
- score must be a number from 1 to 10.
- Focus only on visible skin characteristics.
- Do not diagnose medical conditions.
- Do not make claims about the person's health.
- Mention uncertainty where the image is unclear.
- concerns should describe visible cosmetic concerns.
- needs should describe skincare needs.
- morning_routine should contain practical skincare steps.
- night_routine should contain practical skincare steps.
- recommendations should contain suitable skincare product categories
  and examples of well-known international brands where appropriate.
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
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI analysis failed: ${errorText}`
    );
  }

  const data = await response.json();

  const text =
    data.output
      ?.flatMap(item => item.content || [])
      ?.filter(item => item.type === "output_text")
      ?.map(item => item.text)
      ?.join("") || "";

  if (!text) {
    throw new Error("No skin analysis was returned.");
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  let result;

  try {
    result = JSON.parse(cleaned);
  } catch {
    throw new Error("Skin analysis returned invalid data.");
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  if (
    !CLERK_SECRET_KEY ||
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY ||
    !OPENAI_API_KEY
  ) {
    return res.status(500).json({
      error: "Server configuration is incomplete."
    });
  }

  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Please sign in to use Luméra."
      });
    }

    const email = await verifyClerkUser(token);

    const { image } = req.body || {};

    if (!image || typeof image !== "string") {
      return res.status(400).json({
        error: "No facial image was provided."
      });
    }

    /*
     * Check payment entitlement BEFORE sending the image to OpenAI.
     *
     * Standard/Pro:
     *   scan is allowed while subscription is active.
     *
     * 3-Scan Pass:
     *   one scan credit is consumed.
     */
    const access = await consumeScan(email);

    if (!access.success) {
      return res.status(403).json({
        error:
          access.message ||
          "You do not have an active Luméra plan or scan credits.",
        scan_credits: access.scan_credits || 0,
        plan: access.plan || null
      });
    }

    const result = await analyzeWithOpenAI(image);

    return res.status(200).json({
      success: true,
      analysis: result,
      access: {
        plan: access.plan || null,
        scan_credits: access.scan_credits
      },
      disclaimer:
        "Luméra provides cosmetic skincare guidance and is not a medical diagnosis."
    });

  } catch (error) {
    console.error("Luméra analysis error:", error);

    return res.status(500).json({
      error:
        error.message ||
        "Something went wrong while analyzing your skin."
    });
  }
}
