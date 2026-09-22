import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const AUTHORIZED_PARTY =
  "https://lum-ra.vercel.app";

async function authenticate(req) {
  const result =
    await clerk.authenticateRequest(req, {
      authorizedParties: [AUTHORIZED_PARTY]
    });

  if (!result.isAuthenticated) {
    throw new Error("Unauthorized");
  }

  return result.toAuth();
}

async function supabaseRpc(
  functionName,
  body
) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization:
          `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      text ||
      "Supabase request failed"
    );
  }

  return data;
}

async function getEntitlements(email) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(
      email
    )}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at`,
    {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization:
          `Bearer ${SUPABASE_SECRET_KEY}`
      }
    }
  );

  const text = await response.text();

  let rows = [];

  try {
    rows = text ? JSON.parse(text) : [];
  } catch {}

  if (!response.ok) {
    throw new Error(
      "Could not check Luméra account access."
    );
  }

  return Array.isArray(rows)
    ? rows
    : [];
}

function hasAccess(rows) {
  const now = Date.now();

  const subscription = rows.find(row =>
    (row.plan === "standard" ||
      row.plan === "pro") &&
    row.status === "active" &&
    row.expires_at &&
    new Date(row.expires_at).getTime() >
      now
  );

  if (subscription) {
    return {
      allowed: true,
      plan: subscription.plan,
      subscription: true
    };
  }

  const credits = rows
    .filter(
      row =>
        row.plan === "3_scan_pass" &&
        row.status === "active"
    )
    .reduce(
      (sum, row) =>
        sum +
        Number(row.scan_remaining || 0),
      0
    );

  return credits > 0
    ? {
        allowed: true,
        plan: "3_scan_pass",
        subscription: false,
        scan_credits: credits
      }
    : {
        allowed: false,
        plan: null,
        subscription: false,
        scan_credits: 0
      };
}

function parseAnalysis(outputText) {
  const cleaned = String(
    outputText || ""
  )
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function callOpenAI(image) {
  const primaryModel =
    process.env.LUMERA_OPENAI_MODEL ||
    "gpt-5.6-luna";

  const models = [primaryModel];

  if (primaryModel !== "gpt-4.1-mini") {
    models.push("gpt-4.1-mini");
  }

  let lastError = null;

  for (const model of models) {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${OPENAI_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          model,

          input: [
            {
              role: "user",

              content: [
                {
                  type: "input_text",

                  text: `
You are Luméra, an AI cosmetic skincare analysis assistant.

Analyze ONLY visible facial skin characteristics in the supplied image.

Do not identify the person.

Do not diagnose diseases.

Do not prescribe medication.

Do not make medical claims.

Be conservative when the image is unclear.

Return ONLY JSON with exactly these keys:

{
  "score": number from 1 to 10,
  "summary": "short neutral visible-skin summary",
  "concerns": [
    "visible characteristic 1",
    "visible characteristic 2"
  ],
  "needs": [
    "cosmetic skincare need 1",
    "cosmetic skincare need 2"
  ],
  "morning_routine": [
    "step 1",
    "step 2",
    "step 3"
  ],
  "night_routine": [
    "step 1",
    "step 2",
    "step 3"
  ],
  "recommendations": [
    "specific product or brand category recommendation 1",
    "recommendation 2",
    "recommendation 3"
  ],
  "note": "short encouraging Luméra note"
}

For recommendations, use well-known international skincare brands when appropriate, including but not limited to:

Anua
Medicube
CeraVe
La Roche-Posay
The Ordinary
COSRX
Beauty of Joseon
Paula's Choice
Cetaphil
Eucerin
Laneige

Recommend products or product categories that logically match the visible characteristics.

Do not invent product ingredients.

Do not claim that a product will cure a medical condition.

If image quality limits the analysis, mention the uncertainty.

The recommendations should be practical skincare suggestions.

The note should encourage the user to check back with Luméra in about 3 days for another skin checkup.
`
                },

                {
                  type: "input_image",
                  image_url: image,
                  detail: "high"
                }
              ]
            }
          ],

          text: {
            format: {
              type: "json_object"
            }
          }
        })
      }
    );

    const text =
      await response.text();

    let data = null;

    try {
      data = text
        ? JSON.parse(text)
        : null;
    } catch {}

    if (response.ok) {
      const outputText =
        data?.output_text ||
        data?.output
          ?.flatMap(
            item =>
              item.content || []
          )
          .filter(
            item =>
              item.type ===
              "output_text"
          )
          .map(
            item => item.text
          )
          .join("\n") ||
        "";

      const analysis =
        parseAnalysis(outputText);

      if (analysis) {
        return analysis;
      }

      lastError = new Error(
        "Luméra received an invalid AI result."
      );
    } else {
      console.error(
        `OpenAI ${model} error:`,
        text
      );

      lastError = new Error(
        `OpenAI request failed (${response.status}).`
      );

      if (
        response.status !== 400 &&
        response.status !== 404
      ) {
        break;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Skin analysis service failed."
    )
  );
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({
        error: "Method not allowed"
      });
  }

  try {
    const auth =
      await authenticate(req);

    const user =
      await clerk.users.getUser(
        auth.userId
      );

    const email = (
      user.primaryEmailAddress
        ?.emailAddress ||
      user.emailAddresses?.[0]
        ?.emailAddress ||
      ""
    )
      .trim()
      .toLowerCase();

    if (!email) {
      return res
        .status(400)
        .json({
          error:
            "No verified email on account"
        });
    }

    const image =
      req.body?.image;

    if (
      !image ||
      typeof image !== "string" ||
      !image.startsWith(
        "data:image/"
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "A valid scan image is required."
        });
    }

    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({
          error:
            "AI analysis is not configured."
        });
    }

    if (
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return res
        .status(500)
        .json({
          error:
            "Supabase is not configured."
        });
    }

    // Check paid access BEFORE using OpenAI.
    const rows =
      await getEntitlements(
        email
      );

    const access =
      hasAccess(rows);

    if (!access.allowed) {
      return res
        .status(403)
        .json({
          error:
            "No active Luméra access or scan credits remaining."
        });
    }

    // OpenAI performs the actual
    // skin analysis and recommendations.
    const analysis =
      await callOpenAI(image);

    // Consume one 3-scan credit
    // ONLY after a successful AI result.
    //
    // Standard and Pro remain
    // unlimited while active.
    const entitlement =
      await supabaseRpc(
        "consume_lumera_scan",
        {
          p_email: email
        }
      );

    if (!entitlement?.allowed) {
      return res
        .status(403)
        .json({
          error:
            "Your Luméra access changed before the result could be delivered. Please try again."
        });
    }

    const score = Math.max(
      1,
      Math.min(
        10,
        Number(
          analysis.score
        ) || 1
      )
    );

    const result = {
      score,

      summary:
        analysis.summary ||
        "Visible skin characteristics were reviewed.",

      concerns:
        Array.isArray(
          analysis.concerns
        )
          ? analysis.concerns
          : [],

      needs:
        Array.isArray(
          analysis.needs
        )
          ? analysis.needs
          : [],

      morning_routine:
        Array.isArray(
          analysis.morning_routine
        )
          ? analysis.morning_routine
          : [],

      night_routine:
        Array.isArray(
          analysis.night_routine
        )
          ? analysis.night_routine
          : [],

      recommendations:
        Array.isArray(
          analysis.recommendations
        )
          ? analysis.recommendations
          : [],

      note:
        analysis.note ||
        "Check back with Luméra in about 3 days for another skin checkup.",

      disclaimer:
        "Luméra provides cosmetic skincare guidance and is not a medical diagnosis or substitute for professional medical advice."
    };

    return res.status(200).json({
      success: true,

      analysis: result,

      access: {
        email,

        plan:
          entitlement.plan ||
          access.plan,

        status: "active",

        scan_credits:
          Number(
            entitlement.scan_credits ??
              access.scan_credits ??
              0
          ),

        plan_expires_at:
          access.plan === "standard" ||
          access.plan === "pro"
            ? (
                rows.find(
                  r =>
                    r.plan ===
                      access.plan &&
                    r.status ===
                      "active"
                )?.expires_at ||
                null
              )
            : null
      }
    });
  } catch (error) {
    console.error(
      "Luméra analysis error:",
      error
    );

    return res
      .status(
        error.message ===
          "Unauthorized"
          ? 401
          : 500
      )
      .json({
        error:
          error.message ||
          "Skin analysis failed."
      });
  }
        }
