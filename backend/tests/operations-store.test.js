'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkdtemp } = require('node:fs/promises');

const testDataDirPromise = mkdtemp(path.join(os.tmpdir(), 'premium-menswear-v3-test-'));
let operations;
let testDataDir;

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function getDayKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()];
}
async function resetData() {
  await fs.rm(testDataDir, { recursive: true, force: true });
  await fs.mkdir(testDataDir, { recursive: true });
  await operations.ensureOperationsFiles();
}
async function configureHours(dateKey, { open = '10:00', close = '12:00', slotMinutes = 30, capacity = 1 } = {}) {
  const weeklyHours = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => [day, { closed: true, open: '10:00', close: '18:00' }]));
  weeklyHours[getDayKey(dateKey)] = { closed: false, open, close };
  await operations.updateAppointmentSettings({
    weeklyHours, slotMinutes, maxAppointmentsPerSlot: capacity, breakStart: '', breakEnd: '',
    minAdvanceHours: 0, maxAdvanceDays: 60, closedDates: [], exceptions: []
  });
}
function appointmentInput(date, time, name = 'Test Customer') {
  return { name, phone: '9876543210', email: 'test@example.com', service: 'Suiting consultation', date, time, occasion: 'Wedding & celebrations', style: 'Classic & timeless', notes: '' };
}

test.before(async () => {
  testDataDir = await testDataDirPromise;
  process.env.MENSWEAR_DATA_DIR = testDataDir;
  operations = require('../lib/operations-store');
});
test.beforeEach(async () => resetData());
test.after(async () => { await fs.rm(testDataDir, { recursive: true, force: true }); });

test('appointment schedule starts closed rather than inventing store hours', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  const availability = await operations.getAvailableSlots(date);
  assert.equal(availability.available, false);
  assert.equal(availability.slots.length, 0);
  assert.match(availability.reason, /not enabled/i);
});

test('availability follows configured hours, duration, and break rules', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  const weeklyHours = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => [day, { closed: true, open: '10:00', close: '18:00' }]));
  weeklyHours[getDayKey(date)] = { closed: false, open: '10:00', close: '12:00' };
  await operations.updateAppointmentSettings({ weeklyHours, slotMinutes: 30, maxAppointmentsPerSlot: 1, breakStart: '10:30', breakEnd: '11:00', minAdvanceHours: 0, maxAdvanceDays: 60, closedDates: [], exceptions: [] });
  const availability = await operations.getAvailableSlots(date);
  assert.deepEqual(availability.slots.map((slot) => slot.time), ['10:00', '11:00', '11:30']);
});

test('concurrent attempts cannot double-book the same exclusive time slot', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  await configureHours(date);
  const results = await Promise.allSettled([
    operations.createAppointment(appointmentInput(date, '10:00', 'Customer One')),
    operations.createAppointment(appointmentInput(date, '10:00', 'Customer Two'))
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'SLOT_UNAVAILABLE');
  const data = await operations.getAppointmentsData();
  assert.equal(data.appointments.length, 1);
});

test('separate Node processes coordinate through the appointment data lock', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  await configureHours(date);
  const modulePath = require.resolve('../lib/operations-store');
  const childSource = `const ops=require(${JSON.stringify(modulePath)});const input={name:process.env.TEST_NAME,phone:'9876543210',service:'Suiting consultation',date:process.env.TEST_DATE,time:'10:00'};ops.createAppointment(input).then(a=>{console.log(JSON.stringify({ok:true,reference:a.reference}));process.exit(0)}).catch(e=>{console.log(JSON.stringify({ok:false,code:e.code}));process.exit(e.code==='SLOT_UNAVAILABLE'?3:1)});`;
  const runChild = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource], { env: { ...process.env, MENSWEAR_DATA_DIR: testDataDir, TEST_NAME: name, TEST_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      let result;
      try { result = JSON.parse(line); } catch { return reject(new Error(`Child produced invalid output: ${stdout} ${stderr}`)); }
      resolve({ code, result, stderr });
    });
  });
  const results = await Promise.all([runChild('Process Customer One'), runChild('Process Customer Two')]);
  assert.equal(results.filter((item) => item.code === 0 && item.result.ok).length, 1);
  assert.equal(results.filter((item) => item.code === 3 && item.result.code === 'SLOT_UNAVAILABLE').length, 1);
  assert.equal((await operations.getAppointmentsData()).appointments.length, 1);
});

test('rescheduling releases the old slot and reserves the new slot atomically', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  await configureHours(date);
  const appointment = await operations.createAppointment(appointmentInput(date, '10:00'));
  const confirmed = await operations.updateAppointmentStatus(appointment.id, 'confirmed', 'Pratham');
  assert.equal(confirmed.appointment.status, 'confirmed');
  const moved = await operations.rescheduleAppointment(appointment.id, date, '11:00', 'Pratham', 'Customer agreed');
  assert.equal(moved.appointment.status, 'rescheduled');
  assert.equal(moved.appointment.time, '11:00');
  const slots = await operations.getAvailableSlots(date);
  assert.ok(slots.slots.some((slot) => slot.time === '10:00'));
  assert.ok(!slots.slots.some((slot) => slot.time === '11:00'));
  const cancelled = await operations.updateAppointmentStatus(appointment.id, 'cancelled', 'Pratham');
  assert.equal(cancelled.appointment.status, 'cancelled');
  const afterCancel = await operations.getAvailableSlots(date);
  assert.ok(afterCancel.slots.some((slot) => slot.time === '11:00'));
});

test('appointment workflow rejects invalid status transitions', async () => {
  const date = addDays(operations.indiaDateKey(), 3);
  await configureHours(date);
  const appointment = await operations.createAppointment(appointmentInput(date, '10:00'));
  await assert.rejects(operations.updateAppointmentStatus(appointment.id, 'completed', 'Pratham'), { code: 'INVALID_TRANSITION' });
});

test('orders support multiple garments and preserve garment-level history', async () => {
  const today = operations.indiaDateKey();
  const order = await operations.createOrder({
    customerName: 'Test Customer', phone: '9876543210', orderDate: today, expectedCollectionDate: addDays(today, 12), notes: 'Test record',
    garments: [
      { type: 'Custom suit', description: 'Navy two-piece suit', quantity: '1', fabricLabel: 'Navy sample', instructions: 'Test only' },
      { type: 'Shirt', description: 'White formal shirt', quantity: '2', fabricLabel: 'White sample', instructions: '' }
    ]
  }, 'Pratham');
  assert.match(order.reference, /^ORD-\d{4}-\d{4}$/);
  assert.equal(order.garments.length, 2);
  const fabric = await operations.updateGarmentStatus(order.id, order.garments[0].id, 'fabric_confirmed', 'Pratham');
  assert.equal(fabric.garment.status, 'fabric_confirmed');
  await assert.rejects(operations.updateGarmentStatus(order.id, order.garments[0].id, 'ready_for_collection', 'Pratham'), { code: 'INVALID_TRANSITION' });
  const persisted = await operations.getOrdersData();
  assert.equal(persisted.orders[0].garments[0].statusHistory.length, 2);
});

test('order archive protects active orders and never deletes their records', async () => {
  const today = operations.indiaDateKey();
  const order = await operations.createOrder({ customerName: 'Test Customer', orderDate: today, garments: [{ type: 'Shirt', quantity: '1' }] }, 'Pratham');
  await assert.rejects(operations.archiveOrder(order.id, true, 'Pratham'), { code: 'INVALID_TRANSITION' });
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'fabric_confirmed', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'cutting', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'stitching', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'ready_for_collection', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'collected', 'Pratham');
  await operations.archiveOrder(order.id, true, 'Pratham');
  const restored = await operations.getOrdersData();
  assert.equal(restored.orders.length, 1);
  assert.equal(restored.orders[0].archived, true);
});

test('mixed garment progress never marks an entire order ready while a garment is still in production', async () => {
  const today = operations.indiaDateKey();
  const order = await operations.createOrder({
    customerName: 'Test Customer', orderDate: today,
    garments: [
      { type: 'Custom suit', quantity: '1' },
      { type: 'Shirt', quantity: '1' }
    ]
  }, 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'fabric_confirmed', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'cutting', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'stitching', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[0].id, 'ready_for_collection', 'Pratham');
  const mixed = await operations.getOrdersData();
  assert.equal(operations.getOrderOverallStatus(mixed.orders[0]), 'in_progress');
  await operations.updateGarmentStatus(order.id, order.garments[1].id, 'fabric_confirmed', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[1].id, 'cutting', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[1].id, 'stitching', 'Pratham');
  await operations.updateGarmentStatus(order.id, order.garments[1].id, 'ready_for_collection', 'Pratham');
  const bothReady = await operations.getOrdersData();
  assert.equal(operations.getOrderOverallStatus(bothReady.orders[0]), 'ready_for_collection');
});
