import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const signature = req.headers["x-paystack-signature"];

    if (!signature) {
      return res.status(401).json({
        error: "Missing Paystack signature"
      });
    }

    /*
      Paystack sends the webhook body to us.
      We verify that the request really came from Paystack.
    */

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
        error: "Invalid signature"
      });
    }

    const event =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    /*
      We only process successful payments.
    */

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

    if (!email) {
      return res.status(400).json({
        error: "Customer email missing"
      });
    }

    /*
      LUMÉRA 3-SCAN PASS
      GH₵5 = 500 pesewas
    */

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
          "Supabase error:",
          error
        );

        return res.status(500).json({
          error: "Could not grant scans"
        });
      }

      console.log(
        `Luméra: 3 scans granted to ${email}`
      );
    }

    /*
      STANDARD
      GH₵100 = 10,000 pesewas

      PRO
      GH₵300 = 30,000 pesewas

      These payments are detected here,
      but subscription access will be connected
      after the Luméra subscription table is added
      to Supabase.
    */

    if (
      currency === "GHS" &&
      amount === 10000
    ) {
      console.log(
        `Luméra Standard payment received from ${email}`
      );
    }

    if (
      currency === "GHS" &&
      amount === 30000
    ) {
      console.log(
        `Luméra Pro payment received from ${email}`
      );
    }

    return res.status(200).json({
      received: true
    });

  } catch (error) {

    console.error(
      "Webhook error:",
      error
    );

    return res.status(500).json({
      error: "Webhook processing failed"
    });
  }
}
