require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const FileSessionStore = require('./lib/file-session-store');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { rateLimit } = require('express-rate-limit');
const {
  STOCK_IMAGES,
  makeId,
  ensureDataFiles,
  getData,
  updateData,
  getAdmin,
  DATA_DIR
} = require('./lib/store');
const operations = require('./lib/operations-store');
const { sendEmail, adminRecipient, isConfigured: emailNotificationsConfigured } = require('./lib/notifications');
const { verifyPreviewPassword, isValidPreviewPasswordHash } = require('./lib/preview-auth');

const app = express();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = process.env.MENSWEAR_UPLOAD_DIR ? path.resolve(process.env.MENSWEAR_UPLOAD_DIR) : path.join(PROJECT_ROOT, 'frontend', 'public', 'uploads');
const PREVIEW_GATE_ENABLED = process.env.PREVIEW_GATE_ENABLED === 'true';
const ALLOW_PUBLIC_PRODUCTION = process.env.ALLOW_PUBLIC_PRODUCTION === 'true';

const configuredSecret = process.env.SESSION_SECRET || '';
if (IS_PRODUCTION && (configuredSecret.length < 32 || configuredSecret.includes('REPLACE_WITH'))) {
  console.error('SESSION_SECRET must be a unique random value of at least 32 characters in production.');
  process.exit(1);
}
if (IS_PRODUCTION && !PREVIEW_GATE_ENABLED && !ALLOW_PUBLIC_PRODUCTION) {
  console.error('Production startup blocked: set PREVIEW_GATE_ENABLED=true for private preview. To intentionally launch public later, explicitly set PREVIEW_GATE_ENABLED=false and ALLOW_PUBLIC_PRODUCTION=true.');
  process.exit(1);
}
if (PREVIEW_GATE_ENABLED && !isValidPreviewPasswordHash(process.env.PREVIEW_PASSWORD_HASH || '')) {
  console.error('PREVIEW_GATE_ENABLED=true requires a valid PREVIEW_PASSWORD_HASH. Generate it with npm --prefix backend run preview:hash.');
  process.exit(1);
}
const sessionSecret = configuredSecret.length >= 32 && !configuredSecret.includes('REPLACE_WITH')
  ? configuredSecret
  : crypto.randomBytes(48).toString('hex');
if (!IS_PRODUCTION && (!configuredSecret || configuredSecret.includes('REPLACE_WITH'))) {
  console.warn('Development session secret generated for this run. Set SESSION_SECRET in .env to keep sessions stable between restarts.');
}

app.disable('x-powered-by');
app.set('trust proxy', IS_PRODUCTION ? 1 : false);
app.set('view engine', 'ejs');
app.set('views', path.join(PROJECT_ROOT, 'frontend', 'views'));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["'self'", 'https://www.google.com', 'https://maps.google.com']
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.urlencoded({ extended: false, limit: '40kb' }));
app.use(express.json({ limit: '40kb' }));
app.use(session({
  name: 'menswear.sid',
  store: new FileSessionStore({ directory: path.join(DATA_DIR, 'sessions') }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// Minimal infrastructure endpoints intentionally contain no business data.
app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.status(200).type('text/plain').send('ok');
});
app.get('/robots.txt', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.settings = { businessName: 'YOUR STORE NAME', tagline: "MEN'S FABRICS · TAILORING · SUITING", intro: '' };
  res.locals.imageFor = imageFor;
  res.locals.whatsappUrl = whatsappUrl;
  res.locals.phoneDigits = phoneDigits;
  res.locals.directionsUrl = directionsUrl;
  res.locals.stockImages = STOCK_IMAGES;
  res.locals.previewGateEnabled = PREVIEW_GATE_ENABLED;
  res.locals.previewAuthorized = req.session?.previewAuthorized === true;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// URL-encoded forms are checked centrally. Multipart forms are checked immediately after Multer parses them.
function verifyCsrf(req, res, next) {
  const supplied = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
  const expected = typeof req.session?.csrfToken === 'string' ? req.session.csrfToken : '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  const valid = suppliedBuffer.length === expectedBuffer.length && suppliedBuffer.length > 0 && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (valid) return next();
  if (req.file?.filename) fs.unlink(path.join(UPLOAD_DIR, req.file.filename)).catch(() => {});
  return res.status(403).render('error', {
    pageTitle: 'Request expired',
    statusCode: 403,
    message: 'This form expired or could not be verified. Please go back, refresh the page, and try again.'
  });
}
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
});

const previewLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Unable to authenticate this preview request. Wait a while and try again.'
});

function safePreviewReturnTo(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://preview.invalid');
    if (parsed.origin !== 'https://preview.invalid') return '/';
    if (parsed.pathname === '/_preview' || parsed.pathname.startsWith('/_preview/')) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function setPreviewPrivateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.vary('Cookie');
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

app.get('/_preview/gate.js', (_req, res) => {
  setPreviewPrivateHeaders(res);
  res.type('application/javascript').send(`document.addEventListener('DOMContentLoaded',function(){const input=document.getElementById('preview-password');const toggle=document.getElementById('toggle-password');const form=document.getElementById('preview-form');const submit=document.getElementById('preview-submit');if(toggle&&input){toggle.addEventListener('click',function(){const hidden=input.type==='password';input.type=hidden?'text':'password';toggle.setAttribute('aria-pressed',String(hidden));toggle.textContent=hidden?'Hide':'Show';input.focus();});}if(form&&submit){form.addEventListener('submit',function(){submit.disabled=true;submit.textContent='Checking access…';});}});`);
});

app.get('/_preview', (req, res) => {
  setPreviewPrivateHeaders(res);
  if (!PREVIEW_GATE_ENABLED) return res.status(404).type('text/plain').send('Preview gate is not enabled in this environment.');
  const returnTo = safePreviewReturnTo(req.query.returnTo);
  if (req.session?.previewAuthorized === true) return res.redirect(302, returnTo);
  return res.status(200).render('preview-login', {
    pageTitle: 'Private Website Preview',
    csrfToken: res.locals.csrfToken,
    returnTo,
    errorMessage: ''
  });
});

app.post('/_preview/login', previewLoginLimiter, async (req, res, next) => {
  setPreviewPrivateHeaders(res);
  if (!PREVIEW_GATE_ENABLED) return res.status(404).type('text/plain').send('Preview gate is not enabled in this environment.');
  try {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const returnTo = safePreviewReturnTo(req.body.returnTo);
    const matches = await verifyPreviewPassword(password, process.env.PREVIEW_PASSWORD_HASH || '');
    if (!matches) {
      return res.status(401).render('preview-login', {
        pageTitle: 'Private Website Preview',
        csrfToken: req.session.csrfToken,
        returnTo,
        errorMessage: 'The password was not accepted. Check it and try again.'
      });
    }
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.previewAuthorized = true;
    req.session.previewAuthenticatedAt = Date.now();
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await saveSession(req);
    return res.redirect(303, returnTo);
  } catch (error) {
    return next(error);
  }
});

app.post('/_preview/logout', (req, res, next) => {
  setPreviewPrivateHeaders(res);
  if (!PREVIEW_GATE_ENABLED) return res.status(404).type('text/plain').send('Preview gate is not enabled in this environment.');
  if (req.session?.previewAuthorized !== true) return res.redirect(302, '/_preview');
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('menswear.sid', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION });
    return res.redirect(303, '/_preview');
  });
});

// This gate runs before all static files, page routes, image URLs, APIs, and the sitemap.
// Only the password screen, its tiny script, robots.txt, and a content-free health check are exempt.
app.use((req, res, next) => {
  if (!PREVIEW_GATE_ENABLED) return next();
  setPreviewPrivateHeaders(res);
  const exempt = req.path === '/healthz' || req.path === '/robots.txt' ||
    req.path === '/_preview' || req.path === '/_preview/login' ||
    req.path === '/_preview/logout' || req.path === '/_preview/gate.js';
  if (exempt) return next();
  const authenticatedAt = Number(req.session?.previewAuthenticatedAt || 0);
  const sessionIsCurrent = req.session?.previewAuthorized === true && authenticatedAt > 0 && (Date.now() - authenticatedAt) < (8 * 60 * 60 * 1000);
  if (sessionIsCurrent) return next();
  if (req.session?.previewAuthorized) {
    delete req.session.previewAuthorized;
    delete req.session.previewAuthenticatedAt;
  }
  const returnTo = safePreviewReturnTo(req.originalUrl);
  return res.redirect(302, `/_preview?returnTo=${encodeURIComponent(returnTo)}`);
});

// Serve application assets only after the server-side preview gate checks authorisation.
app.use(express.static(path.join(PROJECT_ROOT, 'frontend', 'public'), {
  index: false,
  maxAge: PREVIEW_GATE_ENABLED ? 0 : (IS_PRODUCTION ? '1d' : 0),
  setHeaders(res, filePath) {
    if (PREVIEW_GATE_ENABLED) {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', IS_PRODUCTION ? 'public, max-age=86400' : 'no-cache');
    }
  }
}));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  maxAge: PREVIEW_GATE_ENABLED ? 0 : (IS_PRODUCTION ? '1d' : 0),
  setHeaders(res) {
    if (PREVIEW_GATE_ENABLED) {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
  }
}));


const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const extensionByMime = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/avif': '.avif'
    };
    const extension = extensionByMime[file.mimetype];
    callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension || '.img'}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
    if (!allowed.includes(file.mimetype)) return callback(new Error('Upload a JPG, PNG, WEBP, or AVIF image. SVG and other file types are not allowed.'));
    callback(null, true);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait 15 minutes and try again.'
});
const enquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many enquiries have been submitted from this connection. Please try again later.'
});

const SUITING_OCCASIONS = Object.freeze([
  'Wedding & celebrations',
  'Business & formal',
  'Formal event',
  'Personal celebration'
]);
const SUITING_STYLES = Object.freeze([
  'Classic & timeless',
  'Contemporary & streamlined',
  'Three-piece inspiration',
  'Help me decide in store'
]);
const SUITING_TIME_PREFERENCES = Object.freeze(['Morning', 'Afternoon', 'Evening', 'Flexible']);
const APPOINTMENT_SERVICES = Object.freeze(['Suiting consultation', 'Custom suit', 'Custom shirt', 'Custom trousers', "Men's Jabbha", 'Other tailoring enquiry']);
const GARMENT_TYPES = Object.freeze(['Custom suit', 'Shirt', 'Trousers / pants', "Men's Jabbha", 'Other garment']);
const APPOINTMENT_STATUS_OPTIONS = operations.APPOINTMENT_STATUS_LABELS;
const GARMENT_STATUS_OPTIONS = operations.GARMENT_STATUS_LABELS;
const DAY_KEYS = operations.DAY_KEYS;
const DAY_NAMES = operations.DAY_NAMES;

function clean(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}
function slugify(value) {
  return clean(value, 100).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function isValidHttpsUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : '';
  } catch {
    return '';
  }
}
function isLocalUpload(image) {
  return typeof image === 'string' && image.startsWith('/uploads/') && !image.includes('..');
}
async function removeImage(image) {
  if (!isLocalUpload(image)) return;
  const basename = path.basename(image);
  await fs.unlink(path.join(UPLOAD_DIR, basename)).catch(() => {});
}
function imageFor(entity) {
  return (entity && entity.image) || (entity && entity.imageUrl) || '';
}
function phoneDigits(value) {
  return clean(value, 40).replace(/[^0-9+]/g, '');
}
function whatsappUrl(value) {
  const digits = clean(value, 40).replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : '';
}
function directionsUrl(settings) {
  if (settings.mapUrl) return isValidHttpsUrl(settings.mapUrl);
  if (settings.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(settings.address)}`;
  return '';
}
function resolveFabricChoice(value, siteData) {
  if (!value) return { value: '', label: '' };
  if (value === 'help') return { value: 'help', label: 'Would like help choosing in person' };
  const suiting = getSuitingOptions(siteData);
  if (value.startsWith('category:')) {
    const category = suiting.categories.find((item) => item.id === value.slice('category:'.length));
    return category ? { value, label: `Explore category: ${category.name}` } : null;
  }
  if (value.startsWith('collection:')) {
    const collection = suiting.collections.find((item) => item.id === value.slice('collection:'.length));
    if (!collection) return null;
    const category = suiting.categories.find((item) => item.id === collection.categoryId);
    return { value, label: category ? `${collection.title} (${category.name})` : collection.title };
  }
  return null;
}
function parseExceptionLines(value) {
  const output = [];
  for (const rawLine of String(value || '').split(/\r?\n/).slice(0, 365)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length === 2 && parts[1].toLowerCase() === 'closed' && operations.dateKeyValid(parts[0])) {
      output.push({ date: parts[0], closed: true });
    } else if (parts.length === 3 && operations.dateKeyValid(parts[0]) && operations.timeValid(parts[1]) && operations.timeValid(parts[2]) && parts[1] < parts[2]) {
      output.push({ date: parts[0], closed: false, open: parts[1], close: parts[2] });
    } else {
      throw new Error(`Invalid exception line: "${line}". Use YYYY-MM-DD,closed or YYYY-MM-DD,HH:MM,HH:MM.`);
    }
  }
  return output;
}
function appointmentEmailText(appointment, statusLabel = '') {
  return [
    `Appointment reference: ${appointment.reference}`,
    `Customer: ${appointment.name}`,
    `Service: ${appointment.service}`,
    `Date: ${appointment.date}`,
    `Time: ${appointment.time} (Asia/Kolkata)`,
    statusLabel ? `Status: ${statusLabel}` : `Status: ${operations.APPOINTMENT_STATUS_LABELS[appointment.status] || appointment.status}`,
    appointment.occasion ? `Occasion: ${appointment.occasion}` : '',
    appointment.style ? `Style: ${appointment.style}` : '',
    appointment.fabricLabel ? `Fabric preference: ${appointment.fabricLabel}` : '',
    appointment.notes ? `Customer notes: ${appointment.notes}` : '',
    '',
    'This message contains appointment information for the Premium Menswear store.'
  ].filter(Boolean).join('\n');
}
async function notifyNewAppointment(appointment, settings) {
  const to = adminRecipient(settings);
  if (!to) return { sent: false, skipped: true, reason: 'Set NOTIFICATION_EMAIL_TO or the business email to receive appointment alerts.' };
  return sendEmail({ to, subject: `New appointment request: ${appointment.reference}`, text: appointmentEmailText(appointment, 'Pending store confirmation') });
}
async function notifyCustomerAppointment(appointment, statusLabel) {
  if (!appointment.email) return { sent: false, skipped: true, reason: 'The customer did not provide an email address.' };
  return sendEmail({ to: appointment.email, subject: `Appointment ${statusLabel.toLowerCase()}: ${appointment.reference}`, text: appointmentEmailText(appointment, statusLabel) });
}
function sortAppointments(items) {
  return [...items].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}
function appointmentStatusClass(status) {
  if (['confirmed', 'rescheduled', 'completed'].includes(status)) return 'status-live';
  if (['pending', 'reschedule_requested'].includes(status)) return 'status-new';
  return 'status-draft';
}
function orderStatusLabel(order) {
  if (order.status === 'cancelled') return 'Cancelled';
  const status = operations.getOrderOverallStatus(order);
  return ({ in_progress: 'In progress', fitting: 'Fitting', alterations: 'Alterations / finishing', ready_for_collection: 'Ready for collection', collected: 'Collected', cancelled: 'Cancelled' })[status] || status;
}
function todayDateKey() { return operations.indiaDateKey(); }
function dateKeyPlusDays(dateKey, days) { const date = new Date(`${dateKey}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + Number(days || 0)); return date.toISOString().slice(0, 10); }
function getSuitingOptions(siteData) {
  const categories = (siteData.categories || [])
    .filter((category) => /suit/i.test(`${category.name || ''} ${category.slug || ''}`))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const categoryIds = new Set(categories.map((category) => category.id));
  const collections = (siteData.collections || [])
    .filter((item) => item.published !== false && categoryIds.has(item.categoryId))
    .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { categories, collections };
}
function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function indiaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const STORE_STATUS_OPTIONS = Object.freeze({
  open_as_usual: 'Open as usual',
  open_changed_hours: 'Open with changed hours',
  closed_today: 'Closed today',
  call_to_confirm: 'Call to confirm'
});

function parseStoreExceptions(value) {
  const rows = [];
  const seenDates = new Set();
  const statuses = new Set(Object.keys(STORE_STATUS_OPTIONS));
  const rawLines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rawLines.length > 100) throw new Error('Enter no more than 100 store-date exceptions.');
  for (const line of rawLines) {
    const [date, status, specialHours = '', note = ''] = line.split('|').map((part) => part.trim());
    if (!isValidDateKey(date) || !statuses.has(status)) {
      throw new Error(`Invalid store exception: "${line}". Use YYYY-MM-DD|status|special hours|public note. Status must be one of: ${[...statuses].join(', ')}.`);
    }
    if (seenDates.has(date)) throw new Error(`Only one store exception is allowed for ${date}.`);
    seenDates.add(date);
    rows.push({ date, status, specialHours: clean(specialHours, 160), note: clean(note, 300) });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function getPublicStoreStatus(settings = {}) {
  const today = indiaDateKey();
  const exceptions = Array.isArray(settings.storeExceptions) ? settings.storeExceptions : [];
  const exception = exceptions.find((item) => item.date === today);
  const dailyIsCurrent = settings.dailyStoreStatusDate === today;
  const status = exception?.status || (dailyIsCurrent ? settings.dailyStoreStatus : 'call_to_confirm') || 'call_to_confirm';
  const note = exception ? exception.note : (dailyIsCurrent ? settings.dailyStoreStatusNote : '');
  const specialHours = exception ? exception.specialHours : (dailyIsCurrent ? settings.dailyStoreSpecialHours : '');
  const updatedAt = exception ? (exception.updatedAt || '') : (dailyIsCurrent ? settings.dailyStoreStatusUpdatedAt : '');
  const statusText = STORE_STATUS_OPTIONS[status] || STORE_STATUS_OPTIONS.call_to_confirm;
  const messages = {
    open_as_usual: 'The store status has been marked as open as usual for today. Call ahead to reconfirm before travelling and to check your preferred fabric.',
    open_changed_hours: 'The store has published changed hours for today. Please call to confirm the timing that works for your visit.',
    closed_today: 'The store has been marked closed for today. Please call if you need to confirm reopening information or discuss another day.',
    call_to_confirm: 'Today’s live store status has not been confirmed online. Please call before travelling to check opening hours and fabric availability.'
  };
  return { date: today, status, label: statusText, note, specialHours, updatedAt, message: messages[status] || messages.call_to_confirm, isCurrent: Boolean(exception || dailyIsCurrent) };
}

function storeExceptionsToText(items) {
  return (Array.isArray(items) ? items : []).map((item) => [item.date, item.status, item.specialHours || '', item.note || ''].join(' | ')).join('\n');
}
function flashRedirect(req, res, kind, message, location = '/admin') {
  req.session.flash = { kind, message };
  return res.redirect(location);
}
function requireAdmin(req, res, next) {
  if (req.session?.adminUsername) return next();
  return res.redirect('/admin/login');
}
function renderPublic(req, res, view, title, data = {}) {
  return res.render(view, {
    ...data,
    pageTitle: title,
    settings: req.siteData.settings,
    storeStatus: getPublicStoreStatus(req.siteData.settings),
    categories: data.categories || req.siteData.categories,
    activePage: data.activePage || '',
    flash: res.locals.flash,
    csrfToken: res.locals.csrfToken,
    imageFor,
    whatsappUrl,
    phoneDigits,
    directionsUrl,
    stockImages: STOCK_IMAGES
  });
}

// Cache the latest content snapshot on the request for template rendering.
app.use(async (req, res, next) => {
  try {
    req.siteData = await getData();
    res.locals.settings = req.siteData.settings;
    next();
  } catch (error) {
    next(error);
  }
});

// Public pages
app.get('/', (req, res) => {
  const activeAnnouncements = req.siteData.announcements.filter((item) => item.active).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const publishedTestimonials = req.siteData.testimonials.filter((item) => item.published && item.permissionConfirmed);
  renderPublic(req, res, 'home', 'Premium Men’s Fabrics & Tailoring', { pageDescription: 'Explore premium men’s fabrics, suiting and personalised tailoring. Call ahead to check store hours and current fabric availability.' ,
    activePage: 'home',
    categories: [...req.siteData.categories].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    collectionHighlights: [...req.siteData.collections].filter((item) => item.published !== false && item.featured).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 3),
    galleryHighlights: [...req.siteData.gallery].filter((item) => item.published !== false).sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 3),
    announcements: activeAnnouncements,
    testimonials: publishedTestimonials
  });
});
app.get('/about', (req, res) => renderPublic(req, res, 'about', 'About Us', { pageDescription: 'Learn about our focus on men’s fabrics, suiting and custom tailoring.', activePage: 'about' }));
app.get('/collections', (req, res) => {
  const selected = clean(req.query.category, 100);
  const chosenCategory = req.siteData.categories.find((category) => category.id === selected || category.slug === selected) || null;
  const items = [...req.siteData.collections].filter((item) => item.published !== false).sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderPublic(req, res, 'collections', 'Fabrics & Collections', { pageDescription: 'Browse men’s suiting, shirting, linen and other fabric collections. Call before travelling to confirm current availability.',
    activePage: 'collections',
    collections: items,
    selectedCategory: chosenCategory,
    categories: req.siteData.categories
  });
});
app.get('/tailoring', (req, res) => renderPublic(req, res, 'tailoring', 'Custom Tailoring', { pageDescription: 'Explore custom shirts, trousers, men’s Jabbha and suiting. Contact the store to discuss available services.', activePage: 'tailoring' }));
app.get('/suiting', (req, res) => {
  const { categories: suitingCategories, collections: suitingCollections } = getSuitingOptions(req.siteData);
  renderPublic(req, res, 'suiting', 'Suiting & Custom Suits', { pageDescription: 'Explore suiting fabric inspiration and custom tailoring. Call the store to confirm availability before visiting.',
    activePage: 'suiting',
    suitingCategories,
    suitingCollections
  });
});
app.get('/gallery', (req, res) => renderPublic(req, res, 'gallery', 'The Gallery', { pageDescription: 'Explore gallery photographs of fabrics, suiting and tailoring details.',
  activePage: 'gallery',
  gallery: [...req.siteData.gallery].filter((item) => item.published !== false).sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || (b.createdAt || '').localeCompare(a.createdAt || '')),
  categories: req.siteData.categories
}));
app.get('/contact', (req, res) => renderPublic(req, res, 'contact', 'Visit Our Store', { pageDescription: 'Find our store, check opening hours, call to confirm fabric availability, and get directions.', activePage: 'contact', querySent: clean(req.query.sent, 1) }));

// Public appointment booking is intentionally paused for Version 3.1. Existing
// appointment records and administrator management remain intact.
app.get('/appointments', (_req, res) => res.redirect(302, '/contact?from=appointments'));

app.get('/api/appointment-availability', async (req, res, next) => {
  try {
    const date = clean(req.query.date, 10);
    if (!operations.dateKeyValid(date)) return res.status(400).json({ date, available: false, reason: 'Choose a valid date.', slots: [] });
    const result = await operations.getAvailableSlots(date);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) { next(error); }
});

// New public appointment submissions are paused in Version 3.1.
// Existing records remain available to authorised administrators.
app.post('/appointments', (_req, res) => res.redirect(303, '/contact?from=appointments'));

app.post('/enquiries', enquiryLimiter, async (req, res, next) => {
  try {
    // Honeypot field is hidden from real users; quietly ignore simple bots without claiming success.
    if (clean(req.body.website, 200)) return res.redirect('/contact?sent=0');
    const name = clean(req.body.name, 100);
    const phone = clean(req.body.phone, 40);
    const email = clean(req.body.email, 160);
    const subject = clean(req.body.subject, 120);
    const message = clean(req.body.message, 2000);
    const errors = [];
    if (name.length < 2) errors.push('Enter your name.');
    if (phone.replace(/\D/g, '').length < 7) errors.push('Enter a valid phone number.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address or leave that field blank.');
    if (message.length < 10) errors.push('Please add a message of at least 10 characters.');
    if (errors.length) {
      req.session.flash = { kind: 'error', message: errors.join(' ') };
      return res.redirect('/contact#contact-form');
    }
    await updateData((data) => {
      data.enquiries.unshift({
        id: makeId('enquiry'), name, phone, email, subject, message,
        status: 'new', createdAt: new Date().toISOString(), read: false
      });
      data.enquiries = data.enquiries.slice(0, 500);
    });
    return res.redirect('/contact?sent=1#contact-form');
  } catch (error) {
    next(error);
  }
});

// Admin authentication
app.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin/login', (req, res) => {
  if (req.session.adminUsername) return res.redirect('/admin/dashboard');
  res.render('admin-login', {
    pageTitle: 'Administrator Login',
    settings: req.siteData.settings,
    csrfToken: res.locals.csrfToken,
    flash: res.locals.flash,
    needsSetup: false
  });
});
app.post('/admin/login', loginLimiter, async (req, res, next) => {
  try {
    const username = clean(req.body.username, 40);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const admin = await getAdmin();
    if (!admin) {
      return res.status(503).render('admin-login', {
        pageTitle: 'Administrator Login', settings: req.siteData.settings,
        csrfToken: res.locals.csrfToken, flash: { kind: 'error', message: 'Admin setup is incomplete. Run npm run admin:create in the project folder, then return here.' },
        needsSetup: true
      });
    }
    const matches = username === admin.username && password.length <= 200 && await bcrypt.compare(password, admin.passwordHash);
    if (!matches) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      req.session.flash = { kind: 'error', message: 'Username or password is incorrect.' };
      return res.redirect('/admin/login');
    }
    const previewWasAuthorized = req.session.previewAuthorized === true;
    const previewAuthenticatedAt = req.session.previewAuthenticatedAt;
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.adminUsername = admin.username;
    if (previewWasAuthorized && Number(previewAuthenticatedAt) > 0) {
      req.session.previewAuthorized = true;
      req.session.previewAuthenticatedAt = previewAuthenticatedAt;
    }
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return res.redirect('/admin/dashboard');
  } catch (error) {
    next(error);
  }
});
app.post('/admin/logout', requireAdmin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('menswear.sid');
    res.redirect('/admin/login');
  });
});

// Dashboard shows every content collection so day-to-day updates do not require editing source code.
app.get('/admin/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const data = req.siteData;
    const [appointmentData, orderData] = await Promise.all([operations.getAppointmentsData(), operations.getOrdersData()]);
    const appointments = sortAppointments(appointmentData.appointments);
    const orders = [...orderData.orders].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const selectedAppointment = appointments.find((item) => item.id === clean(req.query.fromAppointment, 100)) || null;
    const selectedEnquiry = data.enquiries.find((item) => item.id === clean(req.query.fromEnquiry, 100)) || null;
    const orderPrefill = selectedAppointment ? {
      appointmentId: selectedAppointment.id, enquiryId: '', customerName: selectedAppointment.name, phone: selectedAppointment.phone,
      email: selectedAppointment.email || '', notes: `From appointment ${selectedAppointment.reference}. ${selectedAppointment.service}. ${selectedAppointment.notes || ''}`.trim()
    } : selectedEnquiry ? {
      appointmentId: '', enquiryId: selectedEnquiry.id, customerName: selectedEnquiry.name, phone: selectedEnquiry.phone,
      email: selectedEnquiry.email || '', notes: `From enquiry ${selectedEnquiry.subject || selectedEnquiry.id}. ${selectedEnquiry.message || ''}`.slice(0, 2000)
    } : { appointmentId: '', enquiryId: '', customerName: '', phone: '', email: '', notes: '' };
    res.render('admin-dashboard', {
      pageTitle: 'Content Dashboard', settings: data.settings,
      categories: data.categories, collections: data.collections, gallery: data.gallery,
      announcements: data.announcements, testimonials: data.testimonials,
      enquiries: data.enquiries, appointments, appointmentSettings: appointmentData.settings, orders,
      activeAppointments: appointments.filter((item) => operations.ACTIVE_APPOINTMENT_STATUSES ? operations.ACTIVE_APPOINTMENT_STATUSES.has(item.status) : ['pending', 'confirmed', 'rescheduled', 'reschedule_requested'].includes(item.status)),
      archivedOrders: orders.filter((order) => order.archived), orderPrefill,
      appointmentStatusLabels: APPOINTMENT_STATUS_OPTIONS, garmentStatusLabels: GARMENT_STATUS_OPTIONS,
      appointmentTransitions: operations.APPOINTMENT_TRANSITIONS, garmentStatusTransitions: operations.GARMENT_TRANSITIONS,
      getOrderOverallStatusForTemplate: operations.getOrderOverallStatus, orderStatusLabel,
      appointmentServices: APPOINTMENT_SERVICES, garmentTypes: GARMENT_TYPES,
      dayKeys: DAY_KEYS, dayNames: DAY_NAMES, todayKey: todayDateKey(),
      storeStatusOptions: STORE_STATUS_OPTIONS, storeExceptionsText: storeExceptionsToText(data.settings.storeExceptions),
      csrfToken: res.locals.csrfToken,
      flash: res.locals.flash, adminUsername: req.session.adminUsername,
      imageFor, stockImages: STOCK_IMAGES, emailNotificationsConfigured: emailNotificationsConfigured(data.settings.email)
    });
  } catch (error) { next(error); }
});

// Store settings and homepage hero
app.post('/admin/settings', requireAdmin, upload.single('heroImage'), verifyCsrf, async (req, res, next) => {
  try {
    const body = req.body;
    let storeExceptions;
    try {
      storeExceptions = parseStoreExceptions(clean(body.storeExceptionsText, 20000));
    } catch (validationError) {
      if (req.file) await removeImage(`/uploads/${req.file.filename}`);
      return flashRedirect(req, res, 'error', validationError.message, '/admin/dashboard#store-settings');
    }
    const allowedStoreStatuses = new Set(Object.keys(STORE_STATUS_OPTIONS));
    const dailyStoreStatus = allowedStoreStatuses.has(clean(body.dailyStoreStatus, 40)) ? clean(body.dailyStoreStatus, 40) : 'call_to_confirm';
    const dailyStoreStatusDate = isValidDateKey(clean(body.dailyStoreStatusDate, 10)) ? clean(body.dailyStoreStatusDate, 10) : todayDateKey();
    let priorHero = '';
    const shouldRemoveHero = body.removeHeroImage === 'on';
    await updateData(async (data) => {
      priorHero = data.settings.heroImage;
      const s = data.settings;
      const previousExceptions = Array.isArray(s.storeExceptions) ? s.storeExceptions : [];
      const exceptionTimestamp = new Date().toISOString();
      storeExceptions = storeExceptions.map((item) => {
        const previous = previousExceptions.find((candidate) => candidate.date === item.date);
        const unchanged = previous && previous.status === item.status && previous.specialHours === item.specialHours && previous.note === item.note;
        return { ...item, updatedAt: unchanged ? (previous.updatedAt || exceptionTimestamp) : exceptionTimestamp };
      });
      s.businessName = clean(body.businessName, 100) || 'YOUR STORE NAME';
      s.tagline = clean(body.tagline, 150);
      s.intro = clean(body.intro, 500);
      s.heroHeadline = clean(body.heroHeadline, 150) || 'Elegance, tailored to you.';
      s.heroSubheadline = clean(body.heroSubheadline, 400);
      s.phone = clean(body.phone, 40);
      s.whatsapp = clean(body.whatsapp, 40);
      s.email = clean(body.email, 160);
      s.address = clean(body.address, 300);
      s.openingHours = clean(body.openingHours, 300);
      s.dailyStoreStatus = dailyStoreStatus;
      s.dailyStoreStatusDate = dailyStoreStatusDate;
      s.dailyStoreStatusNote = clean(body.dailyStoreStatusNote, 300);
      s.dailyStoreSpecialHours = clean(body.dailyStoreSpecialHours, 160);
      s.dailyStoreStatusUpdatedAt = new Date().toISOString();
      s.storeExceptions = storeExceptions;
      s.mapUrl = isValidHttpsUrl(clean(body.mapUrl, 500));
      s.mapEmbedUrl = isValidHttpsUrl(clean(body.mapEmbedUrl, 700));
      s.instagramUrl = isValidHttpsUrl(clean(body.instagramUrl, 300));
      s.facebookUrl = isValidHttpsUrl(clean(body.facebookUrl, 300));
      s.announcementBar = clean(body.announcementBar, 220);
      s.announcementBarActive = body.announcementBarActive === 'on';
      s.heroImageUrl = isValidHttpsUrl(clean(body.heroImageUrl, 700)) || STOCK_IMAGES.hero;
      if (req.file) s.heroImage = `/uploads/${req.file.filename}`;
      else if (shouldRemoveHero) s.heroImage = '';
    });
    if ((req.file || shouldRemoveHero) && priorHero) await removeImage(priorHero);
    return flashRedirect(req, res, 'success', 'Store details and homepage settings saved.');
  } catch (error) { next(error); }
});

// Category management
app.post('/admin/categories', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 100);
    if (name.length < 2) {
      if (req.file) await removeImage(`/uploads/${req.file.filename}`);
      return flashRedirect(req, res, 'error', 'Category name must contain at least 2 characters.');
    }
    await updateData((data) => {
      const baseSlug = slugify(name) || `category-${Date.now()}`;
      let slug = baseSlug;
      let suffix = 2;
      while (data.categories.some((item) => item.slug === slug)) slug = `${baseSlug}-${suffix++}`;
      data.categories.push({
        id: makeId('cat'), name, slug, description: clean(req.body.description, 500),
        image: req.file ? `/uploads/${req.file.filename}` : '',
        imageUrl: isValidHttpsUrl(clean(req.body.imageUrl, 700)),
        sortOrder: data.categories.length + 1
      });
    });
    return flashRedirect(req, res, 'success', 'Collection category added.');
  } catch (error) { next(error); }
});
app.post('/admin/categories/:id/update', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    let oldImage = '';
    let found = false;
    await updateData((data) => {
      const item = data.categories.find((entry) => entry.id === req.params.id);
      if (!item) return;
      found = true;
      oldImage = item.image;
      const name = clean(req.body.name, 100);
      if (name.length >= 2) item.name = name;
      item.slug = slugify(item.name) || item.id;
      item.description = clean(req.body.description, 500);
      if (req.file) item.image = `/uploads/${req.file.filename}`;
      item.imageUrl = isValidHttpsUrl(clean(req.body.imageUrl, 700));
    });
    if (req.file && oldImage) await removeImage(oldImage);
    if (req.file && !found) await removeImage(`/uploads/${req.file.filename}`);
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Category updated.' : 'Category not found.');
  } catch (error) { next(error); }
});
app.post('/admin/categories/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = null;
    let blocked = false;
    await updateData((data) => {
      if (data.collections.some((item) => item.categoryId === req.params.id)) { blocked = true; return; }
      const index = data.categories.findIndex((item) => item.id === req.params.id);
      if (index >= 0) removed = data.categories.splice(index, 1)[0];
    });
    if (removed?.image) await removeImage(removed.image);
    return flashRedirect(req, res, blocked ? 'error' : removed ? 'success' : 'error', blocked ? 'This category still has collection entries. Reassign or delete those entries first.' : removed ? 'Category removed.' : 'Category not found.');
  } catch (error) { next(error); }
});

// Collection entries
app.post('/admin/collections', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 120);
    const categoryId = clean(req.body.categoryId, 100);
    if (title.length < 2 || !req.siteData.categories.some((item) => item.id === categoryId)) {
      if (req.file) await removeImage(`/uploads/${req.file.filename}`);
      return flashRedirect(req, res, 'error', 'Choose a valid category and enter a collection title.');
    }
    if (!req.file && !isValidHttpsUrl(clean(req.body.imageUrl, 700))) {
      return flashRedirect(req, res, 'error', 'Upload an image or provide a valid HTTPS image URL for this collection entry.');
    }
    await updateData((data) => {
      data.collections.unshift({
        id: makeId('collection'), title, categoryId,
        description: clean(req.body.description, 700),
        image: req.file ? `/uploads/${req.file.filename}` : '',
        imageUrl: isValidHttpsUrl(clean(req.body.imageUrl, 700)),
        featured: req.body.featured === 'on', published: req.body.published === 'on',
        availability: ['confirmed', 'call_to_confirm', 'unavailable'].includes(clean(req.body.availability, 40)) ? clean(req.body.availability, 40) : 'call_to_confirm',
        sortOrder: Number.isFinite(Number(req.body.sortOrder)) && String(req.body.sortOrder).trim() !== '' ? Math.max(0, Math.min(9999, Number(req.body.sortOrder))) : data.collections.length + 1,
        createdAt: new Date().toISOString()
      });
    });
    return flashRedirect(req, res, 'success', 'Collection entry added.');
  } catch (error) { next(error); }
});
app.post('/admin/collections/:id/update', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    let oldImage = '';
    let found = false;
    await updateData((data) => {
      const item = data.collections.find((entry) => entry.id === req.params.id);
      if (!item) return;
      found = true;
      oldImage = item.image;
      const title = clean(req.body.title, 120);
      const categoryId = clean(req.body.categoryId, 100);
      if (title.length >= 2) item.title = title;
      if (data.categories.some((category) => category.id === categoryId)) item.categoryId = categoryId;
      item.description = clean(req.body.description, 700);
      item.imageUrl = isValidHttpsUrl(clean(req.body.imageUrl, 700));
      if (req.file) item.image = `/uploads/${req.file.filename}`;
      item.featured = req.body.featured === 'on';
      item.published = req.body.published === 'on';
      item.availability = ['confirmed', 'call_to_confirm', 'unavailable'].includes(clean(req.body.availability, 40)) ? clean(req.body.availability, 40) : 'call_to_confirm';
      if (String(req.body.sortOrder || '').trim() !== '' && Number.isFinite(Number(req.body.sortOrder))) item.sortOrder = Math.max(0, Math.min(9999, Number(req.body.sortOrder)));
    });
    if (req.file && oldImage) await removeImage(oldImage);
    if (req.file && !found) await removeImage(`/uploads/${req.file.filename}`);
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Collection entry updated.' : 'Collection entry not found.');
  } catch (error) { next(error); }
});
app.post('/admin/collections/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = null;
    await updateData((data) => {
      const index = data.collections.findIndex((item) => item.id === req.params.id);
      if (index >= 0) removed = data.collections.splice(index, 1)[0];
    });
    if (removed?.image) await removeImage(removed.image);
    return flashRedirect(req, res, removed ? 'success' : 'error', removed ? 'Collection entry removed.' : 'Collection entry not found.');
  } catch (error) { next(error); }
});

// Gallery uploads: real store photographs are added by the administrator; no store imagery is fabricated.
app.post('/admin/gallery', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 120);
    if (!req.file || title.length < 2) {
      if (req.file) await removeImage(`/uploads/${req.file.filename}`);
      return flashRedirect(req, res, 'error', 'Enter a title and upload an image to add a gallery item.');
    }
    await updateData((data) => data.gallery.unshift({
      id: makeId('gallery'), title,
      category: clean(req.body.category, 80) || 'Craftsmanship',
      alt: clean(req.body.alt, 180) || title,
      image: `/uploads/${req.file.filename}`,
      featured: req.body.featured === 'on', published: req.body.published === 'on',
      sortOrder: Number.isFinite(Number(req.body.sortOrder)) && String(req.body.sortOrder).trim() !== '' ? Math.max(0, Math.min(9999, Number(req.body.sortOrder))) : data.gallery.length + 1,
      createdAt: new Date().toISOString()
    }));
    return flashRedirect(req, res, 'success', 'Gallery image uploaded.');
  } catch (error) { next(error); }
});
app.post('/admin/gallery/:id/update', requireAdmin, upload.single('image'), verifyCsrf, async (req, res, next) => {
  try {
    let oldImage = '';
    let found = false;
    await updateData((data) => {
      const item = data.gallery.find((entry) => entry.id === req.params.id);
      if (!item) return;
      found = true;
      oldImage = item.image;
      item.title = clean(req.body.title, 120) || item.title;
      item.category = clean(req.body.category, 80) || 'Craftsmanship';
      item.alt = clean(req.body.alt, 180) || item.title;
      item.published = req.body.published === 'on';
      item.featured = req.body.featured === 'on';
      if (String(req.body.sortOrder || '').trim() !== '' && Number.isFinite(Number(req.body.sortOrder))) item.sortOrder = Math.max(0, Math.min(9999, Number(req.body.sortOrder)));
      if (req.file) item.image = `/uploads/${req.file.filename}`;
    });
    if (req.file && oldImage) await removeImage(oldImage);
    if (req.file && !found) await removeImage(`/uploads/${req.file.filename}`);
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Gallery entry updated.' : 'Gallery entry not found.');
  } catch (error) { next(error); }
});
app.post('/admin/gallery/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = null;
    await updateData((data) => {
      const index = data.gallery.findIndex((item) => item.id === req.params.id);
      if (index >= 0) removed = data.gallery.splice(index, 1)[0];
    });
    if (removed?.image) await removeImage(removed.image);
    return flashRedirect(req, res, removed ? 'success' : 'error', removed ? 'Gallery image deleted.' : 'Gallery image not found.');
  } catch (error) { next(error); }
});

// Promotional announcements
app.post('/admin/announcements', requireAdmin, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 120);
    if (title.length < 2) return flashRedirect(req, res, 'error', 'Announcement title is required.');
    await updateData((data) => data.announcements.unshift({
      id: makeId('announcement'), title, body: clean(req.body.body, 500),
      active: req.body.active === 'on', createdAt: new Date().toISOString()
    }));
    return flashRedirect(req, res, 'success', 'Announcement saved.');
  } catch (error) { next(error); }
});
app.post('/admin/announcements/:id/update', requireAdmin, async (req, res, next) => {
  try {
    const title = clean(req.body.title, 120);
    if (title.length < 2) return flashRedirect(req, res, 'error', 'Announcement title is required.');
    let found = false;
    await updateData((data) => {
      const item = data.announcements.find((entry) => entry.id === req.params.id);
      if (!item) return;
      item.title = title;
      item.body = clean(req.body.body, 500);
      item.active = req.body.active === 'on';
      found = true;
    });
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Announcement updated.' : 'Announcement not found.');
  } catch (error) { next(error); }
});
app.post('/admin/announcements/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    let found = false;
    await updateData((data) => {
      const item = data.announcements.find((entry) => entry.id === req.params.id);
      if (item) { item.active = !item.active; found = true; }
    });
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Announcement status changed.' : 'Announcement not found.');
  } catch (error) { next(error); }
});
app.post('/admin/announcements/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = false;
    await updateData((data) => {
      const index = data.announcements.findIndex((entry) => entry.id === req.params.id);
      if (index >= 0) { data.announcements.splice(index, 1); removed = true; }
    });
    return flashRedirect(req, res, removed ? 'success' : 'error', removed ? 'Announcement removed.' : 'Announcement not found.');
  } catch (error) { next(error); }
});

// Testimonials are displayed only after an administrator explicitly publishes them.
app.post('/admin/testimonials', requireAdmin, async (req, res, next) => {
  try {
    const quote = clean(req.body.quote, 600);
    const customerName = clean(req.body.customerName, 100);
    if (quote.length < 10 || customerName.length < 2) return flashRedirect(req, res, 'error', 'Enter a genuine customer quote and the name or approved attribution to display.');
    await updateData((data) => data.testimonials.unshift({
      id: makeId('testimonial'), quote, customerName,
      context: clean(req.body.context, 120), published: req.body.published === 'on' && req.body.permissionConfirmed === 'on',
      permissionConfirmed: req.body.permissionConfirmed === 'on', createdAt: new Date().toISOString()
    }));
    return flashRedirect(req, res, 'success', 'Testimonial saved. Confirm the customer has permitted its publication.');
  } catch (error) { next(error); }
});
app.post('/admin/testimonials/:id/update', requireAdmin, async (req, res, next) => {
  try {
    const quote = clean(req.body.quote, 600);
    const customerName = clean(req.body.customerName, 100);
    if (quote.length < 10 || customerName.length < 2) return flashRedirect(req, res, 'error', 'Enter a customer attribution and quote of at least 10 characters.');
    let found = false;
    await updateData((data) => {
      const item = data.testimonials.find((entry) => entry.id === req.params.id);
      if (!item) return;
      item.quote = quote;
      item.customerName = customerName;
      item.context = clean(req.body.context, 120);
      item.permissionConfirmed = req.body.permissionConfirmed === 'on';
      item.published = req.body.published === 'on' && item.permissionConfirmed;
      found = true;
    });
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Testimonial updated.' : 'Testimonial not found.');
  } catch (error) { next(error); }
});
app.post('/admin/testimonials/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    let message = 'Testimonial not found.';
    await updateData((data) => {
      const item = data.testimonials.find((entry) => entry.id === req.params.id);
      if (!item) return;
      if (!item.permissionConfirmed) { message = 'Publication was not changed. Confirm permission before publishing a customer testimonial.'; return; }
      item.published = !item.published;
      message = 'Testimonial publication status changed.';
    });
    return flashRedirect(req, res, message.includes('not found') || message.startsWith('Publication') ? 'error' : 'success', message);
  } catch (error) { next(error); }
});
app.post('/admin/testimonials/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = false;
    await updateData((data) => {
      const index = data.testimonials.findIndex((entry) => entry.id === req.params.id);
      if (index >= 0) { data.testimonials.splice(index, 1); removed = true; }
    });
    return flashRedirect(req, res, removed ? 'success' : 'error', removed ? 'Testimonial removed.' : 'Testimonial not found.');
  } catch (error) { next(error); }
});

// Enquiry inbox
app.post('/admin/enquiries/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    let found = false;
    await updateData((data) => {
      const item = data.enquiries.find((entry) => entry.id === req.params.id);
      if (item) { item.read = !item.read; item.status = item.read ? 'reviewed' : 'new'; found = true; }
    });
    return flashRedirect(req, res, found ? 'success' : 'error', found ? 'Enquiry status updated.' : 'Enquiry not found.');
  } catch (error) { next(error); }
});
app.post('/admin/enquiries/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    let removed = false;
    await updateData((data) => {
      const index = data.enquiries.findIndex((entry) => entry.id === req.params.id);
      if (index >= 0) { data.enquiries.splice(index, 1); removed = true; }
    });
    return flashRedirect(req, res, removed ? 'success' : 'error', removed ? 'Enquiry deleted.' : 'Enquiry not found.');
  } catch (error) { next(error); }
});

// Appointment management and schedule configuration.
app.post('/admin/appointments/settings', requireAdmin, async (req, res, next) => {
  try {
    const weeklyHours = {};
    for (const day of DAY_KEYS) weeklyHours[day] = {
      closed: req.body[`${day}Closed`] === 'on',
      open: clean(req.body[`${day}Open`], 5), close: clean(req.body[`${day}Close`], 5)
    };
    const closedDates = clean(req.body.closedDatesText, 12000).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (const date of closedDates) if (!operations.dateKeyValid(date)) throw new Error(`Invalid closed date: ${date}. Use YYYY-MM-DD, one date per line.`);
    const exceptions = parseExceptionLines(req.body.exceptionsText);
    await operations.updateAppointmentSettings({
      weeklyHours, slotMinutes: clean(req.body.slotMinutes, 3), maxAppointmentsPerSlot: clean(req.body.maxAppointmentsPerSlot, 2),
      breakStart: clean(req.body.breakStart, 5), breakEnd: clean(req.body.breakEnd, 5),
      minAdvanceHours: clean(req.body.minAdvanceHours, 3), maxAdvanceDays: clean(req.body.maxAdvanceDays, 3),
      closedDates, exceptions
    });
    return flashRedirect(req, res, 'success', 'Appointment availability settings saved.', '/admin/dashboard#appointments');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Appointment settings could not be saved.', '/admin/dashboard#appointments');
  }
});

app.post('/admin/appointments/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const result = await operations.updateAppointmentStatus(req.params.id, clean(req.body.status, 40), req.session.adminUsername, clean(req.body.internalNotes, 1500));
    if (result.previousStatus !== result.appointment.status && ['confirmed', 'rescheduled', 'cancelled', 'rejected'].includes(result.appointment.status)) {
      const label = APPOINTMENT_STATUS_OPTIONS[result.appointment.status];
      await notifyCustomerAppointment(result.appointment, label).catch((error) => console.warn('Appointment customer notification failed:', error.message));
    }
    return flashRedirect(req, res, 'success', `Appointment ${result.appointment.reference} updated.`, '/admin/dashboard#appointments');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Appointment status could not be updated.', '/admin/dashboard#appointments');
  }
});

app.post('/admin/appointments/:id/reschedule', requireAdmin, async (req, res, next) => {
  try {
    const date = clean(req.body.date, 10); const time = clean(req.body.time, 5); const note = clean(req.body.note, 500);
    const result = await operations.rescheduleAppointment(req.params.id, date, time, req.session.adminUsername, note);
    await notifyCustomerAppointment(result.appointment, 'Rescheduled').catch((error) => console.warn('Appointment reschedule notification failed:', error.message));
    return flashRedirect(req, res, 'success', `Appointment ${result.appointment.reference} rescheduled to ${date} at ${time}.`, '/admin/dashboard#appointments');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Appointment could not be rescheduled.', '/admin/dashboard#appointments');
  }
});

// Tailoring order management.
app.post('/admin/orders/create', requireAdmin, async (req, res, next) => {
  try {
    const appointmentId = clean(req.body.appointmentId, 100);
    const enquiryId = clean(req.body.enquiryId, 100);
    const [appointmentData, currentData] = await Promise.all([operations.getAppointmentsData(), getData()]);
    const appointment = appointmentId ? appointmentData.appointments.find((item) => item.id === appointmentId) : null;
    const enquiry = enquiryId ? currentData.enquiries.find((item) => item.id === enquiryId) : null;
    if (appointmentId && !appointment) throw new Error('The selected appointment no longer exists. Refresh the dashboard and try again.');
    if (enquiryId && !enquiry) throw new Error('The selected enquiry no longer exists. Refresh the dashboard and try again.');
    const orderDate = clean(req.body.orderDate, 10) || todayDateKey();
    const expectedCollectionDate = clean(req.body.expectedCollectionDate, 10);
    if (!operations.dateKeyValid(orderDate)) throw new Error('Enter a valid order date.');
    if (expectedCollectionDate && (!operations.dateKeyValid(expectedCollectionDate) || expectedCollectionDate < todayDateKey())) throw new Error('Expected collection date must be today or a future date.');
    const asArray = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
    const types = asArray(req.body.garmentType);
    const descriptions = asArray(req.body.garmentDescription);
    const quantities = asArray(req.body.quantity);
    const fabrics = asArray(req.body.fabricLabel);
    const instructions = asArray(req.body.instructions);
    const garments = types.map((type, index) => ({ type: clean(type, 60), description: clean(descriptions[index] || '', 220), quantity: clean(quantities[index] || '1', 3), fabricLabel: clean(fabrics[index] || '', 180), instructions: clean(instructions[index] || '', 1200) }));
    const order = await operations.createOrder({
      customerName: clean(req.body.customerName || appointment?.name || enquiry?.name, 100),
      phone: clean(req.body.phone || appointment?.phone || enquiry?.phone, 40),
      email: clean(req.body.email || appointment?.email || enquiry?.email, 160),
      orderDate, expectedCollectionDate, notes: clean(req.body.notes, 2000), appointmentId, enquiryId, garments
    }, req.session.adminUsername);
    return flashRedirect(req, res, 'success', `Tailoring order ${order.reference} created.`, '/admin/dashboard#orders');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Order could not be created.', '/admin/dashboard#orders');
  }
});

app.post('/admin/orders/:id/update', requireAdmin, async (req, res, next) => {
  try {
    const order = await operations.updateOrder(req.params.id, {
      expectedCollectionDate: clean(req.body.expectedCollectionDate, 10), notes: clean(req.body.notes, 2000)
    }, req.session.adminUsername);
    return flashRedirect(req, res, 'success', `Order ${order.reference} updated.`, '/admin/dashboard#orders');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Order could not be updated.', '/admin/dashboard#orders');
  }
});

app.post('/admin/orders/:id/garments/:garmentId/status', requireAdmin, async (req, res, next) => {
  try {
    const result = await operations.updateGarmentStatus(req.params.id, req.params.garmentId, clean(req.body.status, 40), req.session.adminUsername, clean(req.body.note, 800));
    return flashRedirect(req, res, 'success', `${result.order.reference}: ${result.garment.type} is now ${GARMENT_STATUS_OPTIONS[result.garment.status]}.`, '/admin/dashboard#orders');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Garment status could not be updated.', '/admin/dashboard#orders');
  }
});

app.post('/admin/orders/:id/cancel', requireAdmin, async (req, res, next) => {
  try {
    const order = await operations.cancelOrder(req.params.id, req.session.adminUsername, clean(req.body.note, 800));
    return flashRedirect(req, res, 'success', `Order ${order.reference} cancelled.`, '/admin/dashboard#orders');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Order could not be cancelled.', '/admin/dashboard#orders');
  }
});

app.post('/admin/orders/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const archived = req.body.archived === 'yes';
    const order = await operations.archiveOrder(req.params.id, archived, req.session.adminUsername);
    return flashRedirect(req, res, 'success', `Order ${order.reference} ${archived ? 'archived' : 'restored'}.`, '/admin/dashboard#orders');
  } catch (error) {
    return flashRedirect(req, res, 'error', error.message || 'Order archive state could not be changed.', '/admin/dashboard#orders');
  }
});

app.get('/admin/orders/:id/print', requireAdmin, async (req, res, next) => {
  try {
    const data = await operations.getOrdersData();
    const order = data.orders.find((item) => item.id === req.params.id);
    if (!order) return res.status(404).render('error', { settings: req.siteData.settings, pageTitle: 'Order not found', statusCode: 404, message: 'The requested tailoring order could not be found.' });
    return res.render('order-job-card', { pageTitle: `Job card ${order.reference}`, settings: req.siteData.settings, order, csrfToken: res.locals.csrfToken, garmentStatusLabels: GARMENT_STATUS_OPTIONS, orderStatusLabel: orderStatusLabel(order) });
  } catch (error) { next(error); }
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return res.status(400).type('text/plain').send('Invalid host header.');
  const configuredSiteUrl = isValidHttpsUrl(process.env.SITE_URL || '');
  const base = configuredSiteUrl ? new URL(configuredSiteUrl).origin : `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
  const routes = ['', '/about', '/collections', '/tailoring', '/suiting', '/gallery', '/contact'];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((route) => `<url><loc>${base}${route}</loc></url>`).join('')}</urlset>`);
});

app.use((req, res) => {
  res.status(404).render('error', {
    settings: req.siteData?.settings || res.locals.settings,
    pageTitle: 'Page not found', statusCode: 404,
    message: 'The page you were looking for could not be found. Try the main navigation or return to the homepage.'
  });
});
app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Image uploads must be 5 MB or smaller.' : 'The image upload could not be processed.';
    if (req.session) req.session.flash = { kind: 'error', message };
    return res.redirect(req.session?.adminUsername ? '/admin/dashboard' : '/contact');
  }
  if (error.message && /Upload a JPG/.test(error.message)) {
    if (req.session) req.session.flash = { kind: 'error', message: error.message };
    return res.redirect('/admin/dashboard');
  }
  console.error(`[${new Date().toISOString()}] ${error.stack || error}`);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ available: false, reason: 'The availability service could not complete the request. Please retry or contact the store.' });
  res.status(500).render('error', {
    settings: req.siteData?.settings || res.locals.settings,
    pageTitle: 'Something went wrong', statusCode: 500,
    message: IS_PRODUCTION ? 'The request could not be completed. Please try again shortly.' : `The request could not be completed: ${error.message}`
  });
});

let reminderCheckRunning = false;
async function checkAppointmentReminders() {
  if (reminderCheckRunning || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  reminderCheckRunning = true;
  try {
    const data = await operations.getAppointmentsData();
    const now = Date.now();
    for (const appointment of data.appointments) {
      if (!appointment.email || appointment.reminderSentAt || !['confirmed', 'rescheduled'].includes(appointment.status)) continue;
      const appointmentTime = operations.dateTimeInIndia(appointment.date, appointment.time).getTime();
      const remaining = appointmentTime - now;
      if (remaining <= 0 || remaining > 24 * 60 * 60 * 1000) continue;
      const result = await sendEmail({
        to: appointment.email,
        subject: `Reminder: appointment ${appointment.reference}`,
        text: `${appointmentEmailText(appointment, 'Confirmed')}\n\nThis is a reminder for your upcoming store appointment. Contact the store if you need to discuss the timing.`
      });
      if (result.sent) await operations.setAppointmentReminderSent(appointment.id);
    }
  } catch (error) { console.warn('Appointment reminder check failed:', error.message); }
  finally { reminderCheckRunning = false; }
}
setInterval(checkAppointmentReminders, 15 * 60 * 1000).unref?.();

async function ensureProductionAdminBootstrap() {
  const existing = await getAdmin();
  if (existing) return;
  if (!IS_PRODUCTION) return;

  const username = (process.env.INITIAL_ADMIN_USERNAME || '').trim();
  const passwordHash = (process.env.INITIAL_ADMIN_BCRYPT_HASH || '').trim();
  const validHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash);
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username) || !validHash) {
    throw new Error('No administrator account exists. Generate INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_BCRYPT_HASH locally with npm run admin:bootstrap-hash, configure them privately in the host environment, then redeploy.');
  }
  await require('./lib/store').saveAdmin({ username, passwordHash, updatedAt: new Date().toISOString() });
  console.log('Initial administrator account created. Keep INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_BCRYPT_HASH configured on ephemeral hosts so the account can be recreated after a filesystem reset; on persistent storage, remove them after verifying login.');
  delete process.env.INITIAL_ADMIN_USERNAME;
  delete process.env.INITIAL_ADMIN_BCRYPT_HASH;
}

Promise.all([ensureDataFiles(), operations.ensureOperationsFiles(), fs.mkdir(UPLOAD_DIR, { recursive: true })])
  .then(ensureProductionAdminBootstrap)
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Premium menswear website listening on port ${PORT}`);
      console.log(`Preview gate: ${PREVIEW_GATE_ENABLED ? 'enabled' : 'disabled (local or explicitly approved public mode)'}`);
    });
  }).catch((error) => {
  console.error('Could not initialize website data:', error);
  process.exit(1);
});
