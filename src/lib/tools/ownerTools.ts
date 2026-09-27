import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { kitchenClient } from '../kitchen';
import { canWrite, type TenantContext } from '../tenant';
import { BOT_FLOW_GRAPH_SPEC } from './botFlowSpec';

/**
 * Guru's owner/staff toolset for the console. Built per request, bound to
 * one tenant: no tool accepts a location or restaurant id, so the model
 * cannot address another restaurant even if a prompt asks it to.
 * Write tools are only registered for OWNER / MANAGER / SUPER_ADMIN.
 */
export function ownerTools(tenant: TenantContext): ToolSet {
  const k = kitchenClient(tenant);

  const read: ToolSet = {
    getRestaurantOverview: tool({
      description: "This restaurant's profile and live state: name, address, busy mode, delivery/pickup settings, and today's headline numbers. Call first when you need basic context.",
      inputSchema: z.object({}),
      execute: async () => k.get('/overview'),
    }),

    getSalesAnalytics: tool({
      description: 'Revenue, order count, average ticket, order-type and status mix, top sellers and the daily trend for this restaurant over the last N days, compared with the previous period.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).default(30).describe('Look-back window in days'),
      }),
      execute: async ({ days }) => k.get('/sales', { days }),
    }),

    listOrders: tool({
      description: 'Recent orders for this restaurant with status, type, total, item count and age. Use for "what is pending", "how many cancellations today", fulfilment evidence.',
      inputSchema: z.object({
        status: z.enum(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED']).optional(),
        sinceHours: z.number().int().min(1).max(24 * 30).default(24),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async (input) => k.get('/orders', input),
    }),

    getOrder: tool({
      description: 'Full detail for one order by its order number: items, options, customer, payments and every status change with timestamps.',
      inputSchema: z.object({ orderNumber: z.string().min(1) }),
      execute: async ({ orderNumber }) => k.get(`/orders/${encodeURIComponent(orderNumber)}`),
    }),

    getKitchenLoad: tool({
      description: 'Live kitchen pressure: active orders by status, age of the oldest waiting order, and measured PREPARING→READY times today vs the 7-day norm.',
      inputSchema: z.object({}),
      execute: async () => k.get('/kitchen-load'),
    }),

    searchMenu: tool({
      description: "Search this restaurant's menu: price, category, active flag, stock tracking and quantity. Use for stock/availability and pricing questions.",
      inputSchema: z.object({
        query: z.string().optional().describe('Dish name or keyword; omit for the whole menu'),
        availableOnly: z.boolean().default(false),
      }),
      execute: async ({ query, availableOnly }) => k.get('/menu', { search: query, availableOnly }),
    }),

    getReviews: tool({
      description: 'Customer reviews for this restaurant: average rating, rating distribution and the most recent comments. Use to find repeat complaints or praise.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).default(30),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async (input) => k.get('/reviews', input),
    }),

    getReservations: tool({
      description: 'Upcoming reservations for this restaurant over the next N days, with party size, time and status.',
      inputSchema: z.object({ days: z.number().int().min(1).max(60).default(7) }),
      execute: async (input) => k.get('/reservations', input),
    }),

    findLapsedCustomers: tool({
      description: "Regulars of this restaurant who haven't ordered in a while: name, phone, order count, last order date and favourite dish. Use before drafting win-back messages.",
      inputSchema: z.object({
        inactiveDays: z.number().int().min(7).max(365).default(21),
        minOrders: z.number().int().min(1).max(50).default(2),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (input) => k.get('/customers/lapsed', input),
    }),

    readInboxChats: tool({
      description: "Recent Live Inbox (WhatsApp) conversations for this restaurant with the last few messages of each. Use to analyse complaints, praise and trends.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(15).default(5) }),
      execute: async ({ limit }) => k.get('/inbox/chats', { limit }),
    }),

    getInsightSnapshots: tool({
      description: 'Findings already computed by background jobs for this restaurant: kitchen bottlenecks, low-stock forecasts, re-engagement drafts and escalations. Prefer these over re-deriving the same conclusions.',
      inputSchema: z.object({
        type: z.enum(['bottleneck', 'low_stock_forecast', 'ingredient_low_stock', 'ingredient_low_stock_forecast', 'reengagement_draft', 'escalation']).optional(),
        status: z.enum(['new', 'approved', 'dismissed']).optional(),
      }),
      execute: async (input) => k.get('/insights', input),
    }),

    getIngredientStock: tool({
      description: "This kitchen's raw-material stock (shared by all its brands): current quantity, alert threshold, average daily use over the last week and days left. Use for questions about ingredients running low, what to reorder, or waste.",
      inputSchema: z.object({
        lowOnly: z.boolean().optional().describe('Only ingredients that are out or below their alert threshold'),
      }),
      execute: async ({ lowOnly }) => k.get('/ingredients', { lowOnly }),
    }),

    getReorderSuggestions: tool({
      description: "What this kitchen should reorder now: ingredients below their alert level or running out within 5 days, the quantity needed to cover a week, what is already on order, and the vendor/price last used. Use for 'what should I order' questions. You cannot place orders yourself; tell the owner to create the purchase order in Inventory → Reorder.",
      inputSchema: z.object({}),
      execute: async () => k.get('/reorder'),
    }),

    getVendorSpend: tool({
      description: "Ingredient purchasing for this kitchen: value of goods received per vendor over the period, and purchase orders still open (ordered / partly received).",
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe('Window in days, default 30') }),
      execute: async ({ days }) => k.get('/vendor-spend', { days }),
    }),

    getDishMargins: tool({
      description: "Food cost and margin per dish for this kitchen: portion cost from recipes at current ingredient costs, price, margin %, units sold and gross profit over the period, plus overall food-cost %. Sorted lowest margin first. Use for pricing, menu engineering and 'which dishes lose money' questions.",
      inputSchema: z.object({ days: z.number().int().min(1).max(90).optional().describe('Sales window, default 30') }),
      execute: async ({ days }) => k.get('/dish-costs', { days }),
    }),

    listBotFlows: tool({
      description: "This restaurant's Bot Studio flows (id, name, status, trigger, block count). Always call before creating a flow, to reuse one that already fits.",
      inputSchema: z.object({}),
      execute: async () => k.get('/flows'),
    }),

    getBotFlow: tool({
      description: "One Bot Studio flow's full node/edge graph, so you can see exactly what exists before editing it.",
      inputSchema: z.object({ flowId: z.string().min(1) }),
      execute: async ({ flowId }) => k.get(`/flows/${encodeURIComponent(flowId)}`),
    }),
  };

  if (!canWrite(tenant)) return read;

  const write: ToolSet = {
    setMenuItemAvailability: tool({
      description: 'Mark a menu item sold out / back on, or set its tracked stock quantity. Only do this when the owner explicitly asks; confirm the exact item first with searchMenu.',
      inputSchema: z.object({
        menuItemId: z.string().min(1),
        isActive: z.boolean().optional().describe('false = sold out / hidden from customers'),
        stockQty: z.number().int().min(0).optional().describe('New tracked stock quantity (enables stock tracking)'),
      }),
      execute: async ({ menuItemId, ...patch }) => k.patch(`/menu/${encodeURIComponent(menuItemId)}`, patch),
    }),

    draftReengagementMessage: tool({
      description: "Draft a personalised WhatsApp win-back message for one lapsed customer and save it to the owner's Insights review queue. It is never sent until the owner approves it.",
      inputSchema: z.object({
        customerName: z.string(),
        customerPhone: z.string().describe('With country code'),
        draftMessage: z.string().describe('The full message, ready to send as-is if approved'),
        reason: z.string().describe('Why this customer, e.g. "ordered Paneer Tikka 6 times, none in 30 days"'),
      }),
      execute: async (payload) => k.post('/insights', { type: 'reengagement_draft', payload }),
    }),

    createBotFlow: tool({
      description: 'Create a new, empty Bot Studio flow (only a Start block) for this restaurant. Follow immediately with updateBotFlow — an empty flow does nothing.',
      inputSchema: z.object({
        name: z.string().describe('Short name, e.g. "Weekend brunch promo"'),
        trigger: z.string().optional().describe('When it should run, in plain language'),
      }),
      execute: async (input) => k.post('/flows', input),
    }),

    updateBotFlow: tool({
      description: BOT_FLOW_GRAPH_SPEC,
      inputSchema: z.object({
        flowId: z.string(),
        nodes: z.array(z.record(z.string(), z.any())).describe('Full array of flow nodes'),
        edges: z.array(z.record(z.string(), z.any())).describe('Full array of flow edges'),
      }),
      execute: async ({ flowId, nodes, edges }) => k.patch(`/flows/${encodeURIComponent(flowId)}`, { nodes, edges }),
    }),

    publishBotFlow: tool({
      description: 'Publish a Bot Studio flow live to real customers. Only after updateBotFlow reports zero issues — publishing fails if the flow is invalid.',
      inputSchema: z.object({ flowId: z.string() }),
      execute: async ({ flowId }) => k.post(`/flows/${encodeURIComponent(flowId)}/publish`, {}),
    }),
  };

  return { ...read, ...write };
}
