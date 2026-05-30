# Swapping the Mock KYC Provider for a Real One

The KYC system is built around the `KycProvider` interface in
`src/services/kyc.service.ts`. The mock implementation does nothing beyond
logging — swap it out by implementing that interface.

---

## Interface

```typescript
export interface KycProvider {
  onSubmit(record: KycRecord): Promise<void>;
  onApprove(record: KycRecord): Promise<void>;
  onReject(record: KycRecord): Promise<void>;
}
```

---

## Example: Persona Integration

### 1. Create the provider

```typescript
// src/providers/persona.provider.ts
import type { KycProvider } from "../services/kyc.service.js";
import type { KycRecord } from "../types.js";

export class PersonaKycProvider implements KycProvider {
  async onSubmit(record: KycRecord): Promise<void> {
    // Create a Persona inquiry and store the inquiry ID
    const res = await fetch("https://withpersona.com/api/v1/inquiries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          attributes: {
            "inquiry-template-id": process.env.PERSONA_TEMPLATE_ID,
            "reference-id": record.walletAddress,
            fields: { name: { value: record.name }, email: { value: record.email } },
          },
        },
      }),
    });
    const { data } = await res.json();
    // Store data.id → link to walletAddress in your DB
  }

  async onApprove(_record: KycRecord): Promise<void> {
    // No-op — Persona drives approval via webhooks
  }

  async onReject(_record: KycRecord): Promise<void> {
    // No-op — Persona drives rejection via webhooks
  }
}
```

### 2. Add a webhook handler

```typescript
// src/routes/webhooks.ts
import { getKycService } from "../services/kyc.service.js";

app.post("/webhooks/persona", async (req, reply) => {
  const event = req.body as PersonaWebhookEvent;
  const walletAddress = event.data.attributes["reference-id"];

  if (event.data.attributes.status === "approved") {
    await getKycService().approveWallet(walletAddress);
  } else if (event.data.attributes.status === "declined") {
    await getKycService().rejectWallet(walletAddress);
  }

  return reply.send({ received: true });
});
```

### 3. Register the provider

```typescript
// src/index.ts
import { PersonaKycProvider } from "./providers/persona.provider.js";
import { getKycService } from "./services/kyc.service.js";

getKycService().setProvider(new PersonaKycProvider());
```

That's it. The `approveWallet()` path — which triggers the on-chain
`add_to_whitelist` transaction — is unchanged.

---

## Other Providers

| Provider | Webhook event     | Reference field        |
|----------|-------------------|------------------------|
| Jumio    | `COMPLETED`       | `customerInternalReference` |
| Sumsub   | `applicantReviewed` | `externalUserId`     |
| Onfido   | `check.completed` | `applicant.external_id` |

All follow the same pattern: create inquiry with wallet address as reference,
receive webhook, call `approveWallet(walletAddress)` or `rejectWallet(walletAddress)`.
