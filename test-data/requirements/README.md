# Reusable requirements test corpus

These synthetic files are project-input fixtures for requirements extraction and analysis. They are not authoritative regulatory, compliance, organizational-policy, or financial-policy sources. Do not upload them to the Phase 4 Knowledge Base; use them as Phase 3 project inputs when exercising Phase 5 or later project-input workflows.

| File | Suggested financial domain | Coverage |
|---|---|---|
| `sample-01-digital-banking-onboarding.txt` | `CUSTOMER_ONBOARDING_KYC` | Onboarding journey, documents, manual review, exceptions, volume, and audit needs |
| `sample-02-payment-processing.txt` | `PAYMENTS` | Payment initiation, approvals, status, retries, reconciliation, and customer notices |
| `sample-03-loan-origination.txt` | `LOANS_CREDIT` | Application intake, evidence, review, missing information, and decision communication |
| `sample-04-trade-finance-lc.txt` | `TRADE_FINANCE` | Illustrative LC-supporting software requests, document handling, review, and status |
| `sample-05-fraud-detection.txt` | `FRAUD_DETECTION` | Alert handling, analyst queues, investigation notes, and service expectations |
| `sample-06-ambiguous-conflicting-banking.txt` | `DIGITAL_BANKING` | Vague wording, missing thresholds, and conflicting approval expectations |
| `sample-07-stakeholder-conversation.txt` | `LOANS_CREDIT` | Informal multi-speaker discussion with unresolved scope and dependencies |

The text is intentionally stakeholder-style rather than polished requirements. No sample encodes expected model output; test assertions should use deterministic mock responses.
