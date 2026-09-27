# Guru Brain

The LLM backend for KitchenGuru. It runs the owner-facing **Guru Console** agent, the customer-facing **WhatsApp concierge**, Bot Studio's AI interpreter, and an OpenAI-compatible endpoint for the Live Inbox copilot.

## How a request flows

```
Admin SPA ──JWT──▶ kitchenasty /api/guru/*          (who are you? which restaurant?)
                     │  x-kg-internal-token, x-kg-location-id, x-kg-user-id, x-kg-user-role
                     ▼
               guru-brain /api/guru/*                (session → conversation → agent loop)
                     │  tools, each bound to the tenant
                     ▼
               kitchenasty /api/guru/tools/*         (every query filtered by x-kg-location-id)
```

The brain never decides who a caller is. kitchenasty authenticates the user, picks one Location from their access set, and forwards that identity to the brain. The brain doesn't trust anything else.

## Isolation guarantees

| Boundary | How it's enforced |
|---|---|
| Restaurant ↔ restaurant | Every conversation, message and session row carries `location_id`. Every tool call sends `x-kg-location-id`, and the kitchenasty tools router filters every query on it. It has no "all locations" fallback. |
| Owner ↔ owner (same restaurant) | Conversations are keyed by `(location_id, principal_type, principal_id)`. Every read and write filters on all three. Someone else's conversation returns 404, the same as one that doesn't exist. |
| Model ↔ tenant | Tools are built per request as closures over the tenant. No tool takes a location or restaurant id, so a prompt can't redirect one. |
| Role | `STAFF` gets read-only tools. Write tools (menu availability, flows, re-engagement drafts) are registered only for `OWNER` / `MANAGER` / `SUPER_ADMIN`, and kitchenasty checks the role again. |
| Customer ↔ customer | WhatsApp sessions are keyed by `(location, phone)`. `myOrderStatus` returns only orders with that phone at that restaurant. Orders are always placed there, under that phone. |
| Network | Every route except `/api/guru/health` and `/api/v1/models` requires `GURU_INTERNAL_TOKEN`. The brain is reachable through the reverse proxy, so this matters. |

## Conversations and sessions

- **Conversation**: a persisted thread with a title, rolling summary, message count and status (`active` / `archived`).
- **Session**: one principal's presence on one channel at one location (`console` or `whatsapp`). It points at the current conversation, and its expiry slides forward on every turn. Once idle past the TTL (12h staff, 24h customers), the next message starts a fresh conversation.
- **Memory**: each turn replays the rolling summary plus the last `GURU_HISTORY_WINDOW` messages. When a thread grows past `GURU_SUMMARIZE_AFTER`, older messages are folded into the summary in the background.
- **Turn lock**: one turn at a time per conversation. A second concurrent send gets 409. The lock expires on its own after `GURU_TURN_LOCK_SECONDS`.

Storage is its own Postgres database (`guru_brain`). Tables are created idempotently on first use, so there's no migration step.

## API

All `/api/guru/*` staff routes expect the `x-kg-*` headers that kitchenasty adds. The browser calls kitchenasty's same-path proxies instead.

| Method & path | Purpose |
|---|---|
| `POST /api/guru/chat` | `{ message, conversationId?, newConversation? }` → `{ conversationId, title, reply, toolCalls, usage }` |
| `GET /api/guru/conversations?status=active\|archived\|all` | The caller's conversations and the session's current one |
| `POST /api/guru/conversations` | Start a new conversation and make it current |
| `GET/PATCH/DELETE /api/guru/conversations/:id` | Read messages (`?beforeId=` pages back), rename or archive, delete |
| `POST /api/guru/customer/chat` | `{ locationId, contact: { phone, name }, message }`, a WhatsApp turn |
| `POST /api/webhooks/concierge` | Legacy adapter onto the same agent (`mode: "guru_console"` or customer) |
| `POST /api/webhooks/bot-studio-interpret` | Bot Studio's choice/capture interpreter (pass `locationId`) |
| `GET/POST /api/mcp` | Read-only, customer-safe MCP tools (`menu_insights`, `fulfillment_snapshot`), per location |
| `POST /api/v1/chat/completions` | OpenAI-compatible, stateless. Used by the Live Inbox copilot |
| `GET /api/guru/health` | DB + model configuration status |

## Tools

**Console:** `getRestaurantOverview`, `getSalesAnalytics`, `listOrders`, `getOrder`, `getKitchenLoad`, `searchMenu`, `getReviews`, `getReservations`, `findLapsedCustomers`, `readInboxChats`, `getInsightSnapshots`, `getIngredientStock`, `getDishMargins`, `getReorderSuggestions`, `getVendorSpend`, `listBotFlows`, `getBotFlow`. Writers also get `setMenuItemAvailability`, `draftReengagementMessage`, `createBotFlow`, `updateBotFlow` and `publishBotFlow`.

**WhatsApp customer:** `checkMenu`, `placeOrder`, `myOrderStatus`, `escalateToHuman` (writes an `escalation` insight for staff).

When a tool fails, the model gets `{ error }` and is told to say so. There's no demo or fallback data.

## Configuration

| Variable | Default | |
|---|---|---|
| `GURU_INTERNAL_TOKEN` | — | Shared with kitchenasty. Required in production. |
| `GURU_DATABASE_URL` | — | e.g. `postgres://…/guru_brain` |
| `DASHBOARD_URL` | `http://localhost:3000` | kitchenasty-server |
| `GEMINI_API_KEY` | — | Hosted model key |
| `GURU_MODEL` | `gemini-3.6-flash` | Agent model |
| `ENABLE_LOCAL_LLM`, `CUSTOM_LLM_BASE_URL`, `GURU_LOCAL_MODEL` | off | Local model for light work (summaries, copilot) |
| `GURU_STAFF_SESSION_TTL_MINUTES` / `GURU_CUSTOMER_SESSION_TTL_MINUTES` | 720 / 1440 | Session idle expiry |
| `GURU_HISTORY_WINDOW` / `GURU_SUMMARIZE_AFTER` | 20 / 40 | Memory window |
| `GURU_TURN_LOCK_SECONDS`, `GURU_TOOL_TIMEOUT_MS`, `GURU_MAX_MESSAGE_CHARS` | 120 / 15000 / 8000 | Limits |

## Development

```bash
npm install
npm run dev        # reads .env.local
npx tsc --noEmit
```
