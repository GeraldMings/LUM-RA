import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // =====================================================
    // 1. VERIFY PAYSTACK SIGNATURE
    // =====================================================

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

    // =====================================================
    // 2. READ PAYSTACK EVENT
    // =====================================================

    const event =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (event.event !== "charge.success") {
      return res.status(200).json({
        received: true
      });
    }

    // =====================================================
    // 3. PAYMENT INFORMATION
    // =====================================================

    const email =
      event.data?.customer?.email
        ?.trim()
        ?.toLowerCase();

    const amount = Number(event.data?.amount || 0);

    const currency =
      String(event.data?.currency || "").toUpperCase();

    const reference = event.data?.reference || null;

    if (!email) {
      return res.status(400).json({
        error: "Customer email missing"
      });
    }

    if (!reference) {
      return res.status(400).json({
        error: "Payment reference missing"
      });
    }

    console.log(
      `Luméra payment received: ${email} | ${currency} | GH₵${amount / 100} | ${reference}`
    );

    if (currency !== "GHS") {
      return res.status(200).json({
        received: true
      });
    }

    // =====================================================
    // 4. CHECK DUPLICATE PAYMENT
    // =====================================================

    const existingPaymentResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/lumera_payments?reference=eq.${encodeURIComponent(reference)}&select=reference`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization:
            `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!existingPaymentResponse.ok) {
      console.error(
        "Payment lookup error:",
        await existingPaymentResponse.text()
      );

      return res.status(500).json({
        error: "Could not check payment"
      });
    }

    const existingPayments =
      await existingPaymentResponse.json();

    if (existingPayments.length > 0) {
      console.log(
        `Payment ${reference} already recorded.`
      );

      return res.status(200).json({
        received: true,
        already_processed: true
      });
    }

    // =====================================================
    // 5. RECORD PAYMENT
    // =====================================================

    const paymentInsert = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/lumera_payments`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization:
            `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          Prefer: "return=minimal"
        },

        body: JSON.stringify({
          reference,
          email,
          amount,
          currency
        })
      }
    );

    if (!paymentInsert.ok) {
      console.error(
        "Payment record error:",
        await paymentInsert.text()
      );

      return res.status(500).json({
        error: "Could not record payment"
      });
    }

    // =====================================================
    // 6. GH₵5 = 3-SCAN PASS
    // =====================================================

    if (amount === 500) {
      console.log(
        `Granting 3 scans to ${email}`
      );

      // Look for an existing entitlement for this email
      const entitlementLookup = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(email)}&select=id,email,plan,scan,scan_remaining,status,transaction_reference,expires_at`,
        {
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!entitlementLookup.ok) {
        console.error(
          "Entitlement lookup error:",
          await entitlementLookup.text()
        );

        return res.status(500).json({
          error: "Could not check Luméra entitlement"
        });
      }

      const entitlements =
        await entitlementLookup.json();

      // ---------------------------------------------------
      // Existing entitlement
      // ---------------------------------------------------

      if (entitlements.length > 0) {
        const entitlement = entitlements[0];

        const currentRemaining =
          Number(entitlement.scan_remaining || 0);

        const updateEntitlement = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?id=eq.${encodeURIComponent(entitlement.id)}`,
          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
              Prefer: "return=minimal"
            },

            body: JSON.stringify({
              scan: 3,
              scan_remaining: currentRemaining + 3,
              status: "active",
              transaction_reference: reference
            })
          }
        );

        if (!updateEntitlement.ok) {
          console.error(
            "Entitlement update error:",
            await updateEntitlement.text()
          );

          return res.status(500).json({
            error: "Could not update Luméra entitlement"
          });
        }
      }

      // ---------------------------------------------------
      // New entitlement
      // ---------------------------------------------------

      else {
        const createEntitlement = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
              Prefer: "return=minimal"
            },

            body: JSON.stringify({
              user_id: null,
              email,
              plan: "3_scan_pass",
              scan: 3,
              scan_remaining: 3,
              status: "active",
              transaction_reference: reference,
              expires_at: null
            })
          }
        );

        if (!createEntitlement.ok) {
          console.error(
            "Entitlement creation error:",
            await createEntitlement.text()
          );

          return res.status(500).json({
            error: "Could not create Luméra entitlement"
          });
        }
      }

      console.log(
        `Luméra: 3 scans successfully granted to ${email}`
      );
    }

    // =====================================================
    // 7. GH₵100 = STANDARD
    // =====================================================

    if (amount === 10000) {
      const expiry = new Date();

      expiry.setMonth(
        expiry.getMonth() + 1
      );

      const entitlementLookup = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(email)}&select=id`,
        {
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!entitlementLookup.ok) {
        return res.status(500).json({
          error: "Could not check Luméra entitlement"
        });
      }

      const entitlements =
        await entitlementLookup.json();

      const entitlementData = {
        email,
        plan: "standard",
        status: "active",
        transaction_reference: reference,
        expires_at: expiry.toISOString()
      };

      if (entitlements.length > 0) {
        const update = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?id=eq.${encodeURIComponent(entitlements[0].id)}`,
          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`
            },

            body: JSON.stringify(entitlementData)
          }
        );

        if (!update.ok) {
          console.error(
            "Standard entitlement error:",
            await update.text()
          );

          return res.status(500).json({
            error: "Could not activate Standard"
          });
        }
      } else {
        const create = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`
            },

            body: JSON.stringify(entitlementData)
          }
        );

        if (!create.ok) {
          console.error(
            "Standard entitlement creation error:",
            await create.text()
          );

          return res.status(500).json({
            error: "Could not activate Standard"
          });
        }
      }

      console.log(
        `Luméra Standard activated for ${email}`
      );
    }

    // =====================================================
    // 8. GH₵300 = PRO
    // =====================================================

    if (amount === 30000) {
      const expiry = new Date();

      expiry.setFullYear(
        expiry.getFullYear() + 1
      );

      const entitlementLookup = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?email=eq.${encodeURIComponent(email)}&select=id`,
        {
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!entitlementLookup.ok) {
        return res.status(500).json({
          error: "Could not check Luméra entitlement"
        });
      }

      const entitlements =
        await entitlementLookup.json();

      const entitlementData = {
        email,
        plan: "pro",
        status: "active",
        transaction_reference: reference,
        expires_at: expiry.toISOString()
      };

      if (entitlements.length > 0) {
        const update = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements?id=eq.${encodeURIComponent(entitlements[0].id)}`,
          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`
            },

            body: JSON.stringify(entitlementData)
          }
        );

        if (!update.ok) {
          console.error(
            "Pro entitlement error:",
            await update.text()
          );

          return res.status(500).json({
            error: "Could not activate Pro"
          });
        }
      } else {
        const create = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_entitlements`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`
            },

            body: JSON.stringify(entitlementData)
          }
        );

        if (!create.ok) {
          console.error(
            "Pro entitlement creation error:",
            await create.text()
          );

          return res.status(500).json({
            error: "Could not activate Pro"
          });
        }
      }

      console.log(
        `Luméra Pro activated for ${email}`
      );
    }

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
