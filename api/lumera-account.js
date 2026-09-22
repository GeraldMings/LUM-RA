import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

export default async function handler(req, res) {
  try {
    // =====================================================
    // 1. VERIFY CLERK SESSION
    // =====================================================

    const { isAuthenticated, toAuth } =
      await clerkClient.authenticateRequest(req, {
        authorizedParties: [
          "https://lum-d7ipe8e2b-geraldmings.vercel.app"
        ]
      });

    if (!isAuthenticated) {
      return res.status(401).json({
        error: "You must be signed in."
      });
    }

    const auth = toAuth();
    const userId = auth.userId;

    if (!userId) {
      return res.status(401).json({
        error: "Clerk user not found."
      });
    }

    // =====================================================
    // 2. GET USER EMAIL FROM CLERK
    // =====================================================

    const user = await clerkClient.users.getUser(userId);

    const email =
      user.primaryEmailAddress?.emailAddress
        ?.trim()
        ?.toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: "No email address found for this account."
      });
    }

    // =====================================================
    // 3. GET USER'S LUMÉRA ENTITLEMENT
    // =====================================================

    if (req.method === "GET") {

      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(
          email
        )}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at&order=id.desc&limit=1`,
        {
          method: "GET",
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!response.ok) {
        const error = await response.text();

        console.error(
          "Luméra entitlement lookup error:",
          error
        );

        return res.status(500).json({
          error: "Could not load Luméra account."
        });
      }

      const entitlements =
        await response.json();

      // ===================================================
      // NO ENTITLEMENT
      // ===================================================

      if (entitlements.length === 0) {

        return res.status(200).json({
          email,
          scan_credits: 0,
          plan: null,
          plan_expires_at: null,
          status: null
        });

      }

      const entitlement =
        entitlements[0];

      const scanRemaining =
        Number(
          entitlement.scan_remaining || 0
        );

      // ===================================================
      // RETURN DATA IN THE FORMAT
      // YOUR WEBSITE ALREADY EXPECTS
      // ===================================================

      return res.status(200).json({
        email: entitlement.email,
        scan_credits: scanRemaining,
        plan: entitlement.plan,
        plan_expires_at:
          entitlement.expires_at,
        status:
          entitlement.status,
        transaction_reference:
          entitlement.transaction_reference
      });
    }

    // =====================================================
    // 4. USE ONE SCAN
    // =====================================================

    if (req.method === "POST") {

      const accountResponse =
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(
            email
          )}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at&order=id.desc&limit=1`,
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

        console.error(
          "Luméra access lookup error:",
          await accountResponse.text()
        );

        return res.status(500).json({
          error:
            "Could not check Luméra access."
        });

      }

      const entitlements =
        await accountResponse.json();

      if (entitlements.length === 0) {

        return res.status(403).json({
          error:
            "No Luméra access found."
        });

      }

      const entitlement =
        entitlements[0];

      const scanRemaining =
        Number(
          entitlement.scan_remaining || 0
        );

      const plan =
        entitlement.plan;

      const status =
        entitlement.status;

      const expiresAt =
        entitlement.expires_at;

      // ===================================================
      // ACTIVE STANDARD / PRO
      // ===================================================

      const subscriptionActive =
        (
          plan === "standard" ||
          plan === "pro"
        ) &&
        status === "active" &&
        expiresAt &&
        new Date(expiresAt) > new Date();

      if (subscriptionActive) {

        return res.status(200).json({
          allowed: true,
          scan_credits: scanRemaining,
          plan,
          plan_expires_at: expiresAt
        });

      }

      // ===================================================
      // 3-SCAN PASS
      // ===================================================

      if (
        plan === "3_scan_pass" ||
        scanRemaining > 0
      ) {

        if (scanRemaining <= 0) {

          return res.status(403).json({
            error: "No scans remaining.",
            scan_credits: 0,
            plan: null
          });

        }

        // -----------------------------------------------
        // Deduct exactly ONE scan
        // -----------------------------------------------

        const updateResponse =
          await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?id=eq.${encodeURIComponent(
              entitlement.id
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
                scan_remaining:
                  scanRemaining - 1
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
            error:
              "Could not use scan."
          });

        }

        return res.status(200).json({
          allowed: true,
          scan_credits:
            scanRemaining - 1,
          plan: "3_scan_pass",
          plan_expires_at:
            null
        });

      }

      // ===================================================
      // NO ACCESS
      // ===================================================

      return res.status(403).json({
        error:
          "No active Luméra access.",
        scan_credits: 0,
        plan: null
      });
    }

    // =====================================================
    // METHOD NOT ALLOWED
    // =====================================================

    return res.status(405).json({
      error: "Method not allowed"
    });

  } catch (error) {

    console.error(
      "Luméra account API error:",
      error
    );

    return res.status(500).json({
      error:
        "Luméra account request failed."
    });

  }
}

After you paste it, save/commit it. Then tell me when Vercel says the deployment is successful. Don't make another payment. Then we'll test whether Luméra recognizes your 3 scans before touching anything else.
