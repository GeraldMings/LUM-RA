import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const AUTHORIZED_PARTY =
  "https://lum-ra.vercel.app";

async function authenticate(req) {
  const result =
    await clerk.authenticateRequest(req, {
      authorizedParties: [
        AUTHORIZED_PARTY
      ]
    });

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

  const response = await fetch(
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

function chooseCurrentPlan(rows) {
  const now = Date.now();

  const activeSubscriptions =
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
    activeSubscriptions.length
  ) {
    activeSubscriptions.sort(
      (a, b) =>
        new Date(b.expires_at) -
        new Date(a.expires_at)
    );

    return activeSubscriptions[0];
  }

  const scanRows =
    rows.filter(row =>
      row.plan === "3_scan_pass" &&
      row.status === "active" &&
      Number(
        row.scan_remaining || 0
      ) > 0
    );

  scanRows.sort(
    (a, b) =>
      Number(
        b.scan_remaining || 0
      ) -
      Number(
        a.scan_remaining || 0
      )
  );

  return scanRows[0] || null;
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "GET") {
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

    const user =
      await clerk.users.getUser(
        auth.userId
      );

    const email = (
      user
        .primaryEmailAddress
        ?.emailAddress ||
      user
        .emailAddresses?.[0]
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

    const rows =
      await supabase(
        `lumera_entitlements?email=eq.${encodeURIComponent(
          email
        )}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at`
      );

    const entitlements =
      Array.isArray(rows)
        ? rows
        : [];

    const current =
      chooseCurrentPlan(
        entitlements
      );

    const scanCredits =
      entitlements
        .filter(
          row =>
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

    const activeSubscription =
      !!current &&
      (
        current.plan ===
          "standard" ||
        current.plan ===
          "pro"
      ) &&
      current.status === "active" &&
      current.expires_at &&
      new Date(
        current.expires_at
      ).getTime() > Date.now();

    return res.status(200).json({
      email,

      scan_credits:
        scanCredits,

      plan:
        current?.plan || null,

      status:
        current?.status || null,

      plan_expires_at:
        current?.expires_at ||
        null,

      active_subscription:
        activeSubscription,

      transaction_reference:
        current?.transaction_reference ||
        null,

      entitlements:
        entitlements.map(row => ({
          id: row.id,

          plan: row.plan,

          scan:
            Number(
              row.scan || 0
            ),

          scan_remaining:
            Number(
              row.scan_remaining || 0
            ),

          status:
            row.status,

          transaction_reference:
            row.transaction_reference,

          expires_at:
            row.expires_at
        }))
    });

  } catch (error) {

    console.error(
      "Luméra account error:",
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
          "Account lookup failed"
      });
  }
}
