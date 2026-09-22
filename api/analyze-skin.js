import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const PRIMARY_MODEL =
  process.env.LUMERA_OPENAI_MODEL ||
  "gpt-5.6-luna";

const FALLBACK_MODEL =
  "gpt-4.1-mini";

const AUTHORIZED_PARTY =
  "https://lum-ra.vercel.app";


async function authenticate(req) {

  const result =
    await clerk.authenticateRequest(
      req,
      {
        authorizedParties: [
          AUTHORIZED_PARTY
        ]
      }
    );

  if (!result.isAuthenticated) {
    throw new Error("Unauthorized");
  }

  return result.toAuth();
}


async function supabase(
  path,
  options = {}
) {

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            SUPABASE_SECRET_KEY,

          Authorization:
            `Bearer ${SUPABASE_SECRET_KEY}`,

          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
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


async function getUserEmail(
  userId
) {

  const user =
    await clerk.users.getUser(
      userId
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
    throw new Error(
      "No email found on Clerk account."
    );
  }

  return email;
}


async function getEntitlements(
  email
) {

  return await supabase(
    `lumera_entitlements?email=eq.${encodeURIComponent(
      email
    )}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at`
  );
}


function hasActiveAccess(
  rows
) {

  const now =
    Date.now();

  const subscriptions =
    rows.filter(row =>
      (
        row.plan === "standard" ||
        row.plan === "pro"
      ) &&
      row.status === "active" &&
      row.expires_at &&
      new Date(
        row.expires_at
      ).getTime() > now
    );

  if (
    subscriptions.length > 0
  ) {
    return true;
  }

  const scanCredits =
    rows
      .filter(row =>
        row.plan ===
          "3_scan_pass" &&
        row.status === "active"
      )
      .reduce(
        (total, row) =>
          total +
          Number(
            row.scan_remaining || 0
          ),
        0
      );

  return scanCredits > 0;
}


async function consumeScan(
  email
) {

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/consume_lumera_scan`,
      {
        method: "POST",

        headers: {
          apikey:
            SUPABASE_SECRET_KEY,

          Authorization:
            `Bearer ${SUPABASE_SECRET_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            p_email:
              email
          })
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {}

  if (!response.ok) {

    throw new Error(
      data?.message ||
      data?.error ||
      text ||
      "Could not consume Luméra scan."
    );
  }

  return data;
}


function extractOutputText(
  response
) {

  if (
    typeof response?.output_text ===
    "string"
  ) {
    return response.output_text;
  }

  const pieces = [];

  for (
    const item of
    response?.output || []
  ) {

    for (
      const content of
      item?.content || []
    ) {

      if (
        typeof content?.text ===
        "string"
      ) {
        pieces.push(
          content.text
        );
      }
    }
  }

  return pieces.join("\n");
}


function cleanJsonText(
  text
) {

  if (!text) {
    throw new Error(
      "OpenAI returned no analysis."
    );
  }

  let cleaned =
    text.trim();

  if (
    cleaned.startsWith(
      "```"
    )
  ) {

    cleaned =
      cleaned
        .replace(
          /^```(?:json)?/i,
          ""
        )
        .replace(
          /```$/i,
          ""
        )
        .trim();
  }

  return cleaned;
}


async function callOpenAI(
  model,
  image
) {

  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not configured."
    );
  }

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${OPENAI_API_KEY}`
        },

        body:
          JSON.stringify({

            model,

            input: [

              {
                role: "system",

                content: [
                  {
                    type:
                      "input_text",

                    text:
`You are Luméra, an AI skincare analysis assistant.

Analyze the visible facial skin in the supplied image carefully and conservatively.

You are NOT a doctor and must not diagnose medical diseases or claim to cure medical conditions.

Do not infer sensitive personal characteristics.

Focus only on visible skincare-related observations such as:
- apparent dryness
- oiliness
- visible blemishes
- uneven-looking tone
- visible redness
- visible texture
- visible pores
- general skin appearance

Give practical skincare guidance.

Recommend suitable skincare products and ingredients from well-known international brands when appropriate.

Brands may include:
Anua,
Medicube,
CeraVe,
La Roche-Posay,
The Ordinary,
COSRX,
Beauty of Joseon,
Paula's Choice,
Cetaphil,
Eucerin,
Laneige,
and other reputable skincare brands.

Do not pretend that the image can reveal information that cannot actually be seen.

Return ONLY valid JSON with these exact keys:

{
  "score": 0,
  "summary": "",
  "concerns": [],
  "needs": [],
  "morning_routine": [],
  "night_routine": [],
  "recommendations": [],
  "note": ""
}

The score must be a number from 0 to 10.

The score represents the apparent overall skin condition from this image only, not medical health.

Keep recommendations practical and concise.

The note should encourage the user to check back with Luméra in about 3 days for another checkup.`
                  }
                ]
              },

              {
                role: "user",

                content: [

                  {
                    type:
                      "input_text",

                    text:
                      "Analyze this facial skin image and return the requested JSON."
                  },

                  {
                    type:
                      "input_image",

                    image_url:
                      image
                  }

                ]
              }

            ],

            text: {
              format: {
                type:
                  "json_object"
              }
            },

            max_output_tokens:
              1800
          })
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {}

  if (!response.ok) {

    const error =
      new Error(
        data?.error?.message ||
        data?.message ||
        text ||
        "OpenAI request failed."
      );

    error.status =
      response.status;

    throw error;
  }

  const outputText =
    extractOutputText(
      data
    );

  const cleaned =
    cleanJsonText(
      outputText
    );

  let analysis;

  try {

    analysis =
      JSON.parse(
        cleaned
      );

  } catch {

    throw new Error(
      "OpenAI returned invalid analysis JSON."
    );
  }

  return analysis;
}


function normalizeAnalysis(
  analysis
) {

  const score =
    Number(
      analysis?.score
    );

  const safeScore =
    Number.isFinite(score)
      ? Math.max(
          0,
          Math.min(
            10,
            score
          )
        )
      : 5;

  return {

    score:
      safeScore,

    summary:
      String(
        analysis?.summary ||
        "Luméra completed your visible skin analysis."
      ),

    concerns:
      Array.isArray(
        analysis?.concerns
      )
        ? analysis.concerns
            .map(String)
            .slice(0, 8)
        : [],

    needs:
      Array.isArray(
        analysis?.needs
      )
        ? analysis.needs
            .map(String)
            .slice(0, 8)
        : [],

    morning_routine:
      Array.isArray(
        analysis?.morning_routine
      )
        ? analysis.morning_routine
            .map(String)
            .slice(0, 8)
        : [],

    night_routine:
      Array.isArray(
        analysis?.night_routine
      )
        ? analysis.night_routine
            .map(String)
            .slice(0, 8)
        : [],

    recommendations:
      Array.isArray(
        analysis?.recommendations
      )
        ? analysis.recommendations
            .map(String)
            .slice(0, 12)
        : [],

    note:
      String(
        analysis?.note ||
        "Check back with Luméra in about 3 days for another skin checkup."
      )

  };
}


export default async function handler(
  req,
  res
) {

  if (
    req.method !== "POST"
  ) {

    return res
      .status(405)
      .json({
        error:
          "Method not allowed"
      });
  }

  try {

    const auth =
      await authenticate(req);

    const email =
      await getUserEmail(
        auth.userId
      );

    const image =
      req.body?.image;

    if (
      typeof image !==
      "string"
    ) {

      return res
        .status(400)
        .json({
          error:
            "No facial image was supplied."
        });
    }

    if (
      !image.startsWith(
        "data:image/"
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid facial image format."
        });
    }

    const entitlements =
      await getEntitlements(
        email
      );

    if (
      !hasActiveAccess(
        Array.isArray(
          entitlements
        )
          ? entitlements
          : []
      )
    ) {

      return res
        .status(403)
        .json({
          error:
            "No active Luméra access was found for this account.",
          code:
            "NO_LUMERA_ACCESS"
        });
    }

    let analysis;

    try {

      analysis =
        await callOpenAI(
          PRIMARY_MODEL,
          image
        );

    } catch (firstError) {

      console.warn(
        "Primary OpenAI model failed:",
        firstError
      );

      if (
        firstError.status !==
          400 &&
        firstError.status !==
          404
      ) {
        throw firstError;
      }

      analysis =
        await callOpenAI(
          FALLBACK_MODEL,
          image
        );
    }

    analysis =
      normalizeAnalysis(
        analysis
      );

    /*
      Only consume a 3-scan credit
      AFTER OpenAI successfully
      returns a valid analysis.

      Standard and Pro remain
      unlimited while active.
    */
    const access =
      await consumeScan(
        email
      );

    return res
      .status(200)
      .json({

        success:
          true,

        analysis,

        access

      });

  } catch (error) {

    console.error(
      "Luméra skin analysis error:",
      error
    );

    const message =
      error?.message ||
      "Skin analysis failed.";

    let status = 500;

    if (
      message ===
      "Unauthorized"
    ) {
      status = 401;
    }

    return res
      .status(status)
      .json({
        error:
          message
      });
  }
      }
