const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodePath = require('node:path');

// Load a module with a fake models/index.js; no production DB access.
function load(path, db) {
  const file = require.resolve(path);
  const context = { module: { exports: {} }, console, require(name) {
    if (name === '../../../models') return db;
    if (name.includes('ApiError')) return class extends Error { constructor(code, message) { super(message); this.statusCode = code; } };
    if (!name.startsWith('.')) return require(name);
    // Relative requires resolve from the loaded module; sibling services share the fake db.
    const target = require.resolve(nodePath.resolve(nodePath.dirname(file), name));
    return target.includes(`${nodePath.sep}app${nodePath.sep}modules${nodePath.sep}`) ? load(target, db) : require(target);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.module.exports;
}

const variation = (Id, options, newPrice, stock = 10, extra = {}) =>
  ({ Id, options, oldPrice: newPrice + 100, newPrice, stock, availability: 'in stock', ...extra });

function pricingDb() {
  const products = [
    { Id: 1, name: 'Attar', status: 'Active', variations: [
      variation(11, { Volume: '3ml' }, 500),
      variation(12, { Volume: '6ml' }, 900, 1),
    ] },
    { Id: 2, name: 'Oud', status: 'Active', variations: [variation(21, null, 1100)] },
    { Id: 3, name: 'Free Attar', status: 'Active', freeShipping: true, variations: [variation(31, null, 400)] },
  ];
  return {
    product: { async findAll({ where }) {
      const ids = where.Id[Object.getOwnPropertySymbols(where.Id)[0]];
      return products.filter((product) => ids.includes(product.Id));
    } },
    landingPage: { async findOne() {
      return { Id: 7, productId: 2, price: 999, regularData: JSON.stringify({ deliveryOutside: 150, productOptions: [{ productId: 2, name: 'Oud Offer', price: 850 }] }) };
    } },
    deliveryCharge: { async findAll() {
      return [{ note: 'ঢাকার ভিতরে ৮০ টাকা', amount: '80.00' }, { note: 'ঢাকার বাইরে ১২০ টাকা', amount: '120.00' }];
    } },
    variation: {},
  };
}

test('website order prices come from the selected variant, not the client', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  const result = await priceOrderItems({ items: [
    { id: 1, variantId: 12, name: 'x', price: 1, qty: 1 },
    { id: 2, name: 'Oud', price: 1, qty: 2 },
  ] });
  assert.equal(result.items[0].price, 900);
  assert.equal(result.items[0].name, 'Attar');
  assert.equal(result.items[0].variant, 'Volume: 6ml');
  // Single-variant product without variantId (old carts) resolves to its only variant.
  assert.equal(result.items[1].price, 1100);
  assert.equal(result.items[1].variantId, 21);
});

test('multi-variant product requires a variant and enough stock', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  await assert.rejects(priceOrderItems({ items: [{ id: 1, qty: 1 }] }), /variant/);
  await assert.rejects(priceOrderItems({ items: [{ id: 1, variantId: 12, qty: 2 }] }), /stock/);
  await assert.rejects(priceOrderItems({ items: [{ id: 1, variantId: 21, qty: 1 }] }), /variant/);
  await assert.rejects(priceOrderItems({ items: [{ id: 99, qty: 1 }] }), /পাওয়া যাচ্ছে না/);
  // Legacy size match still works.
  const legacy = await priceOrderItems({ items: [{ id: 1, size: '3ml', qty: 1 }] });
  assert.equal(legacy.items[0].variantId, 11);
});

test('incomplete drafts keep unresolvable items instead of failing', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  const result = await priceOrderItems({ items: [{ id: 1, price: 5, qty: 1 }] }, { strict: false });
  assert.equal(result.items[0].price, 5);
});

test('landing orders use the landing offer price and link single-variant stock', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  const result = await priceOrderItems({
    orderSource: 'Landing Page', tracking: { landingPageId: 7 },
    items: [{ id: 2, name: 'Oud Offer', price: 1, qty: 1 }],
  });
  assert.equal(result.items[0].price, 850);
  assert.equal(result.items[0].variantId, 21);
});

function stockDb() {
  const stock = new Map([[11, 10], [12, 5]]);
  return { stock, db: { variation: { async increment(values, { where }) {
    stock.set(where.Id, stock.get(where.Id) + values.stock);
  } } } };
}

const orderRow = (status, items) => ({
  status, note: JSON.stringify({ __frontendOrder: true, items }), stockLedger: null,
  async update(values) { Object.assign(this, values); return this; },
});

test('order stock is held while active, released on cancel and re-held on reactivation', async () => {
  const { stock, db } = stockDb();
  const { reconcileOrderStock } = load('../app/modules/order/orderStock', db);
  const order = orderRow('pending', [{ variantId: 11, qty: 2 }, { variantId: 12, qty: 1 }, { id: 3, qty: 1 }]);

  await reconcileOrderStock(order);
  assert.deepEqual([stock.get(11), stock.get(12)], [8, 4]);
  await reconcileOrderStock(order); // idempotent
  assert.deepEqual([stock.get(11), stock.get(12)], [8, 4]);

  order.status = 'cancelled';
  await reconcileOrderStock(order);
  assert.deepEqual([stock.get(11), stock.get(12)], [10, 5]);

  order.status = 'confirmed';
  order.note = JSON.stringify({ items: [{ variantId: 11, qty: 3 }] }); // admin edited items
  await reconcileOrderStock(order);
  assert.deepEqual([stock.get(11), stock.get(12)], [7, 5]);

  await reconcileOrderStock(order, undefined, { released: true }); // deleted
  assert.deepEqual([stock.get(11), stock.get(12)], [10, 5]);
});

test('incomplete orders never hold stock', async () => {
  const { stock, db } = stockDb();
  const { reconcileOrderStock } = load('../app/modules/order/orderStock', db);
  await reconcileOrderStock(orderRow('incomplete', [{ variantId: 11, qty: 2 }]));
  assert.equal(stock.get(11), 10);
});

test('delivery charge and advance are decided by the server', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  const item = { id: 2, qty: 1 };
  const dhaka = await priceOrderItems({ customerDistrict: 'Dhaka', deliveryCharge: 0, advance: 5000, items: [item] });
  assert.equal(dhaka.deliveryCharge, 80);
  assert.equal(dhaka.advance, 0);
  // Settings below the minimum (outside 120 < 130) are raised to it.
  assert.equal((await priceOrderItems({ customerDistrict: 'Khulna', items: [item] })).deliveryCharge, 130);
  // Outdated client without a district pays the outside rate.
  assert.equal((await priceOrderItems({ items: [item] })).deliveryCharge, 130);
  // Every item ships free -> no charge; one paid item -> charge applies.
  assert.equal((await priceOrderItems({ customerDistrict: 'Dhaka', items: [{ id: 3, qty: 1 }] })).deliveryCharge, 0);
  assert.equal((await priceOrderItems({ customerDistrict: 'Dhaka', items: [{ id: 3, qty: 1 }, item] })).deliveryCharge, 80);

  const landing = await priceOrderItems({
    orderSource: 'Landing Page', tracking: { landingPageId: 7 }, customerDistrict: 'outside',
    items: [{ id: 2, name: 'Oud Offer', qty: 1 }],
  });
  assert.equal(landing.deliveryCharge, 150);
  // Landing page inside charge is unset -> minimum 80.
  const inside = await priceOrderItems({
    orderSource: 'Landing Page', tracking: { landingPageId: 7 }, customerDistrict: 'inside',
    items: [{ id: 2, name: 'Oud Offer', qty: 1 }],
  });
  assert.equal(inside.deliveryCharge, 80);
});

test('landing orders ship free when every linked product is free shipping', async () => {
  const db = pricingDb();
  db.landingPage.findOne = async () => ({ Id: 8, regularData: JSON.stringify({
    deliveryInside: 90,
    productOptions: [{ productId: 3, name: 'Free Offer', price: 350 }, { productId: 2, name: 'Oud Offer', price: 850 }],
  }) });
  const { priceOrderItems } = load('../app/modules/order/orderPricing', db);
  const order = (items) => priceOrderItems({ orderSource: 'Landing Page', tracking: { landingPageId: 8 }, customerDistrict: 'inside', items });
  assert.equal((await order([{ id: 3, name: 'Free Offer', qty: 1 }])).deliveryCharge, 0);
  assert.equal((await order([{ id: 3, name: 'Free Offer', qty: 1 }, { id: 2, name: 'Oud Offer', qty: 1 }])).deliveryCharge, 90);
});

test('public orders must contain items', async () => {
  const { priceOrderItems } = load('../app/modules/order/orderPricing', pricingDb());
  await assert.rejects(priceOrderItems({ totalBill: 1, productName: 'x' }), /No items/);
  await assert.rejects(priceOrderItems({ items: [] }), /No items/);
  await assert.rejects(priceOrderItems({ note: '{"items":[]}' }, { strict: false }), /No items/);
});

test('staff orders keep staff prices but resolve variants and totals', async () => {
  const { resolveStaffItems, calculateStaffTotals } = load('../app/modules/order/orderPricing', pricingDb());
  const items = await resolveStaffItems([
    { id: 1, variantId: 12, name: 'x', price: 850, qty: 2, disc: 100 },
    { id: null, name: 'Legacy line', price: 300, qty: 1 },
  ]);
  assert.equal(items[0].variantId, 12);
  assert.equal(items[0].name, 'Attar');
  assert.equal(items[0].price, 850);
  assert.equal(items[1].variantId, undefined);
  assert.deepEqual({ ...calculateStaffTotals(items, { deliveryCharge: 80, discount: 50 }) },
    { subtotal: 1900, deliveryCharge: 80, discount: 50, total: 1930 });
  await assert.rejects(resolveStaffItems([{ id: 1, price: 500, qty: 1 }]), /variant/);
  await assert.rejects(resolveStaffItems([]), /No items/);
});

test('a delivery zone without a district sets the charge and keeps the address as typed', async () => {
  const db = pricingDb();
  db.deliveryArea = { async findAll() {
    return [
      { Id: 1, district: '', area: 'Inside Dhaka', charge: '80.00', status: 'Active' },
      { Id: 2, district: '', area: 'Outside Dhaka', charge: '130.00', status: 'Active' },
    ];
  } };
  const { priceOrderItems } = load('../app/modules/order/orderPricing', db);
  const item = { id: 2, qty: 1 };
  const inside = await priceOrderItems({ deliveryAreaId: 1, customerAddress: 'Khilgaon', items: [item] });
  assert.equal(inside.deliveryCharge, 80);
  assert.equal(inside.customerDistrict, 'Inside Dhaka');
  assert.equal(inside.customerAddress, 'Khilgaon');
  assert.equal((await priceOrderItems({ deliveryAreaId: 2, items: [item] })).deliveryCharge, 130);
  await assert.rejects(priceOrderItems({ customerDistrict: 'Dhaka', items: [item] }));
});

test('a product limited to some delivery areas rejects the others', async () => {
  const db = pricingDb();
  db.deliveryArea = { async findAll() {
    return [
      { Id: 1, district: '', area: 'Inside Dhaka', charge: '80.00', status: 'Active' },
      { Id: 2, district: '', area: 'Outside Dhaka', charge: '130.00', status: 'Active' },
    ];
  } };
  const findAll = db.product.findAll;
  db.product.findAll = async (query) => (await findAll(query)).map((product) =>
    (product.Id === 2 ? { ...product, deliveryAreaIds: '[1]' } : product));
  const { priceOrderItems } = load('../app/modules/order/orderPricing', db);
  const limited = { id: 2, qty: 1 };
  assert.equal((await priceOrderItems({ deliveryAreaId: 1, items: [limited] })).deliveryCharge, 80);
  await assert.rejects(priceOrderItems({ deliveryAreaId: 2, items: [limited] }), /ডেলিভারি হয় না/);
  // A product without a limit allows every area.
  assert.equal((await priceOrderItems({ deliveryAreaId: 2, items: [{ id: 1, variantId: 11, qty: 1 }] })).deliveryCharge, 130);
  // Incomplete drafts never fail on it.
  assert.equal((await priceOrderItems({ deliveryAreaId: 2, items: [limited] }, { strict: false })).deliveryCharge, 0);
});
