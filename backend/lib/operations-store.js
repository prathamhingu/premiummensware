'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.MENSWEAR_DATA_DIR ? path.resolve(process.env.MENSWEAR_DATA_DIR) : path.join(ROOT, 'data');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const ACTIVE_APPOINTMENT_STATUSES = new Set(['pending', 'confirmed', 'reschedule_requested', 'rescheduled']);
const APPOINTMENT_STATUS_LABELS = {
  pending: 'Pending', confirmed: 'Confirmed', reschedule_requested: 'Reschedule requested',
  rescheduled: 'Rescheduled', cancelled: 'Cancelled', rejected: 'Rejected', completed: 'Completed', no_show: 'No-show'
};
const APPOINTMENT_TRANSITIONS = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['reschedule_requested', 'cancelled', 'completed', 'no_show'],
  reschedule_requested: ['confirmed', 'rescheduled', 'cancelled', 'rejected'],
  rescheduled: ['reschedule_requested', 'cancelled', 'completed', 'no_show'],
  cancelled: [], rejected: [], completed: [], no_show: []
};
const GARMENT_STATUS_LABELS = {
  order_confirmed: 'Order confirmed', fabric_confirmed: 'Fabric confirmed', cutting: 'Cutting',
  stitching: 'Stitching', fitting: 'Trial / fitting', alterations: 'Alterations / finishing',
  ready_for_collection: 'Ready for collection', collected: 'Collected', cancelled: 'Cancelled'
};
const GARMENT_TRANSITIONS = {
  order_confirmed: ['fabric_confirmed', 'cancelled'],
  fabric_confirmed: ['cutting', 'cancelled'],
  cutting: ['stitching', 'cancelled'],
  stitching: ['fitting', 'alterations', 'ready_for_collection', 'cancelled'],
  fitting: ['alterations', 'ready_for_collection', 'cancelled'],
  alterations: ['fitting', 'ready_for_collection', 'cancelled'],
  ready_for_collection: ['collected', 'cancelled'],
  collected: [], cancelled: []
};

function makeId(prefix) { return `${prefix}_${crypto.randomBytes(10).toString('hex')}`; }
function dateKeyValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timeValid(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function indiaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function dateTimeInIndia(dateKey, time) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute - 30));
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}
async function withFileLock(filePath, operation) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const [raw, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
        let metadata = {};
        try { metadata = JSON.parse(raw); } catch { /* a newly created lock may not have been written yet */ }
        const age = Date.now() - stat.mtimeMs;
        if (Number.isInteger(metadata.pid)) stale = age > 30_000 && !isPidAlive(metadata.pid);
        else stale = age > 120_000;
        if (stale) await fs.unlink(lockPath).catch(() => {});
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') throw lockError;
      }
      if (Date.now() - startedAt > 20_000) {
        const timeout = new Error('The business data file is busy. Please retry the operation.');
        timeout.code = 'STORE_LOCK_TIMEOUT';
        throw timeout;
      }
      await sleep(25 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}
function defaultAppointmentSettings() {
  const weeklyHours = {};
  for (const key of DAY_KEYS) weeklyHours[key] = { closed: true, open: '10:00', close: '18:00' };
  return {
    timezone: 'Asia/Kolkata',
    weeklyHours,
    slotMinutes: 30,
    maxAppointmentsPerSlot: 1,
    breakStart: '',
    breakEnd: '',
    minAdvanceHours: 2,
    maxAdvanceDays: 60,
    closedDates: [],
    exceptions: [],
    pendingHoldsSlot: true
  };
}
function defaultAppointmentsData() {
  return { version: 1, settings: defaultAppointmentSettings(), sequenceByYear: {}, appointments: [] };
}
function defaultOrdersData() {
  return { version: 1, sequenceByYear: {}, orders: [] };
}
async function ensureJsonFile(filePath, factory) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try { await fs.access(filePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await atomicWrite(filePath, factory()); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
  }
}
async function ensureOperationsFiles() {
  await ensureJsonFile(APPOINTMENTS_FILE, defaultAppointmentsData);
  await ensureJsonFile(ORDERS_FILE, defaultOrdersData);
}
function mergeAppointmentData(saved) {
  const defaults = defaultAppointmentsData();
  const incomingSettings = saved.settings || {};
  const weekly = { ...defaults.settings.weeklyHours };
  for (const day of DAY_KEYS) weekly[day] = { ...defaults.settings.weeklyHours[day], ...(incomingSettings.weeklyHours?.[day] || {}) };
  return {
    ...defaults, ...saved,
    settings: { ...defaults.settings, ...incomingSettings, weeklyHours: weekly,
      closedDates: Array.isArray(incomingSettings.closedDates) ? incomingSettings.closedDates : [],
      exceptions: Array.isArray(incomingSettings.exceptions) ? incomingSettings.exceptions : [] },
    sequenceByYear: saved.sequenceByYear && typeof saved.sequenceByYear === 'object' ? saved.sequenceByYear : {},
    appointments: Array.isArray(saved.appointments) ? saved.appointments : []
  };
}
async function readFileJson(filePath, factory) {
  await ensureJsonFile(filePath, factory);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return filePath === APPOINTMENTS_FILE ? mergeAppointmentData(parsed) : { ...defaultOrdersData(), ...parsed, sequenceByYear: parsed.sequenceByYear || {}, orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
}
async function getAppointmentsData() { return readFileJson(APPOINTMENTS_FILE, defaultAppointmentsData); }
async function getOrdersData() { return readFileJson(ORDERS_FILE, defaultOrdersData); }
async function mutateAppointments(mutator) {
  await ensureOperationsFiles();
  return withFileLock(APPOINTMENTS_FILE, async () => {
    const data = mergeAppointmentData(JSON.parse(await fs.readFile(APPOINTMENTS_FILE, 'utf8')));
    const result = await mutator(data);
    await atomicWrite(APPOINTMENTS_FILE, data);
    return result;
  });
}
async function mutateOrders(mutator) {
  await ensureOperationsFiles();
  return withFileLock(ORDERS_FILE, async () => {
    const raw = JSON.parse(await fs.readFile(ORDERS_FILE, 'utf8'));
    const data = { ...defaultOrdersData(), ...raw, sequenceByYear: raw.sequenceByYear || {}, orders: Array.isArray(raw.orders) ? raw.orders : [] };
    const result = await mutator(data);
    await atomicWrite(ORDERS_FILE, data);
    return result;
  });
}
function normalizeSettings(input, current = defaultAppointmentSettings()) {
  const settings = { ...current };
  settings.weeklyHours = { ...current.weeklyHours };
  for (const key of DAY_KEYS) {
    const candidate = input.weeklyHours?.[key] || current.weeklyHours[key];
    const closed = Boolean(candidate.closed);
    if (!timeValid(candidate.open) || !timeValid(candidate.close) || candidate.open >= candidate.close) {
      if (!closed) throw new Error(`${DAY_NAMES[key]} opening and closing times must be valid, with closing later than opening.`);
    }
    settings.weeklyHours[key] = { closed, open: timeValid(candidate.open) ? candidate.open : '10:00', close: timeValid(candidate.close) ? candidate.close : '18:00' };
  }
  const slotMinutes = Number(input.slotMinutes);
  if (![15, 30, 45, 60].includes(slotMinutes)) throw new Error('Appointment slot duration must be 15, 30, 45, or 60 minutes.');
  settings.slotMinutes = slotMinutes;
  const capacity = Number(input.maxAppointmentsPerSlot);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new Error('Appointment capacity must be from 1 to 8 per time slot.');
  settings.maxAppointmentsPerSlot = capacity;
  settings.breakStart = input.breakStart || '';
  settings.breakEnd = input.breakEnd || '';
  if ((settings.breakStart && !timeValid(settings.breakStart)) || (settings.breakEnd && !timeValid(settings.breakEnd))) throw new Error('Break times must use a valid 24-hour time, such as 13:00.');
  if (Boolean(settings.breakStart) !== Boolean(settings.breakEnd) || (settings.breakStart && settings.breakStart >= settings.breakEnd)) throw new Error('Enter both break times, with the end later than the start, or leave both blank.');
  settings.minAdvanceHours = Number(input.minAdvanceHours);
  settings.maxAdvanceDays = Number(input.maxAdvanceDays);
  if (!Number.isInteger(settings.minAdvanceHours) || settings.minAdvanceHours < 0 || settings.minAdvanceHours > 168) throw new Error('Minimum booking lead time must be from 0 to 168 hours.');
  if (!Number.isInteger(settings.maxAdvanceDays) || settings.maxAdvanceDays < 1 || settings.maxAdvanceDays > 365) throw new Error('Maximum advance booking period must be from 1 to 365 days.');
  settings.timezone = 'Asia/Kolkata';
  settings.pendingHoldsSlot = true;
  settings.closedDates = Array.isArray(input.closedDates) ? [...new Set(input.closedDates.filter(dateKeyValid))] : [];
  settings.exceptions = Array.isArray(input.exceptions) ? input.exceptions.filter((exception) => dateKeyValid(exception.date) && (exception.closed === true || (timeValid(exception.open) && timeValid(exception.close) && exception.open < exception.close))).slice(0, 365) : [];
  const seen = new Set();
  settings.exceptions = settings.exceptions.filter((exception) => !seen.has(exception.date) && seen.add(exception.date));
  return settings;
}
async function updateAppointmentSettings(input) {
  return mutateAppointments((data) => {
    data.settings = normalizeSettings(input, data.settings);
    return data.settings;
  });
}
function dateSchedule(dateKey, settings) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const dayKey = DAY_KEYS[date.getUTCDay()];
  let schedule = { ...(settings.weeklyHours[dayKey] || { closed: true }) };
  const exception = settings.exceptions.find((item) => item.date === dateKey);
  if (settings.closedDates.includes(dateKey)) return { closed: true, reason: 'The store is closed on this date.' };
  if (exception) {
    if (exception.closed) return { closed: true, reason: 'The store is closed on this date.' };
    schedule = { closed: false, open: exception.open, close: exception.close };
  }
  if (schedule.closed || !timeValid(schedule.open) || !timeValid(schedule.close) || schedule.open >= schedule.close) {
    return { closed: true, reason: `Appointments are not enabled for ${DAY_NAMES[dayKey]}.` };
  }
  return { ...schedule, closed: false };
}
function getAvailableSlotsFromState(dateKey, state, excludeAppointmentId = '') {
  const settings = state.settings;
  if (!dateKeyValid(dateKey)) return { date: dateKey || '', available: false, reason: 'Choose a valid date.', slots: [] };
  const today = indiaDateKey();
  const dateDifference = (Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (dateDifference < 0) return { date: dateKey, available: false, reason: 'Past dates cannot be booked.', slots: [] };
  if (dateDifference > settings.maxAdvanceDays) return { date: dateKey, available: false, reason: `Appointments can be requested up to ${settings.maxAdvanceDays} days in advance.`, slots: [] };
  const schedule = dateSchedule(dateKey, settings);
  if (schedule.closed) return { date: dateKey, available: false, reason: schedule.reason, slots: [] };
  const [openHour, openMinute] = schedule.open.split(':').map(Number);
  const [closeHour, closeMinute] = schedule.close.split(':').map(Number);
  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;
  const now = Date.now();
  const minTime = now + settings.minAdvanceHours * 60 * 60 * 1000;
  const active = state.appointments.filter((item) => item.id !== excludeAppointmentId && item.date === dateKey && ACTIVE_APPOINTMENT_STATUSES.has(item.status));
  const slots = [];
  for (let minute = openMinutes; minute + settings.slotMinutes <= closeMinutes; minute += settings.slotMinutes) {
    const startHour = Math.floor(minute / 60); const startMinute = minute % 60;
    const endMinute = minute + settings.slotMinutes;
    const time = `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`;
    if (settings.breakStart && settings.breakEnd) {
      const [breakStartH, breakStartM] = settings.breakStart.split(':').map(Number);
      const [breakEndH, breakEndM] = settings.breakEnd.split(':').map(Number);
      const breakStart = breakStartH * 60 + breakStartM;
      const breakEnd = breakEndH * 60 + breakEndM;
      if (minute < breakEnd && endMinute > breakStart) continue;
    }
    if (dateTimeInIndia(dateKey, time).getTime() < minTime) continue;
    const booked = active.filter((item) => {
      const [existingHour, existingMinute] = String(item.time || '').split(':').map(Number);
      if (!Number.isFinite(existingHour) || !Number.isFinite(existingMinute)) return false;
      const existingStart = existingHour * 60 + existingMinute;
      const existingDuration = Number(item.durationMinutes || settings.slotMinutes);
      return existingStart < minute + settings.slotMinutes && existingStart + existingDuration > minute;
    }).length;
    if (booked >= settings.maxAppointmentsPerSlot) continue;
    slots.push({ time, label: time, remaining: settings.maxAppointmentsPerSlot - booked });
  }
  return { date: dateKey, available: slots.length > 0, reason: slots.length ? '' : 'No appointment slots are available on this date. Choose another date or contact the store.', slots };
}
async function getAvailableSlots(dateKey, excludeAppointmentId = '') {
  const data = await getAppointmentsData();
  return getAvailableSlotsFromState(dateKey, data, excludeAppointmentId);
}
function makeAppointmentReference(data) {
  const year = indiaDateKey().slice(0, 4);
  data.sequenceByYear[year] = Number(data.sequenceByYear[year] || 0) + 1;
  return `APT-${year}-${String(data.sequenceByYear[year]).padStart(4, '0')}`;
}
function addAppointmentHistory(appointment, status, by, note = '') {
  appointment.statusHistory = Array.isArray(appointment.statusHistory) ? appointment.statusHistory : [];
  appointment.statusHistory.push({ status, at: new Date().toISOString(), by, note: String(note || '').slice(0, 600) });
}
async function createAppointment(input) {
  return mutateAppointments((data) => {
    const date = String(input.date || ''); const time = String(input.time || '');
    if (!dateKeyValid(date) || !timeValid(time)) throw Object.assign(new Error('Choose a valid appointment date and time.'), { code: 'INVALID_DATE_TIME' });
    const slots = getAvailableSlotsFromState(date, data);
    if (!slots.slots.some((slot) => slot.time === time)) throw Object.assign(new Error(slots.reason || 'That time slot is no longer available. Choose another slot.'), { code: 'SLOT_UNAVAILABLE' });
    const year = indiaDateKey().slice(0, 4);
    const appointment = {
      id: makeId('appointment'), reference: makeAppointmentReference(data),
      name: input.name, phone: input.phone, email: input.email || '', contactMethod: input.contactMethod || 'phone',
      service: input.service, occasion: input.occasion || '', style: input.style || '', fabricChoice: input.fabricChoice || '',
      notes: input.notes || '', internalNotes: '', date, time, durationMinutes: data.settings.slotMinutes, requestedDate: date, requestedTime: time,
      status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      reminderSentAt: null, statusHistory: []
    };
    addAppointmentHistory(appointment, 'pending', 'customer', 'Appointment request submitted. Store confirmation is required.');
    data.appointments.unshift(appointment);
    return appointment;
  });
}
async function updateAppointmentStatus(id, nextStatus, adminUsername, internalNotes = null) {
  return mutateAppointments((data) => {
    const appointment = data.appointments.find((item) => item.id === id);
    if (!appointment) throw Object.assign(new Error('Appointment not found.'), { code: 'NOT_FOUND' });
    if (!Object.hasOwn(APPOINTMENT_STATUS_LABELS, nextStatus)) throw Object.assign(new Error('Choose a valid appointment status.'), { code: 'INVALID_STATUS' });
    if (appointment.status !== nextStatus && !APPOINTMENT_TRANSITIONS[appointment.status]?.includes(nextStatus)) {
      throw Object.assign(new Error(`The appointment cannot move from ${APPOINTMENT_STATUS_LABELS[appointment.status] || appointment.status} to ${APPOINTMENT_STATUS_LABELS[nextStatus]}.`), { code: 'INVALID_TRANSITION' });
    }
    const previous = appointment.status;
    if (internalNotes !== null) appointment.internalNotes = String(internalNotes).slice(0, 1500);
    if (previous !== nextStatus) {
      appointment.status = nextStatus;
      addAppointmentHistory(appointment, nextStatus, adminUsername, `Status changed from ${APPOINTMENT_STATUS_LABELS[previous]} to ${APPOINTMENT_STATUS_LABELS[nextStatus]}.`);
    }
    appointment.updatedAt = new Date().toISOString();
    return { appointment, previousStatus: previous };
  });
}
async function rescheduleAppointment(id, date, time, adminUsername, note = '') {
  return mutateAppointments((data) => {
    const appointment = data.appointments.find((item) => item.id === id);
    if (!appointment) throw Object.assign(new Error('Appointment not found.'), { code: 'NOT_FOUND' });
    if (!['pending', 'confirmed', 'reschedule_requested', 'rescheduled'].includes(appointment.status)) throw Object.assign(new Error('Only an active appointment can be rescheduled.'), { code: 'INVALID_TRANSITION' });
    if (!dateKeyValid(date) || !timeValid(time)) throw Object.assign(new Error('Choose a valid new date and time.'), { code: 'INVALID_DATE_TIME' });
    const slots = getAvailableSlotsFromState(date, data, id);
    if (!slots.slots.some((slot) => slot.time === time)) throw Object.assign(new Error(slots.reason || 'That new time is no longer available.'), { code: 'SLOT_UNAVAILABLE' });
    const previous = { date: appointment.date, time: appointment.time };
    appointment.date = date; appointment.time = time; appointment.status = 'rescheduled';
    appointment.updatedAt = new Date().toISOString();
    appointment.rescheduleHistory = Array.isArray(appointment.rescheduleHistory) ? appointment.rescheduleHistory : [];
    appointment.rescheduleHistory.push({ fromDate: previous.date, fromTime: previous.time, toDate: date, toTime: time, at: new Date().toISOString(), by: adminUsername, note: String(note || '').slice(0, 500) });
    addAppointmentHistory(appointment, 'rescheduled', adminUsername, `Rescheduled from ${previous.date} ${previous.time} to ${date} ${time}.${note ? ` ${String(note).slice(0, 350)}` : ''}`);
    return { appointment, previous };
  });
}
async function setAppointmentReminderSent(id) {
  return mutateAppointments((data) => {
    const appointment = data.appointments.find((item) => item.id === id);
    if (!appointment || appointment.reminderSentAt) return false;
    appointment.reminderSentAt = new Date().toISOString();
    appointment.updatedAt = new Date().toISOString();
    return true;
  });
}
function normalizeGarmentStatus(value) { return Object.hasOwn(GARMENT_STATUS_LABELS, value) ? value : ''; }
function makeOrderReference(data) {
  const year = indiaDateKey().slice(0, 4);
  data.sequenceByYear[year] = Number(data.sequenceByYear[year] || 0) + 1;
  return `ORD-${year}-${String(data.sequenceByYear[year]).padStart(4, '0')}`;
}
function addOrderHistory(order, action, by, note = '') {
  order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  order.statusHistory.push({ action, at: new Date().toISOString(), by, note: String(note || '').slice(0, 800) });
}
function getOrderOverallStatus(order) {
  if (order.status === 'cancelled') return 'cancelled';
  const garments = (order.garments || []).filter((garment) => garment.status !== 'cancelled');
  if (!garments.length) return 'cancelled';
  const statuses = garments.map((garment) => garment.status);
  if (statuses.every((status) => status === 'collected')) return 'collected';
  // Do not label the whole order ready while one garment is still being made.
  if (statuses.every((status) => ['ready_for_collection', 'collected'].includes(status))) return 'ready_for_collection';
  // A shared milestone only applies when every outstanding garment has reached it.
  if (statuses.every((status) => ['fitting', 'alterations', 'ready_for_collection', 'collected'].includes(status))) {
    if (statuses.some((status) => status === 'alterations')) return 'alterations';
    if (statuses.some((status) => status === 'fitting')) return 'fitting';
  }
  return 'in_progress';
}
async function createOrder(input, adminUsername) {
  return mutateOrders((data) => {
    const garments = (input.garments || []).filter((item) => item && (item.type || item.description || item.fabricLabel || item.instructions));
    if (!String(input.customerName || '').trim() || String(input.customerName).trim().length < 2) throw Object.assign(new Error('Enter the customer name.'), { code: 'INVALID_INPUT' });
    if (!garments.length) throw Object.assign(new Error('Add at least one garment to the order.'), { code: 'INVALID_INPUT' });
    if (garments.length > 20) throw Object.assign(new Error('An order can contain up to 20 garment entries.'), { code: 'INVALID_INPUT' });
    const normalizedGarments = garments.map((item) => {
      const type = String(item.type || '').trim().slice(0, 60);
      if (!type) throw Object.assign(new Error('Choose a type for each garment.'), { code: 'INVALID_INPUT' });
      const quantity = Number(item.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw Object.assign(new Error('Garment quantity must be between 1 and 100.'), { code: 'INVALID_INPUT' });
      return { id: makeId('garment'), type, description: String(item.description || '').trim().slice(0, 220), quantity,
        fabricLabel: String(item.fabricLabel || '').trim().slice(0, 180), instructions: String(item.instructions || '').trim().slice(0, 1200),
        status: 'order_confirmed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusHistory: [{ status: 'order_confirmed', at: new Date().toISOString(), by: adminUsername, note: 'Garment added to order.' }] };
    });
    const order = {
      id: makeId('order'), reference: makeOrderReference(data), customerName: String(input.customerName).trim().slice(0, 100),
      phone: String(input.phone || '').trim().slice(0, 40), email: String(input.email || '').trim().slice(0, 160),
      orderDate: input.orderDate, expectedCollectionDate: input.expectedCollectionDate || '', notes: String(input.notes || '').trim().slice(0, 2000),
      appointmentId: input.appointmentId || '', enquiryId: input.enquiryId || '', garments: normalizedGarments,
      status: 'active', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusHistory: []
    };
    addOrderHistory(order, 'created', adminUsername, `Order created with ${normalizedGarments.length} garment entry/entries.`);
    data.orders.unshift(order);
    return order;
  });
}
async function updateOrder(id, patch, adminUsername) {
  return mutateOrders((data) => {
    const order = data.orders.find((item) => item.id === id);
    if (!order) throw Object.assign(new Error('Order not found.'), { code: 'NOT_FOUND' });
    if (order.status === 'cancelled') throw Object.assign(new Error('Cancelled orders cannot be edited.'), { code: 'INVALID_TRANSITION' });
    if (patch.expectedCollectionDate && !dateKeyValid(patch.expectedCollectionDate)) throw Object.assign(new Error('Enter a valid expected collection date.'), { code: 'INVALID_INPUT' });
    if (patch.expectedCollectionDate && patch.expectedCollectionDate < indiaDateKey()) throw Object.assign(new Error('Expected collection date cannot be in the past.'), { code: 'INVALID_INPUT' });
    order.expectedCollectionDate = patch.expectedCollectionDate || '';
    order.notes = String(patch.notes || '').trim().slice(0, 2000);
    order.updatedAt = new Date().toISOString();
    addOrderHistory(order, 'details_updated', adminUsername, 'Order notes or expected collection date updated.');
    return order;
  });
}
async function updateGarmentStatus(orderId, garmentId, nextStatus, adminUsername, note = '') {
  return mutateOrders((data) => {
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) throw Object.assign(new Error('Order not found.'), { code: 'NOT_FOUND' });
    if (order.status === 'cancelled') throw Object.assign(new Error('Cancelled orders cannot be changed.'), { code: 'INVALID_TRANSITION' });
    const garment = order.garments.find((item) => item.id === garmentId);
    if (!garment) throw Object.assign(new Error('Garment not found.'), { code: 'NOT_FOUND' });
    if (!normalizeGarmentStatus(nextStatus)) throw Object.assign(new Error('Choose a valid garment status.'), { code: 'INVALID_STATUS' });
    if (garment.status !== nextStatus && !GARMENT_TRANSITIONS[garment.status]?.includes(nextStatus)) {
      throw Object.assign(new Error(`That change is not allowed from ${GARMENT_STATUS_LABELS[garment.status] || garment.status}. Allowed next stages: ${(GARMENT_TRANSITIONS[garment.status] || []).map((item) => GARMENT_STATUS_LABELS[item]).join(', ') || 'none'}.`), { code: 'INVALID_TRANSITION' });
    }
    const previous = garment.status;
    if (previous !== nextStatus) {
      garment.status = nextStatus; garment.updatedAt = new Date().toISOString();
      garment.statusHistory = Array.isArray(garment.statusHistory) ? garment.statusHistory : [];
      garment.statusHistory.push({ status: nextStatus, at: new Date().toISOString(), by: adminUsername, note: String(note || '').slice(0, 800) });
      addOrderHistory(order, 'garment_status_changed', adminUsername, `${garment.type}: ${GARMENT_STATUS_LABELS[previous]} → ${GARMENT_STATUS_LABELS[nextStatus]}.${note ? ` ${String(note).slice(0, 500)}` : ''}`);
    }
    order.updatedAt = new Date().toISOString();
    return { order, garment, previousStatus: previous, overallStatus: getOrderOverallStatus(order) };
  });
}
async function cancelOrder(id, adminUsername, note = '') {
  return mutateOrders((data) => {
    const order = data.orders.find((item) => item.id === id);
    if (!order) throw Object.assign(new Error('Order not found.'), { code: 'NOT_FOUND' });
    if (order.garments.some((garment) => garment.status === 'collected')) throw Object.assign(new Error('An order containing collected garments cannot be cancelled wholesale. Update the remaining garments individually.'), { code: 'INVALID_TRANSITION' });
    if (order.status === 'cancelled') return order;
    order.status = 'cancelled'; order.updatedAt = new Date().toISOString();
    for (const garment of order.garments) {
      if (garment.status !== 'collected' && garment.status !== 'cancelled') {
        const previous = garment.status; garment.status = 'cancelled'; garment.updatedAt = new Date().toISOString();
        garment.statusHistory.push({ status: 'cancelled', at: new Date().toISOString(), by: adminUsername, note: `Order cancelled from ${GARMENT_STATUS_LABELS[previous]}.` });
      }
    }
    addOrderHistory(order, 'cancelled', adminUsername, String(note || 'Order cancelled by administrator.').slice(0, 800));
    return order;
  });
}
async function archiveOrder(id, archived, adminUsername) {
  return mutateOrders((data) => {
    const order = data.orders.find((item) => item.id === id);
    if (!order) throw Object.assign(new Error('Order not found.'), { code: 'NOT_FOUND' });
    const status = getOrderOverallStatus(order);
    if (archived && !['collected', 'cancelled'].includes(status)) throw Object.assign(new Error('Only completed or cancelled orders can be archived.'), { code: 'INVALID_TRANSITION' });
    order.archived = Boolean(archived); order.updatedAt = new Date().toISOString();
    addOrderHistory(order, archived ? 'archived' : 'restored', adminUsername, archived ? 'Order archived from the active list.' : 'Order restored to the active list.');
    return order;
  });
}

module.exports = {
  ROOT, DATA_DIR, APPOINTMENTS_FILE, ORDERS_FILE, DAY_KEYS, DAY_NAMES, ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABELS, APPOINTMENT_TRANSITIONS, GARMENT_STATUS_LABELS, GARMENT_TRANSITIONS,
  makeId, dateKeyValid, timeValid, indiaDateKey, dateTimeInIndia,
  defaultAppointmentSettings, ensureOperationsFiles, getAppointmentsData, getOrdersData,
  updateAppointmentSettings, getAvailableSlots, getAvailableSlotsFromState, createAppointment,
  updateAppointmentStatus, rescheduleAppointment, setAppointmentReminderSent,
  createOrder, updateOrder, updateGarmentStatus, cancelOrder, archiveOrder, getOrderOverallStatus
};
