import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["x-paystack-signature"];

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== hash) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;

  if (event.event !== "charge.success") {
    return res.status(200).json({ received: true });
  }

  const email = event.data?.customer?.email;
  const amount = event.data?.amount;
  const currency = event.data?.currency;

  if (!email) {
    return res.status(400).json({ error: "Customer email missing" });
  }

  // Luméra 3-Scan Pass = GH₵5
  if (currency === "GHS" && amount === 500) {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/grant_scan_pass_by_email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          p_email: email
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Could not grant scans" });
    }
  }

  return res.status(200).json({ received: true });
                                }
