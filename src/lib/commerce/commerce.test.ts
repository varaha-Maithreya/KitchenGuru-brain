import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext } from '../tenant';
import type { KitchenClient } from '../kitchen';
import { kitchenGuruBackend } from './adapters/kitchenguru';
import { httpContractBackend } from './adapters/httpContract';
import { getCommerceBackend, registerCommerceBackend } from './registry';
import { isError, type CommerceBackend } from './types';

const tenant: TenantContext = { locationId: 'loc-A', principal: { type: 'customer', id: '919999900001', name: 'Asha' } };

const fakeKitchen = (over: Partial<KitchenClient> = {}): KitchenClient => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), ...over,
}) as KitchenClient;

describe('KitchenGuru adapter', () => {
  it('maps the menu into contract catalogue items', async () => {
    const client = fakeKitchen({
      get: vi.fn().mockResolvedValue({ items: [{ id: 'm1', name: 'Biryani', price: 240, category: 'Mains', allergens: [], available: true }] }),
    });
    const items = await kitchenGuruBackend(tenant, client).searchCatalog('biryani');

    expect(client.get).toHaveBeenCalledWith('/menu', { search: 'biryani', availableOnly: true, customer: true });
    expect(items).toEqual([expect.objectContaining({ id: 'm1', name: 'Biryani', price: 240, available: true })]);
  });

  it('translates an order both ways and surfaces the payment link', async () => {
    const post = vi.fn().mockResolvedValue({ orderNumber: 'KG-1', total: 480, status: 'PENDING', payment: { status: 'PENDING', url: 'https://shop/pay/o1' } });
    const placed = await kitchenGuruBackend(tenant, fakeKitchen({ post })).placeOrder({
      lines: [{ itemId: 'm1', quantity: 2, note: 'no onion' }],
      fulfilment: 'DELIVERY',
      note: 'ring bell',
      customer: { name: 'Asha', phone: '919999900001' },
    });

    expect(post).toHaveBeenCalledWith('/orders', {
      items: [{ menuItemId: 'm1', quantity: 2, comment: 'no onion' }], orderType: 'DELIVERY', comment: 'ring bell', customerName: 'Asha',
    });
    expect(placed).toEqual({ reference: 'KG-1', total: 480, status: 'PENDING', payment: { status: 'PENDING', url: 'https://shop/pay/o1' } });
  });

  it('reports no payment when nothing is owed, and lists unpaid orders with their link', async () => {
    const client = fakeKitchen({
      post: vi.fn().mockResolvedValue({ orderNumber: 'KG-2', total: 100, status: 'CONFIRMED', payment: null }),
      get: vi.fn().mockResolvedValue({ orders: [{ orderNumber: 'KG-1', status: 'PENDING', total: 480, orderType: 'PICKUP', payment: { status: 'PENDING', url: 'https://shop/pay/o1' } }] }),
    });
    const backend = kitchenGuruBackend(tenant, client);

    const placed = await backend.placeOrder({ lines: [{ itemId: 'm1', quantity: 1 }], fulfilment: 'PICKUP', customer: { phone: '919999900001' } });
    expect(isError(placed) ? null : placed.payment).toBeNull();

    const mine = await backend.listMyOrders();
    expect(isError(mine) ? [] : mine[0]).toMatchObject({ reference: 'KG-1', fulfilment: 'PICKUP', payment: { url: 'https://shop/pay/o1' } });
  });

  it('passes backend errors through untouched', async () => {
    const client = fakeKitchen({ post: vi.fn().mockResolvedValue({ error: 'Some items are not on this restaurant\'s menu' }) });
    const r = await kitchenGuruBackend(tenant, client).placeOrder({ lines: [{ itemId: 'x', quantity: 1 }], fulfilment: 'PICKUP', customer: { phone: '1' } });
    expect(r).toEqual({ error: "Some items are not on this restaurant's menu" });
  });
});

describe('HTTP contract adapter (any other backend)', () => {
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('speaks the documented contract with tenant and customer headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ data: { reference: 'FG-9', total: 50, status: 'PENDING', payment: { status: 'PENDING', url: 'https://fin/pay/9' } } }));
    const backend = httpContractBackend(tenant, { baseUrl: 'https://fin.example/api/', token: 't0k', fetchImpl });

    const placed = await backend.placeOrder({ lines: [{ itemId: 'sku-1', quantity: 1 }], fulfilment: 'PICKUP', customer: { phone: '919999900001' } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://fin.example/api/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t0k', 'x-tenant-id': 'loc-A', 'x-customer-phone': '919999900001' });
    expect(placed).toMatchObject({ reference: 'FG-9', payment: { url: 'https://fin/pay/9' } });
  });

  it('searches with an encoded query and returns errors instead of throwing', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ data: [] }))
      .mockResolvedValueOnce(reply({ error: 'nope' }, 422))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const backend = httpContractBackend(tenant, { baseUrl: 'https://fin.example', fetchImpl });

    await backend.searchCatalog('cold brew');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://fin.example/catalog?q=cold%20brew');
    expect(await backend.listMyOrders()).toEqual({ error: 'nope' });
    expect(await backend.listMyOrders()).toEqual({ error: 'Order system is unreachable' });
  });
});

describe('backend registry', () => {
  const prev = process.env.COMMERCE_BACKEND;
  beforeEach(() => { delete process.env.COMMERCE_BACKEND; });
  afterEach(() => {
    if (prev === undefined) delete process.env.COMMERCE_BACKEND;
    else process.env.COMMERCE_BACKEND = prev;
  });

  it('defaults to KitchenGuru', () => {
    expect(getCommerceBackend(tenant).id).toBe('kitchenguru');
  });

  it('swaps backend by config alone', () => {
    const fake: CommerceBackend = {
      id: 'financeguru',
      searchCatalog: async () => [],
      placeOrder: async () => ({ reference: 'FG-1', total: 1, status: 'PENDING', payment: { status: 'PENDING', url: 'https://fg/pay' } }),
      listMyOrders: async () => [],
    };
    registerCommerceBackend('financeguru', () => fake);
    process.env.COMMERCE_BACKEND = 'financeguru';

    expect(getCommerceBackend(tenant)).toBe(fake);
  });

  it('fails honestly, on every call, for an unknown or unconfigured backend', async () => {
    process.env.COMMERCE_BACKEND = 'nonexistent';
    const missing = getCommerceBackend(tenant);
    expect(await missing.placeOrder({ lines: [{ itemId: 'a', quantity: 1 }], fulfilment: 'PICKUP', customer: { phone: '1' } }))
      .toEqual({ error: expect.stringContaining('not available') });

    delete process.env.COMMERCE_HTTP_BASE_URL;
    const http = getCommerceBackend(tenant, 'http');
    expect(await http.searchCatalog()).toEqual({ error: expect.stringContaining('COMMERCE_HTTP_BASE_URL') });
  });
});
