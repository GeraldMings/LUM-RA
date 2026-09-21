import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    // =====================================================
    // 1. VERIFY CLERK SESSION
    // =====================================================

    const { isAuthenticated, toAuth } =
      await clerkClient.authenticateRequest(req, {
        authorizedParties: [
          "https://lum-ra.vercel.app",
          "https://lum-d7ipe8e2b-geraldmings.vercel.app"
        ]
      });

    if (!isAuthenticated) {
      return res.status(401).json({
        success: false,
        error: "You must be signed in."
      });
    }

    const auth = toAuth();
    const userId = auth.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Clerk user not found."
      });
    }

    // =====================================================
    // 2. GET USER EMAIL
    // =====================================================

    const user =
      await clerkClient.users.getUser(userId);

    const email =
      user.primaryEmailAddress?.emailAddress
        ?.trim()
        ?.toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "No email address found for this account."
      });
    }

    // =====================================================
    // 3. GET IMAGE
    // =====================================================

    const { image } = req.body || {};

    if (!image) {
      return res.status(400).json({
        success: false,
        error: "No image was provided."
      });
    }

    // =====================================================
    // 4. CHECK LUMÉRA ACCOUNT
    // =====================================================

    const accountResponse =
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(
          email
        )}&select=email,scan_credits,plan,plan_expires_at`,
        {
          method: "GET",
          headers: {
            apikey:
              process.env.SUPABASE_SECRET_KEY,

            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

    if (!accountResponse.ok) {
      const error =
        await accountResponse.text();

      console.error(
        "Luméra account lookup error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not check Luméra access."
      });
    }

    const accounts =
      await accountResponse.json();

    if (!accounts.length) {
      return res.status(403).json({
        success: false,
        error: "No Luméra access found."
      });
    }

    const account =
      accounts[0];

    const credits =
      Number(account.scan_credits || 0);

    const planActive =
      account.plan &&
      account.plan_expires_at &&
      new Date(account.plan_expires_at) > new Date();

    // =====================================================
    // 5. CONSUME ONE SCAN
    // =====================================================

    let remainingCredits =
      credits;

    if (!planActive) {

      if (credits <= 0) {
        return res.status(403).json({
          success: false,
          error: "No scans remaining."
        });
      }

      const updateResponse =
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(
            email
          )}`,
          {
            method: "PATCH",

            headers: {
              "Content-Type":
                "application/json",

              apikey:
                process.env.SUPABASE_SECRET_KEY,

              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`,

              Prefer:
                "return=representation"
            },

            body: JSON.stringify({
              scan_credits:
                credits - 1,

              updated_at:
                new Date().toISOString()
            })
          }
        );

      if (!updateResponse.ok) {
        const error =
          await updateResponse.text();

        console.error(
          "Scan credit update error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Could not use your scan."
        });
      }

      remainingCredits =
        credits - 1;
    }

    // =====================================================
    // 6. SEND FACE IMAGE TO OPENAI
    // =====================================================

    const response =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`
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

    const data =
      await response.json();

    if (!response.ok) {

      console.error(
        "OpenAI error:",
        data
      );

      return res.status(
        response.status
      ).json({
        success: false,
        error:
          data?.error?.message ||
          "OpenAI analysis failed."
      });
    }

    // =====================================================
    // 7. EXTRACT AI RESPONSE
    // =====================================================

    let outputText = "";

    if (data.output) {

      for (const item of data.output) {

        if (!item.content) {
          continue;
        }

        for (const content of item.content) {

          if (
            content.type ===
            "output_text"
          ) {

            outputText +=
              content.text;

          }

        }

      }

    }

    if (!outputText) {
      throw new Error(
        "OpenAI returned no analysis."
      );
    }

    outputText =
      outputText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

    const analysis =
      JSON.parse(outputText);

    // =====================================================
    // 8. VALIDATE RESULT
    // =====================================================

    analysis.score =
      Math.max(
        1,
        Math.min(
          10,
          Number(
            analysis.score
          ) || 1
        )
      );

    analysis.concerns =
      Array.isArray(
        analysis.concerns
      )
        ? analysis.concerns
        : [];

    analysis.needs =
      Array.isArray(
        analysis.needs
      )
        ? analysis.needs
        : [];

    analysis.morningRoutine =
      Array.isArray(
        analysis.morningRoutine
      )
        ? analysis.morningRoutine
        : [];

    analysis.eveningRoutine =
      Array.isArray(
        analysis.eveningRoutine
      )
        ? analysis.eveningRoutine
        : [];

    analysis.recommendations =
      Array.isArray(
        analysis.recommendations
      )
        ? analysis.recommendations
        : [];

    analysis.note =
      typeof analysis.note ===
      "string"
        ? analysis.note
        : "";

    // =====================================================
    // 9. RETURN RESULT
    // =====================================================

    return res.status(200).json({

      success: true,

      analysis,

      access: {
        plan:
          planActive
            ? account.plan
            : null,

        scan_credits:
          remainingCredits
      },

      disclaimer:
        "Luméra provides cosmetic skincare guidance and is not a medical diagnosis."
    });

  } catch (error) {

    console.error(
      "Luméra API error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Luméra could not analyze the image."
    });
  }
}
