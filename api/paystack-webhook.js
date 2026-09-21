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

    const signature =
      req.headers["x-paystack-signature"];

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
    // 3. GET PAYMENT INFORMATION
    // =====================================================

    const email =
      event.data?.customer?.email
        ?.trim()
        ?.toLowerCase();

    const amount =
      Number(event.data?.amount || 0);

    const currency =
      String(event.data?.currency || "")
        .toUpperCase();

    const reference =
      event.data?.reference || null;


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


    // =====================================================
    // 4. ONLY ACCEPT GHS PAYMENTS
    // =====================================================

    if (currency !== "GHS") {
      console.log(
        `Ignoring non-GHS payment: ${currency}`
      );

      return res.status(200).json({
        received: true
      });
    }


    // =====================================================
    // 5. CHECK WHETHER THIS PAYMENT WAS ALREADY PROCESSED
    // =====================================================

    const existingPayment =
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_payments?reference=eq.${encodeURIComponent(reference)}&select=reference`,
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


    if (!existingPayment.ok) {

      const error =
        await existingPayment.text();

      console.error(
        "Payment lookup error:",
        error
      );

      return res.status(500).json({
        error: "Could not check payment"
      });

    }


    const existing =
      await existingPayment.json();


    if (existing.length > 0) {

      console.log(
        `Payment ${reference} was already processed.`
      );

      return res.status(200).json({
        received: true,
        already_processed: true
      });

    }


    // =====================================================
    // 6. RECORD THE PAYMENT
    // =====================================================

    const paymentInsert =
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/lumera_payments`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            apikey:
              process.env.SUPABASE_SECRET_KEY,

            Authorization:
              `Bearer ${process.env.SUPABASE_SECRET_KEY}`,

            Prefer:
              "return=minimal"
          },

          body: JSON.stringify({
            reference: reference,
            email: email,
            amount: amount,
            currency: currency
          })
        }
      );


    if (!paymentInsert.ok) {

      const error =
        await paymentInsert.text();

      console.error(
        "Payment record error:",
        error
      );

      return res.status(500).json({
        error: "Could not record payment"
      });

    }


    // =====================================================
    // 7. GH₵5 = 3 SCANS
    // =====================================================

    if (amount === 500) {

      console.log(
        `Granting 3 scans to ${email}`
      );


      const existingAccountResponse =
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(email)}&select=email,scan_credits`,
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


      if (!existingAccountResponse.ok) {

        const error =
          await existingAccountResponse.text();

        console.error(
          "Account lookup error:",
          error
        );

        return res.status(500).json({
          error: "Could not find Luméra account"
        });

      }


      const accounts =
        await existingAccountResponse.json();


      if (accounts.length === 0) {

        const createAccount =
          await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                apikey:
                  process.env.SUPABASE_SECRET_KEY,

                Authorization:
                  `Bearer ${process.env.SUPABASE_SECRET_KEY}`
              },

              body: JSON.stringify({
                email: email,
                scan_credits: 3,
                plan: null,
                plan_expires_at: null,
                last_payment_reference:
                  reference
              })
            }
          );


        if (!createAccount.ok) {

          const error =
            await createAccount.text();

          console.error(
            "Account creation error:",
            error
          );

          return res.status(500).json({
            error: "Could not create Luméra account"
          });

        }

      } else {

        const currentCredits =
          Number(
            accounts[0].scan_credits || 0
          );


        const updateAccount =
          await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?email=eq.${encodeURIComponent(email)}`,
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
                  "return=minimal"
              },

              body: JSON.stringify({
                scan_credits:
                  currentCredits + 3,

                last_payment_reference:
                  reference,

                updated_at:
                  new Date().toISOString()
              })
            }
          );


        if (!updateAccount.ok) {

          const error =
            await updateAccount.text();

          console.error(
            "Scan credit update error:",
            error
          );

          return res.status(500).json({
            error: "Could not grant scan credits"
          });

        }

      }


      console.log(
        `Luméra: 3 scans successfully granted to ${email}`
      );

    }


    // =====================================================
    // 8. GH₵100 = STANDARD
    // =====================================================

    if (amount === 10000) {

      const expiry =
        new Date();

      expiry.setMonth(
        expiry.getMonth() + 1
      );


      const response =
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?on_conflict=email`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              apikey:
                process.env.SUPABASE_SECRET_KEY,

              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`,

              Prefer:
                "resolution=merge-duplicates,return=minimal"
            },

            body: JSON.stringify({
              email: email,
              plan: "standard",
              plan_expires_at:
                expiry.toISOString(),
              last_payment_reference:
                reference,
              updated_at:
                new Date().toISOString()
            })
          }
        );


      if (!response.ok) {

        const error =
          await response.text();

        console.error(
          "Standard plan error:",
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


    // =====================================================
    // 9. GH₵300 = PRO
    // =====================================================

    if (amount === 30000) {

      const expiry =
        new Date();

      expiry.setFullYear(
        expiry.getFullYear() + 1
      );


      const response =
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/lumera_accounts?on_conflict=email`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              apikey:
                process.env.SUPABASE_SECRET_KEY,

              Authorization:
                `Bearer ${process.env.SUPABASE_SECRET_KEY}`,

              Prefer:
                "resolution=merge-duplicates,return=minimal"
            },

            body: JSON.stringify({
              email: email,
              plan: "pro",
              plan_expires_at:
                expiry.toISOString(),
              last_payment_reference:
                reference,
              updated_at:
                new Date().toISOString()
            })
          }
        );


      if (!response.ok) {

        const error =
          await response.text();

        console.error(
          "Pro plan error:",
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


    // =====================================================
    // 10. UNKNOWN AMOUNT
    // =====================================================

    if (
      amount !== 500 &&
      amount !== 10000 &&
      amount !== 30000
    ) {

      console.log(
        `Unknown Luméra payment amount: ${amount}`
      );

    }


    // =====================================================
    // 11. DONE
    // =====================================================

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
