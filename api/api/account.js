import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

export default async function handler(req, res) {
  try {
    // =====================================================
    // VERIFY CLERK SESSION
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
    // GET CLERK USER
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
    // GET ACCOUNT
    // =====================================================

    if (req.method === "GET") {
      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(
          email
        )}&select=email,scan_credits,plan,plan_expires_at,last_payment_reference`,
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
          "Luméra account lookup error:",
          error
        );

        return res.status(500).json({
          error: "Could not load Luméra account."
        });
      }

      const accounts = await response.json();

      if (accounts.length === 0) {
        return res.status(200).json({
          email,
          scan_credits: 0,
          plan: null,
          plan_expires_at: null,
          last_payment_reference: null
        });
      }

      return res.status(200).json(accounts[0]);
    }

    // =====================================================
    // USE ONE SCAN
    // =====================================================

    if (req.method === "POST") {
      const accountResponse = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(
          email
        )}&select=email,scan_credits,plan,plan_expires_at`,
        {
          method: "GET",
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!accountResponse.ok) {
        const error = await accountResponse.text();

        console.error(
          "Luméra access lookup error:",
          error
        );

        return res.status(500).json({
          error: "Could not check Luméra access."
        });
      }

      const accounts = await accountResponse.json();

      if (accounts.length === 0) {
        return res.status(403).json({
          error: "No Luméra access found."
        });
      }

      const account = accounts[0];

      const credits = Number(
        account.scan_credits || 0
      );

      const planActive =
        account.plan &&
        account.plan_expires_at &&
        new Date(account.plan_expires_at) > new Date();

      // Standard / Pro
      if (planActive) {
        return res.status(200).json({
          allowed: true,
          scan_credits: credits,
          plan: account.plan
        });
      }

      // 3-scan pass
      if (credits <= 0) {
        return res.status(403).json({
          error: "No scans remaining.",
          scan_credits: 0,
          plan: null
        });
      }

      // Deduct one scan
      const updateResponse = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(
          email
        )}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            scan_credits: credits - 1,
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!updateResponse.ok) {
        const error = await updateResponse.text();

        console.error(
          "Scan credit update error:",
          error
        );

        return res.status(500).json({
          error: "Could not use scan."
        });
      }

      return res.status(200).json({
        allowed: true,
        scan_credits: credits - 1,
        plan: null
      });
    }

    return res.status(405).json({
      error: "Method not allowed"
    });

  } catch (error) {
    console.error(
      "Luméra account API error:",
      error
    );

    return res.status(500).json({
      error: "Luméra account request failed."
    });
  }
          }
