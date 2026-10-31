# Brieflane — product brief

## Name
**Brieflane** — every brand *brief* moves along a *lane* (new → negotiating → … → published), and the app's job is to keep each one in its lane and tell you which needs you today.

Collision check (web search, 31 Oct 2026): no app, SaaS product or creator tool found using "Brieflane". Rejected alternatives: **Cueboard** (existing Mac/iOS app), **Takeboard** (clear, but weaker meaning). Not yet checked: UK IPO / USPTO trademark registers, domain availability (brieflane.com / .app / .co.uk), App Store / Play Store listings. Do those before public launch.

## Summary
Brieflane is a responsive PWA for independent creators that turns a messy inbox of brand collaboration and product-review emails into a single daily answer: **what needs my attention today?** It connects to Gmail with read-only access, finds collaboration threads, extracts brands, products, contacts, deliverables, deadlines, fees and shipping details, and keeps them up to date as conversations move on. Its defining rule is evidence: every detail is marked as *stated in email* (with the exact quote), *AI-inferred*, or *set by you*, and nothing is ever described as agreed without explicit written agreement. It drafts replies for you to edit, but sending needs a separate permission and your explicit approval every time.

First user: Huson DIY. Built multi-tenant from day one for public availability.

## Phased delivery

| Phase | Scope | Status |
|---|---|---|
| **0 — MVP (this build)** | Dashboard + AI briefing, urgent actions, collaboration tracker (7 stages), deal detail with evidence, email history, reply drafts with approve-then-send, calendar, review queue, rule/AI assistant, Gmail OAuth (read; send as separate opt-in), 12-month import with review, tenant isolation, encrypted tokens, export / retention / deletion, labelled demo inbox | **Implemented & tested** |
| **1 — Private beta (Huson DIY live)** | Real Google OAuth app + test users, hosting with HTTPS + backups, Gmail push notifications (Pub/Sub watch + history API) instead of manual "Check email", background job queue, AI key enabled, email digest of the daily briefing, error monitoring | Planned |
| **2 — Creator beta (5–20 creators)** | Google OAuth verification + CASA security assessment (required for restricted Gmail scopes), Postgres with row-level security, KMS envelope encryption for tokens, rate-card/media-kit library, invoice & payment tracking, multiple inboxes per tenant, team members (manager/editor roles) | Planned |
| **3 — Content studio** | Per-deal content plan: brief → script outline → shot list → filming checklist → edit notes → brand review rounds; deliverable checklist auto-built from email facts; asset links (Drive/Dropbox) | Planned |
| **4 — YouTube integration** | YouTube Data API (read-only): link a deal to its video, auto-move Scheduled → Published when the video goes live, pull views/CTR/retention for post-campaign reports to brands; affiliate-link click tracking | Planned |
| **5 — Public launch** | Billing (Stripe), self-serve onboarding, Outlook/Microsoft 365 connector, mobile push notifications, public privacy policy & DPA, SOC 2 readiness | Planned |
