import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // -----------------------------
    // 1. Verify Paystack signature
    // -----------------------------
    const signature = req.headers["x-paystack-signature"];

    if (!signature) {
      return res.status(401).json({
        error: "Missing Paystack signature"
      });
    }

    const body =
      typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    const hash = crypto
      .createHmac(
        "sha512",
        process.env.PAYSTACK_SECRET_KEY
      )
      .update(body)
      .digest("hex");

    if (signature !== hash) {
      return res.status(401).json({
        error: "Invalid Paystack signature"
      });
    }

    // -----------------------------
    // 2. Read Paystack event
    // -----------------------------
    const event =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    // We only process successful payments
    if (event.event !== "charge.success") {
      return res.status(200).json({
        received: true
      });
    }

    const email =
      event.data?.customer?.email;

    const amount =
      event.data?.amount;

    const currency =
      event.data?.currency;

    const reference =
      event.data?.reference || null;

    if (!email) {
      return res.status(400).json({
        error: "Customer email missing"
      });
    }

    console.log(
      `Luméra payment received: ${email} | ${currency} | ${amount}`
    );

    // -----------------------------
    // 3. GH₵5 = 3 Scan Pass
    // -----------------------------
    if (
      currency === "GHS" &&
      amount === 500
    ) {
      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/grant_scan_pass_by_email`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",

            apikey:
              process.env.SUPABASE_SECRET_KEY,

            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },

          body: JSON.stringify({
            p_email: email
          })
        }
      );

      if (!response.ok) {
        const error =
          await response.text();

        console.error(
          "Supabase scan grant error:",
          error
        );

        return res.status(500).json({
          error: "Could not grant scan pass"
        });
      }

      console.log(
        `Luméra: 3 scans granted to ${email}`
      );
    }

    // -----------------------------
    // 4. GH₵100 = Standard
    // -----------------------------
    if (
      currency === "GHS" &&
      amount === 10000
    ) {
      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/grant_lumera_plan`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",

            apikey:
              process.env.SUPABASE_SECRET_KEY,

            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },

          body: JSON.stringify({
            p_email: email,
            p_plan: "standard",
            p_reference: reference
          })
        }
      );

      if (!response.ok) {
        const error =
          await response.text();

        console.error(
          "Supabase Standard plan error:",
          error
        );

        return res.status(500).json({
          error: "Could not activate Standard plan"
        });
      }

      console.log(
        `Luméra Standard activated for ${email}`
      );
    }

    // -----------------------------
    // 5. GH₵300 = Pro
    // -----------------------------
    if (
      currency === "GHS" &&
      amount === 30000
    ) {
      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/grant_lumera_plan`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",

            apikey:
              process.env.SUPABASE_SECRET_KEY,

            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },

          body: JSON.stringify({
            p_email: email,
            p_plan: "pro",
            p_reference: reference
          })
        }
      );

      if (!response.ok) {
        const error =
          await response.text();

        console.error(
          "Supabase Pro plan error:",
          error
        );

        return res.status(500).json({
          error: "Could not activate Pro plan"
        });
      }

      console.log(
        `Luméra Pro activated for ${email}`
      );
    }

    // -----------------------------
    // 6. Finished
    // -----------------------------
    return res.status(200).json({
      received: true
    });

  } catch (error) {

    console.error(
      "Luméra webhook error:",
      error
    );

    return res.status(500).json({
      error: "Webhook processing failed"
    });
  }
}
