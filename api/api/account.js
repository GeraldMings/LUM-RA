// api/account.js
// Secure Luméra account lookup
// Clerk verifies the logged-in user.
// Supabase stores the Luméra payment/scan entitlement.

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function send(res, status, data) {
  res.status(status).json(data);
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];

    const normalized = payload
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

async function getClerkUser(sessionToken) {
  const payload = decodeJwtPayload(sessionToken);

  if (!payload || !payload.sid) {
    throw new Error("Invalid Clerk session token.");
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
    throw new Error("Clerk session is not active.");
  }

  if (!session.user_id) {
    throw new Error("No Clerk user is attached to this session.");
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
      (item) =>
        item.id === user.primary_email_address_id
    ) || emailAddresses[0];

  const email = primary?.email_address || "";

  if (!email) {
    throw new Error("No email address is attached to this account.");
  }

  return {
    userId: user.id,
    email: email.toLowerCase().trim()
  };
}

async function getLumeraAccount(email) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(email)}&select=email,scan_credits,plan,plan_expires_at,last_payment_reference,created_at,updated_at`,
    {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Supabase account lookup failed: ${errorText}`
    );
  }

  const rows = await response.json();

  if (!rows.length) {
    return null;
  }

  return rows[0];
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return send(res, 405, {
      error: "Method not allowed."
    });
  }

  if (
    !CLERK_SECRET_KEY ||
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    return send(res, 500, {
      error: "Server environment variables are missing."
    });
  }

  try {
    const sessionToken = getBearerToken(req);

    if (!sessionToken) {
      return send(res, 401, {
        error: "You must be signed in."
      });
    }

    const clerkUser = await getClerkUser(sessionToken);

    const account = await getLumeraAccount(
      clerkUser.email
    );

    return send(res, 200, {
      authenticated: true,
      email: clerkUser.email,
      clerk_user_id: clerkUser.userId,
      account: account || {
        email: clerkUser.email,
        scan_credits: 0,
        plan: null,
        plan_expires_at: null,
        last_payment_reference: null
      }
    });

  } catch (error) {
    console.error("Luméra account error:", error);

    return send(res, 401, {
      error: error.message || "Authentication failed."
    });
  }
    }
